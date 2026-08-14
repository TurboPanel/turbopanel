/**
 * Client routes for managed-database → compose-service bindings.
 *
 * Authorization is through the target service (and principal org via managed);
 * no new authz entity kind.
 */

import type { Context } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import {
  binding,
  managed,
  principal,
  service,
  task,
} from '../../lib/db/schema.ts'
import { isNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { getCommandQueue } from '../../lib/commands/queue.ts'
import { compatLogWarn } from '../../log-compat.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import { enqueueManagedIngressReconcile } from '../managed/ingress-desired.ts'
import {
  loadServicePlacementServerId,
  memberServerIdsForManaged,
} from './resolve-endpoint.ts'
import {
  materializeBinding,
  type MaterializeBindingError,
} from './materialize.ts'
import {
  bindingMaterializeHttpPayload,
  checkBindingDatabaseTarget,
  detectBindingCreateConflicts,
  detectBindingUpdateConflicts,
  isBindableDatabasePrincipal,
  mapBindingUniqueViolation,
  parseBindingKeyPrefix,
  parseBindingsListFilter,
  parseEmitEngineDefaults,
  resolveBindingPrincipalEngine,
  resolveBindingPrincipalManagedId,
  resolvePatchBindingFields,
  serializeBindingRow,
  bindingDatabaseTargetHttpStatus,
  type BindingRow,
} from './routes-helpers.ts'

const BINDING_SELECT = {
  id: binding.id,
  principalId: binding.principalId,
  serviceId: binding.serviceId,
  databaseName: binding.databaseName,
  keyPrefix: binding.keyPrefix,
  emitEngineDefaults: binding.emitEngineDefaults,
  createdAt: binding.createdAt,
  updatedAt: binding.updatedAt,
}

/**
 * After binding create/update/delete, reconcile ProxySQL on the consumer
 * placement server and every managed cluster member (backend + frontend users).
 */
async function enqueueIngressForBindingChange(
  c: Context<AppEnv>,
  db: Db,
  params: Readonly<{
    serviceId: string
    managedId: string
    actorId: string
  }>,
): Promise<void> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const commandQueue = getCommandQueue(c)
  if (
    !secretsConfig ||
    !dataEncryptionSecrets ||
    !commandQueue ||
    isNoopCommandQueue(commandQueue)
  ) {
    return
  }

  const serverIds = new Set<string>()
  const placement = await loadServicePlacementServerId(db, params.serviceId)
  if (placement) serverIds.add(placement)
  for (const memberServerId of await memberServerIdsForManaged(
    db,
    params.managedId,
  )) {
    serverIds.add(memberServerId)
  }
  const consumerTasks = await db
    .select({ serverId: task.serverId })
    .from(task)
    .where(eq(task.serviceId, params.serviceId))
  for (const row of consumerTasks) {
    serverIds.add(row.serverId)
  }

  for (const serverId of serverIds) {
    try {
      await enqueueManagedIngressReconcile(db, commandQueue, {
        serverId,
        actorType: 'user',
        actorId: params.actorId,
        secretsConfig,
        dataEncryptionSecrets,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      compatLogWarn(
        'bindings',
        `managed.ingress.reconcile after binding change failed for ${serverId}: ${message}`,
      )
    }
  }
}

/** Shared 404 guard: the entity must resolve to the caller's organization. */
async function assertEntityInOrgOr404(
  c: Context<AppEnv>,
  db: Db,
  entityType: string,
  entityId: string,
  organizationId: string,
): Promise<Response | null> {
  const entityOrgId = await resolveEntityOrganizationId(db, entityType, entityId)
  if (!entityOrgId || entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return null
}

/** Service guard for binding create: org match + manage + not system-owned. */
async function assertServiceCreatable(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<Response | null> {
  const notFound = await assertEntityInOrgOr404(c, db, 'service', serviceId, organizationId)
  if (notFound) return notFound
  const manageDenied = await assertCanManageOr403(c, 'service', serviceId)
  if (manageDenied) return manageDenied
  return assertNotSystemOwnedOr403(c, 'service', serviceId)
}

/** Service guard for binding update/delete: org match + manage + not system-owned. */
async function assertServiceMutable(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<Response | null> {
  const notFound = await assertEntityInOrgOr404(c, db, 'service', serviceId, organizationId)
  if (notFound) return notFound
  const denied = await assertCanOr403(c, 'organization:manage', 'service', serviceId)
  if (denied) return denied
  return assertNotSystemOwnedOr403(c, 'service', serviceId)
}

/** Maps a `materializeBinding` failure onto the wire error shape. */
function materializeErrorResponse(
  c: Context<AppEnv>,
  materializeResult: MaterializeBindingError,
): Response {
  const mapped = bindingMaterializeHttpPayload(materializeResult)
  return c.json(mapped.body, mapped.status)
}

async function selectBindingsByServiceId(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<Response | BindingRow[]> {
  const notFound = await assertEntityInOrgOr404(c, db, 'service', serviceId, organizationId)
  if (notFound) return notFound
  const denied = await assertCanReadOr403(c, 'service', serviceId)
  if (denied) return denied
  return db
    .select(BINDING_SELECT)
    .from(binding)
    .where(eq(binding.serviceId, serviceId))
    .orderBy(binding.createdAt)
}

/** Managed-cluster list: principal → managed.environment_id (not consumer services). */
async function selectBindingsByManagedEnvironmentId(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  managedEnvironmentId: string,
): Promise<Response | BindingRow[]> {
  const notFound = await assertEntityInOrgOr404(
    c,
    db,
    'environment',
    managedEnvironmentId,
    organizationId,
  )
  if (notFound) return notFound
  const denied = await assertCanReadOr403(c, 'environment', managedEnvironmentId)
  if (denied) return denied

  const [managedRow] = await db
    .select({ id: managed.id })
    .from(managed)
    .where(eq(managed.environmentId, managedEnvironmentId))
    .limit(1)
  if (!managedRow) return []

  const principalRows = await db
    .select({ id: principal.id })
    .from(principal)
    .where(eq(principal.managedId, managedRow.id))
  const principalIds = principalRows.map((r) => r.id)
  if (principalIds.length === 0) return []

  return db
    .select(BINDING_SELECT)
    .from(binding)
    .where(inArray(binding.principalId, principalIds))
    .orderBy(binding.createdAt)
}

/** Consuming-service environment: expand to services in that environment. */
async function selectBindingsByConsumerEnvironmentId(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  environmentId: string,
): Promise<Response | BindingRow[]> {
  const notFound = await assertEntityInOrgOr404(c, db, 'environment', environmentId, organizationId)
  if (notFound) return notFound
  const denied = await assertCanReadOr403(c, 'environment', environmentId)
  if (denied) return denied

  const serviceRows = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = serviceRows.map((r) => r.id)
  if (serviceIds.length === 0) return []

  return db
    .select(BINDING_SELECT)
    .from(binding)
    .where(inArray(binding.serviceId, serviceIds))
    .orderBy(binding.createdAt)
}

type CreateBindingInput = {
  principalId: string
  serviceId: string
  databaseName: string
  keyPrefix: string
  emitEngineDefaults: boolean
}

async function parseCreateBindingInput(
  c: Context<AppEnv>,
): Promise<CreateBindingInput | Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body

  const principalId = requireStringField(c, body, 'principalId')
  if (principalId instanceof Response) return principalId
  const serviceId = requireStringField(c, body, 'serviceId')
  if (serviceId instanceof Response) return serviceId
  const databaseName = requireStringField(c, body, 'databaseName')
  if (databaseName instanceof Response) return databaseName

  const prefixParsed = parseBindingKeyPrefix(body.keyPrefix)
  if (!prefixParsed.ok) return c.json({ error: prefixParsed.error }, 400)
  const emitParsed = parseEmitEngineDefaults(body.emitEngineDefaults)
  if (!emitParsed.ok) return c.json({ error: emitParsed.error }, 400)

  return {
    principalId,
    serviceId,
    databaseName,
    keyPrefix: prefixParsed.prefix,
    emitEngineDefaults: emitParsed.value,
  }
}

/** Load + validate the source principal for a new binding (database principal, not root/replication). */
async function loadBindablePrincipal(
  c: Context<AppEnv>,
  db: Db,
  principalId: string,
): Promise<{ id: string; managedId: string } | Response> {
  const [principalRow] = await db
    .select({
      id: principal.id,
      kind: principal.kind,
      managedId: principal.managedId,
      metadata: principal.metadata,
    })
    .from(principal)
    .where(eq(principal.id, principalId))
    .limit(1)
  if (
    !isBindableDatabasePrincipal({
      kind: principalRow?.kind,
      managedId: principalRow?.managedId,
      metadata: principalRow?.metadata,
    })
  ) {
    return c.json({ error: 'Not found' }, 404)
  }
  return { id: principalRow!.id, managedId: principalRow!.managedId! }
}

/** Load the managed cluster row for a binding and confirm it belongs to the caller's org. */
async function loadManagedForBindingOrg(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  managedId: string,
) {
  const [managedRow] = await db
    .select({
      id: managed.id,
      engine: managed.engine,
      options: managed.options,
    })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  if (!managedRow) return c.json({ error: 'Not found' }, 404)

  const notFound = await assertEntityInOrgOr404(c, db, 'managed', managedRow.id, organizationId)
  if (notFound) return notFound
  return managedRow
}

/** Validate the engine supports bindings and the target database name/existence. */
function validateBindingDatabaseTarget(
  c: Context<AppEnv>,
  managedRow: { engine: string | null; options: unknown },
  databaseName: string,
): Response | null {
  const error = checkBindingDatabaseTarget(managedRow, databaseName)
  if (!error) return null
  return c.json({ error }, bindingDatabaseTargetHttpStatus(error))
}

async function assertBindingCreateConflicts(
  db: Db,
  params: Readonly<{
    serviceId: string
    keyPrefix: string
    emitEngineDefaults: boolean
    engineCode: string
  }>,
  c: Context<AppEnv>,
): Promise<Response | null> {
  const conflict = await detectBindingCreateConflicts(db, params)
  if (!conflict) return null
  if ('key' in conflict) {
    return c.json(conflict, 409)
  }
  return c.json(conflict, 409)
}

async function insertAndMaterializeBinding(
  c: Context<AppEnv>,
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: Readonly<{
    principalId: string
    serviceId: string
    databaseName: string
    keyPrefix: string
    emitEngineDefaults: boolean
    managedId: string
    actorId: string
  }>,
): Promise<Response> {
  try {
    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(binding)
        .values({
          principalId: params.principalId,
          serviceId: params.serviceId,
          databaseName: params.databaseName,
          keyPrefix: params.keyPrefix,
          emitEngineDefaults: params.emitEngineDefaults,
        })
        .returning({ id: binding.id })
      return inserted.id
    })

    const materializeResult = await materializeBinding(db, dataEncryptionSecrets, id)
    if (!('ok' in materializeResult)) {
      await db.delete(binding).where(eq(binding.id, id))
      if (materializeResult.kind === 'binding_password_unavailable') {
        return c.json({ error: materializeResult.kind }, 422)
      }
      return materializeErrorResponse(c, materializeResult)
    }

    await enqueueIngressForBindingChange(c, db, {
      serviceId: params.serviceId,
      managedId: params.managedId,
      actorId: params.actorId,
    })

    return c.json({ ok: true as const, id })
  } catch (err) {
    const mapped = mapBindingUniqueViolation(err)
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status)
    }
    throw err
  }
}

function parsePatchBindingFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  row: Readonly<{ keyPrefix: string; emitEngineDefaults: boolean }>,
): { keyPrefix: string; emitEngineDefaults: boolean } | Response {
  const parsed = resolvePatchBindingFields(body, row)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  return {
    keyPrefix: parsed.keyPrefix,
    emitEngineDefaults: parsed.emitEngineDefaults,
  }
}

async function assertBindingUpdateConflicts(
  db: Db,
  params: Readonly<{
    id: string
    serviceId: string
    previousKeyPrefix: string
    previousEmitEngineDefaults: boolean
    nextKeyPrefix: string
    nextEmitEngineDefaults: boolean
    engineCode: string
  }>,
  c: Context<AppEnv>,
): Promise<Response | null> {
  const conflict = await detectBindingUpdateConflicts(db, params)
  if (!conflict) return null
  return c.json(conflict, 409)
}

async function loadBindingRowForMutation(
  c: Context<AppEnv>,
  db: Db,
  id: string,
): Promise<BindingRow | Response> {
  const [row] = await db
    .select(BINDING_SELECT)
    .from(binding)
    .where(eq(binding.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return row
}

export function registerBindingRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for binding routes')
  }
  const secrets = opts.secrets

  router.use('/bindings', createSessionMiddleware(secrets))
  router.use('/bindings/:id', createSessionMiddleware(secrets))

  router.get('/bindings', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serviceId = c.req.query('serviceId')
    const environmentId = c.req.query('environmentId')
    const managedEnvironmentId = c.req.query('managedEnvironmentId')
    const filterResult = parseBindingsListFilter({
      serviceId,
      environmentId,
      managedEnvironmentId,
    })
    if (!filterResult.ok) {
      return c.json({ error: filterResult.error }, filterResult.status)
    }

    let rowsResult: Response | BindingRow[]
    if (filterResult.filter.kind === 'service') {
      rowsResult = await selectBindingsByServiceId(
        c,
        db,
        organizationId,
        filterResult.filter.serviceId,
      )
    } else if (filterResult.filter.kind === 'managedEnvironment') {
      rowsResult = await selectBindingsByManagedEnvironmentId(
        c,
        db,
        organizationId,
        filterResult.filter.managedEnvironmentId,
      )
    } else {
      rowsResult = await selectBindingsByConsumerEnvironmentId(
        c,
        db,
        organizationId,
        filterResult.filter.environmentId,
      )
    }
    if (rowsResult instanceof Response) return rowsResult

    const serialized = []
    for (const row of rowsResult) {
      serialized.push(await serializeBindingRow(db, row))
    }
    return c.json({ bindings: serialized })
  })

  router.post('/bindings', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const input = await parseCreateBindingInput(c)
    if (input instanceof Response) return input

    const serviceDenied = await assertServiceCreatable(c, db, organizationId, input.serviceId)
    if (serviceDenied) return serviceDenied

    const principalResult = await loadBindablePrincipal(c, db, input.principalId)
    if (principalResult instanceof Response) return principalResult

    const managedResult = await loadManagedForBindingOrg(
      c,
      db,
      organizationId,
      principalResult.managedId,
    )
    if (managedResult instanceof Response) return managedResult

    const targetDenied = validateBindingDatabaseTarget(c, managedResult, input.databaseName)
    if (targetDenied) return targetDenied

    const conflictDenied = await assertBindingCreateConflicts(
      db,
      {
        serviceId: input.serviceId,
        keyPrefix: input.keyPrefix,
        emitEngineDefaults: input.emitEngineDefaults,
        engineCode: managedResult.engine,
      },
      c,
    )
    if (conflictDenied) return conflictDenied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    return insertAndMaterializeBinding(c, db, dataEncryptionSecrets, {
      principalId: input.principalId,
      serviceId: input.serviceId,
      databaseName: input.databaseName,
      keyPrefix: input.keyPrefix,
      emitEngineDefaults: input.emitEngineDefaults,
      managedId: managedResult.id,
      actorId: session.userId,
    })
  })

  router.patch('/bindings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rowResult = await loadBindingRowForMutation(c, db, id)
    if (rowResult instanceof Response) return rowResult
    const row = rowResult

    const serviceDenied = await assertServiceMutable(c, db, organizationId, row.serviceId)
    if (serviceDenied) return serviceDenied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fieldsResult = parsePatchBindingFields(c, body, row)
    if (fieldsResult instanceof Response) return fieldsResult
    const { keyPrefix: nextPrefix, emitEngineDefaults: nextEmit } = fieldsResult

    const { managedId, engineCode } = await resolveBindingPrincipalEngine(db, row.principalId)

    const conflictDenied = await assertBindingUpdateConflicts(
      db,
      {
        id,
        serviceId: row.serviceId,
        previousKeyPrefix: row.keyPrefix,
        previousEmitEngineDefaults: row.emitEngineDefaults,
        nextKeyPrefix: nextPrefix,
        nextEmitEngineDefaults: nextEmit,
        engineCode,
      },
      c,
    )
    if (conflictDenied) return conflictDenied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    await db
      .update(binding)
      .set({
        keyPrefix: nextPrefix,
        emitEngineDefaults: nextEmit,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(binding.id, id))

    const materializeResult = await materializeBinding(db, dataEncryptionSecrets, id)
    if (!('ok' in materializeResult)) {
      return materializeErrorResponse(c, materializeResult)
    }

    if (managedId) {
      await enqueueIngressForBindingChange(c, db, {
        serviceId: row.serviceId,
        managedId,
        actorId: session.userId,
      })
    }

    return c.json({ ok: true as const })
  })

  router.delete('/bindings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const [row] = await db
      .select({
        id: binding.id,
        serviceId: binding.serviceId,
        principalId: binding.principalId,
      })
      .from(binding)
      .where(eq(binding.id, id))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const serviceDenied = await assertServiceMutable(c, db, organizationId, row.serviceId)
    if (serviceDenied) return serviceDenied

    const managedId = await resolveBindingPrincipalManagedId(db, row.principalId)

    await db.delete(binding).where(eq(binding.id, id))

    if (managedId) {
      await enqueueIngressForBindingChange(c, db, {
        serviceId: row.serviceId,
        managedId,
        actorId: session.userId,
      })
    }

    return c.json({ ok: true as const })
  })
}
