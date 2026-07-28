import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import { getDb } from '../../db.ts'
import type { ManagedApplyCommandPayload } from '../../lib/commands/schemas.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  container,
  environment,
  managed,
  organization,
  principal,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import {
  clampManagedResources,
  type ManagedSettings,
} from '../../lib/managed/settings.ts'
import { parseResourceLimits } from '../../lib/resource-limits.ts'
import {
  createManagedPrincipal,
  listManagedPrincipals,
  rotatePrincipalPassword,
  USERNAME_RE,
} from '../principals/store.ts'
import {
  assertDispatchInfrastructure,
} from '../servers/command-dispatch.ts'
import {
  BadRequestError,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
  assertCanManageOr403,
  requireStringField,
} from '../shared.ts'
import {
  authorizeManagedRequest,
  assertManagedNotBusy,
  assertTargetServerOnline,
  loadManagedContext,
  requireManagedCreateServerId,
  resolveManagedTargetServerId,
  type ManagedContext,
} from './context.ts'
import {
  buildManagedApplyPayload,
  enqueueManagedApply,
  enqueueManagedDestroy,
  enqueueManagedLifecycle,
  isPrepareError,
  mapManagedApplyPrepareError,
  preflightManagedApplyInfrastructure,
  type ManagedApplyPrepareError,
} from './apply-prepare.ts'
import {
  buildManagedBackupCreatePayload,
  buildManagedBackupDeletePayload,
  buildManagedRestorePayload,
  enqueueManagedBackup,
  enqueueManagedRestore,
  isManagedBackupApiError,
  mapManagedBackupApiError,
  resolveBackupDatabase,
} from './backups.ts'
import { fetchManagedLogs, parseLogsTailQuery } from './logs.ts'
import {
  parseManagedRowOptions,
  writeManagedRowOptions,
  type ManagedBackupRecord,
  type ManagedRowOptions,
} from './options.ts'
import {
  buildConnectionPayload,
  parseManagedResidual,
  serializeManagedRow,
} from './serialize.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function managedSessionPaths(): string[] {
  return [
    '/environments/:id/managed',
    '/environments/:id/managed/apply',
    '/environments/:id/managed/lifecycle',
    '/environments/:id/managed/root-password',
    '/environments/:id/managed/users',
    '/environments/:id/managed/users/:principalId',
    '/environments/:id/managed/databases',
    '/environments/:id/managed/databases/:databaseName',
    '/environments/:id/managed/status',
    '/environments/:id/managed/logs',
    '/environments/:id/managed/backups',
    '/environments/:id/managed/backups/:backupId',
    '/environments/:id/managed/backups/:backupId/restore',
    '/organizations/:id/managed',
  ]
}

async function findManagedForEnvironment(db: NonNullable<ReturnType<typeof getDb>>, environmentId: string) {
  const [row] = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      displayName: managed.displayName,
      engine: managed.engine,
      status: managed.status,
      metadata: managed.metadata,
      options: managed.options,
      serverId: managed.serverId,
      createdAt: managed.createdAt,
      updatedAt: managed.updatedAt,
    })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  return row ?? null
}

async function loadResourceLimits(
  db: NonNullable<ReturnType<typeof getDb>>,
  organizationId: string,
  serverId: string,
) {
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const [serverRow] = await db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const orgLimits = parseResourceLimits(
    isPlainObject(orgRow?.options) ? orgRow.options.resourceLimits : null,
  ) ?? {}
  const serverLimits = parseResourceLimits(
    isPlainObject(serverRow?.options) ? serverRow.options.resourceLimits : null,
  ) ?? {}
  return { orgLimits, serverLimits }
}

function mergeCreateSettings(
  spec: { defaultSettings: ManagedSettings; parseSettings: (v: unknown) => ManagedSettings | null },
  body: Record<string, unknown>,
): ManagedSettings | null {
  const base = spec.parseSettings(spec.defaultSettings)
  if (!base) return null

  const exposureRaw = body.exposure
  if (!isPlainObject(exposureRaw)) {
    return base
  }

  const merged = {
    ...base,
    exposure: {
      ...base.exposure,
      ...(typeof exposureRaw.enabled === 'boolean'
        ? { enabled: exposureRaw.enabled }
        : {}),
      ...(typeof exposureRaw.publishedPort === 'number'
        ? { publishedPort: exposureRaw.publishedPort }
        : {}),
      ...(exposureRaw.bind === 'public' ||
          exposureRaw.bind === 'datacenter' ||
          exposureRaw.bind === 'local'
        ? { bind: exposureRaw.bind }
        : {}),
    },
  }
  return spec.parseSettings(merged)
}

function readInitialDatabase(spec: { parseSettings: (v: unknown) => ManagedSettings | null; defaultSettings: ManagedSettings }): string {
  const parsed = spec.parseSettings(spec.defaultSettings)
  if (parsed && typeof parsed === 'object' && 'initialDatabase' in parsed) {
    const initial = (parsed as Record<string, unknown>).initialDatabase
    if (typeof initial === 'string' && initial.length > 0) {
      return initial
    }
  }
  return 'postgres'
}

/**
 * Display-only server id for serialization/read paths — returns `null` when
 * neither `managed.server_id` nor the environment's placement is known.
 * Routes that dispatch commands against an existing managed row must use
 * {@link resolveManagedTargetServerId} instead, which 409s rather than
 * silently returning `null`.
 */
function resolveManagedServerId(
  managedRow: { serverId: string | null },
  fallbackServerId: string | null,
): string | null {
  return managedRow.serverId ?? fallbackServerId
}

function principalMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>
  }
  return {}
}

function isManagedRootPrincipal(metadata: unknown): boolean {
  return principalMetadata(metadata).managedRoot === true
}

function serializeManagedUser(
  row: Awaited<ReturnType<typeof listManagedPrincipals>>[number],
) {
  const meta = principalMetadata(row.metadata)
  const databases = Array.isArray(meta.databases)
    ? meta.databases.filter((entry): entry is string => typeof entry === 'string')
    : []
  const privileges = Array.isArray(meta.privileges)
    ? meta.privileges.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    id: row.id,
    username: row.username,
    databases,
    privileges,
    createdAt: row.createdAt,
  }
}

class ManagedPrepareRollbackError extends Error {
  readonly prepareError: ManagedApplyPrepareError

  constructor(prepareError: ManagedApplyPrepareError) {
    super(prepareError.kind)
    this.name = 'ManagedPrepareRollbackError'
    this.prepareError = prepareError
  }
}

/**
 * Clear never-applied pending container rows for an environment so
 * deleteProjectCascade does not treat them as active after the managed row is
 * removed. Same predicate as the hard-delete path on DELETE …/managed.
 */
async function clearPendingNullIdContainersForEnvironment(
  db: NonNullable<ReturnType<typeof getDb>>,
  environmentId: string,
): Promise<void> {
  const envServices = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = envServices.map((s) => s.id)
  if (serviceIds.length > 0) {
    await db.delete(container).where(
      and(
        inArray(container.serviceId, serviceIds),
        isNull(container.containerId),
        eq(container.status, 'pending'),
      ),
    )
  }
}

async function deleteManagedCompensation(
  db: NonNullable<ReturnType<typeof getDb>>,
  managedId: string,
  environmentId: string,
): Promise<void> {
  await clearPendingNullIdContainersForEnvironment(db, environmentId)
  await db.delete(managed).where(eq(managed.id, managedId))
}

const MANAGED_RETURNING = {
  id: managed.id,
  environmentId: managed.environmentId,
  displayName: managed.displayName,
  engine: managed.engine,
  status: managed.status,
  metadata: managed.metadata,
  options: managed.options,
  serverId: managed.serverId,
  createdAt: managed.createdAt,
  updatedAt: managed.updatedAt,
} as const

type ManagedRow = NonNullable<Awaited<ReturnType<typeof findManagedForEnvironment>>>

async function clearIncompleteManagedCreate(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  existing: ManagedRow,
  fallbackServerId: string | null,
): Promise<Response | null> {
  if (existing.status === 'provisioning') {
    await deleteManagedCompensation(db, existing.id, existing.environmentId)
    return null
  }
  const serverId = resolveManagedServerId(existing, fallbackServerId)
  return c.json({
    ok: true as const,
    alreadyProvisioned: true as const,
    managed: serializeManagedRow(existing, serverId),
  })
}

function parseManagedUserCreateFields(
  c: Context<AppEnv>,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions,
): { username: string; databases: string[]; privileges: string[] } | Response {
  const username = requireStringField(c, body, 'username')
  if (username instanceof Response) return username

  const { pattern, maxLength } = ctx.spec.userOperations.identifier
  if (
    !USERNAME_RE.test(username) ||
    !pattern.test(username) ||
    username.length > maxLength ||
    username === ctx.spec.rootUsername
  ) {
    return c.json({ error: 'Invalid username' }, 400)
  }

  if (!Array.isArray(body.databases) || body.databases.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const databases = body.databases.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  if (
    databases.length === 0 ||
    databases.length !== body.databases.length ||
    !databases.every((name) => options.databases.includes(name))
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const privileges = Array.isArray(body.privileges)
    ? body.privileges.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (
    Array.isArray(body.privileges) &&
    privileges.length !== body.privileges.length
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const allowedPrivileges = new Set<string>(ctx.spec.userOperations.privileges)
  if (!privileges.every((entry) => allowedPrivileges.has(entry))) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { username, databases, privileges }
}

async function resolveManagedCreatePlan(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: ManagedContext,
  organizationId: string,
  serverId: string,
  body: Record<string, unknown>,
): Promise<
  | {
    displayName: string
    settings: ManagedSettings
    initialDatabase: string
    rowOptions: ReturnType<typeof writeManagedRowOptions>
  }
  | Response
> {
  let displayName: string | null
  try {
    displayName = parseDisplayName(body)
  } catch (error) {
    if (error instanceof BadRequestError) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    throw error
  }

  let settings = mergeCreateSettings(ctx.spec, body)
  if (!settings) {
    return c.json({ error: 'managed_settings_invalid' }, 400)
  }

  const { orgLimits, serverLimits } = await loadResourceLimits(
    db,
    organizationId,
    serverId,
  )
  settings = clampManagedResources(settings, orgLimits, serverLimits)

  const infra = await preflightManagedApplyInfrastructure(c, db, {
    serverId,
    bind: settings.exposure.bind,
  })
  if (infra) return mapManagedApplyPrepareError(c, infra)

  const initialDatabase = readInitialDatabase(ctx.spec)
  return {
    displayName: displayName ?? ctx.envDisplayName ?? ctx.spec.displayName,
    settings,
    initialDatabase,
    rowOptions: writeManagedRowOptions({
      settings,
      databases: [initialDatabase],
      backups: [],
    }),
  }
}

async function insertManagedCreateTransaction(
  c: Context<AppEnv>,
  tx: NonNullable<ReturnType<typeof getDb>>,
  params: {
    environmentId: string
    ctx: ManagedContext
    serverId: string
    displayName: string
    rowOptions: ReturnType<typeof writeManagedRowOptions>
    initialDatabase: string
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<{
  row: ManagedRow
  rootPassword: string
  payload: ManagedApplyCommandPayload
}> {
  const {
    environmentId,
    ctx,
    serverId,
    displayName,
    rowOptions,
    initialDatabase,
    dataEncryptionSecrets,
  } = params

  const [insertedManaged] = await tx
    .insert(managed)
    .values({
      environmentId,
      serverId,
      displayName,
      engine: ctx.spec.engine,
      status: 'provisioning',
      metadata: {},
      options: rowOptions,
    })
    .returning(MANAGED_RETURNING)

  const managedId = insertedManaged?.id
  if (!managedId) {
    throw new TypeError('Failed to create managed row')
  }

  const { principalId, password } = await createManagedPrincipal(
    tx,
    dataEncryptionSecrets,
    {
      managedId,
      provider: ctx.spec.principalProvider,
      username: ctx.spec.rootUsername,
      metadata: {
        managedRoot: true,
        engine: ctx.spec.engine,
        databases: [initialDatabase],
      },
    },
  )

  const [updated] = await tx
    .update(managed)
    .set({
      metadata: {
        rootPrincipalId: principalId,
      },
      updatedAt: new Date().toISOString(),
    })
    .where(eq(managed.id, managedId))
    .returning(MANAGED_RETURNING)

  const row = updated ?? insertedManaged
  const parsedOptions = parseManagedRowOptions(ctx.spec, row.options)
  if (!parsedOptions) {
    throw new TypeError('Invalid managed options after create')
  }

  const payload = await buildManagedApplyPayload(c, tx, {
    managedRow: row,
    spec: ctx.spec,
    settings: parsedOptions.settings,
    databases: parsedOptions.databases,
    serverId,
    environmentId: ctx.environmentId,
    rootUsername: ctx.spec.rootUsername,
  })
  if (isPrepareError(payload)) {
    throw new ManagedPrepareRollbackError(payload)
  }

  return {
    row,
    rootPassword: password,
    payload,
  }
}

function serializeContainerRow(row: {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  composeServiceName: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serverId: row.serverId,
    containerId: row.containerId,
    containerName: row.containerName,
    status: row.status,
    composeServiceName: row.composeServiceName,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type PreparedManagedApply = {
  commandQueue: CommandQueue
  payload: ManagedApplyCommandPayload
}

/** Busy / online / dispatch / daemon-key / bind checks — no credential payload. */
async function assertManagedApplyReady(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: ManagedContext,
  managedRow: NonNullable<Awaited<ReturnType<typeof findManagedForEnvironment>>>,
  options: ManagedRowOptions,
  targetServerId: string,
): Promise<CommandQueue | Response> {
  const busy = assertManagedNotBusy(c, managedRow.status)
  if (busy) return busy

  const offline = await assertTargetServerOnline(c, db, targetServerId)
  if (offline) return offline

  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return commandQueue

  const infra = await preflightManagedApplyInfrastructure(c, db, {
    serverId: targetServerId,
    bind: options.settings.exposure.bind,
  })
  if (infra) return mapManagedApplyPrepareError(c, infra)

  return commandQueue
}

async function prepareApplyForManaged(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: ManagedContext,
  managedRow: NonNullable<Awaited<ReturnType<typeof findManagedForEnvironment>>>,
  options: ManagedRowOptions,
  targetServerId: string,
  extra?: {
    dropUsers?: string[]
    dropDatabases?: string[]
    omitPrincipalIds?: string[]
  },
): Promise<PreparedManagedApply | Response> {
  const commandQueue = await assertManagedApplyReady(
    c,
    db,
    ctx,
    managedRow,
    options,
    targetServerId,
  )
  if (commandQueue instanceof Response) return commandQueue

  const payload = await buildManagedApplyPayload(c, db, {
    managedRow,
    spec: ctx.spec,
    settings: options.settings,
    databases: options.databases,
    serverId: targetServerId,
    environmentId: ctx.environmentId,
    rootUsername: ctx.spec.rootUsername,
    dropUsers: extra?.dropUsers,
    dropDatabases: extra?.dropDatabases,
    omitPrincipalIds: extra?.omitPrincipalIds,
  })
  if (isPrepareError(payload)) {
    return mapManagedApplyPrepareError(c, payload)
  }

  return { commandQueue, payload }
}

async function runApplyForManaged(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    userId: string
    ctx: ManagedContext
    managedRow: ManagedRow
    options: ManagedRowOptions
    targetServerId: string
  },
): Promise<Response> {
  const { userId, ctx, managedRow, options, targetServerId } = params
  const prepared = await prepareApplyForManaged(
    c,
    db,
    ctx,
    managedRow,
    options,
    targetServerId,
  )
  if (prepared instanceof Response) return prepared

  const enqueued = await enqueueManagedApply(c, db, prepared.commandQueue, {
    serverId: targetServerId,
    userId,
    managedId: managedRow.id,
    payload: prepared.payload,
  })
  if (enqueued instanceof Response) return enqueued
  return c.json(enqueued)
}

async function createManagedAndEnqueueApply(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    environmentId: string
    ctx: ManagedContext
    createServerId: string
    userId: string
    plan: {
      displayName: string
      rowOptions: ReturnType<typeof writeManagedRowOptions>
      initialDatabase: string
    }
    dataEncryptionSecrets: DerivedSecretsConfig
    commandQueue: CommandQueue
  },
): Promise<Response> {
  const {
    environmentId,
    ctx,
    createServerId,
    userId,
    plan,
    dataEncryptionSecrets,
    commandQueue,
  } = params

  let created: Awaited<ReturnType<typeof insertManagedCreateTransaction>>
  try {
    created = await db.transaction(async (tx) =>
      insertManagedCreateTransaction(c, tx, {
        environmentId,
        ctx,
        serverId: createServerId,
        displayName: plan.displayName,
        rowOptions: plan.rowOptions,
        initialDatabase: plan.initialDatabase,
        dataEncryptionSecrets,
      }))
  } catch (error) {
    if (error instanceof ManagedPrepareRollbackError) {
      return mapManagedApplyPrepareError(c, error.prepareError)
    }
    throw error
  }

  const enqueued = await enqueueManagedApply(c, db, commandQueue, {
    serverId: createServerId,
    userId,
    managedId: created.row.id,
    payload: created.payload,
  })
  if (enqueued instanceof Response) {
    await deleteManagedCompensation(db, created.row.id, environmentId)
    return enqueued
  }

  return c.json({
    ok: true as const,
    managed: serializeManagedRow(created.row, createServerId),
    commandId: enqueued.commandId,
    serverId: enqueued.serverId,
    rootPassword: created.rootPassword,
  })
}

export function registerManagedRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for managed routes')
  }

  for (const path of managedSessionPaths()) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }

  router.post('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const existing = await findManagedForEnvironment(db, environmentId)
    if (existing) {
      // Incomplete creates never enqueued apply — remove so a fresh show-once
      // password can be issued. Successful creates leave status beyond
      // provisioning. This is not itself a create, so it displays whichever
      // server id is known (`managed.server_id`, falling back to the
      // environment's current placement) rather than hard-requiring one.
      const idempotent = await clearIncompleteManagedCreate(
        c,
        db,
        existing,
        ctx.serverId,
      )
      if (idempotent) return idempotent
    }

    // A brand-new managed row has no `server_id` pin of its own yet, so
    // creation is the one operation that still requires the environment's
    // placement — existing rows resolve via `managed.server_id` instead.
    const createServerId = requireManagedCreateServerId(c, ctx.serverId)
    if (createServerId instanceof Response) return createServerId

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const offline = await assertTargetServerOnline(c, db, createServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const plan = await resolveManagedCreatePlan(
      c,
      db,
      ctx,
      auth.organizationId,
      createServerId,
      body,
    )
    if (plan instanceof Response) return plan

    return createManagedAndEnqueueApply(c, db, {
      environmentId,
      ctx,
      createServerId,
      userId: auth.userId,
      plan,
      dataEncryptionSecrets,
      commandQueue,
    })
  })

  router.get('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) {
      return c.json({
        managed: null,
        connection: null,
        settings: null,
        server: null,
        rootUsername: ctx.spec.rootUsername,
      })
    }

    const serverId = resolveManagedServerId(row, ctx.serverId)
    const parsed = parseManagedRowOptions(ctx.spec, row.options)
    if (!parsed) {
      return c.json({ error: 'Invalid managed options' }, 400)
    }

    const residual = parseManagedResidual(row.metadata)
    const database = parsed.databases[0] ?? readInitialDatabase(ctx.spec)
    const connection = residual.host !== undefined && residual.port !== undefined
      ? buildConnectionPayload(ctx.spec, {
        host: residual.host,
        port: residual.port,
        database,
        username: ctx.spec.rootUsername,
        settings: parsed.settings,
      })
      : null

    const serverRows = serverId
      ? await db
        .select({
          id: server.id,
          displayName: server.displayName,
          hostname: server.hostname,
        })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1)
      : []
    const serverRow = serverRows[0]

    return c.json({
      managed: serializeManagedRow(row, serverId),
      connection,
      settings: parsed.settings,
      server: serverRow ?? null,
      rootUsername: ctx.spec.rootUsername,
    })
  })

  router.patch('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    // Resource limits are server-specific — clamp against the host that
    // actually runs the engine (`managed.server_id`), not the (possibly
    // drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const current = parseManagedRowOptions(ctx.spec, row.options)
    if (!current) return c.json({ error: 'Invalid managed options' }, 400)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const mergedSettings = ctx.spec.parseSettings({
      ...current.settings,
      ...(isPlainObject(body.settings) ? body.settings : {}),
    })
    if (!mergedSettings) {
      return c.json({ error: 'managed_settings_invalid' }, 400)
    }

    const { orgLimits, serverLimits } = await loadResourceLimits(
      db,
      auth.organizationId,
      targetServerId,
    )
    const clamped = clampManagedResources(mergedSettings, orgLimits, serverLimits)

    const nextOptions = writeManagedRowOptions({
      settings: clamped,
      databases: current.databases,
      backups: current.backups,
    })

    const [updated] = await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))
      .returning({
        id: managed.id,
        environmentId: managed.environmentId,
        displayName: managed.displayName,
        engine: managed.engine,
        status: managed.status,
        metadata: managed.metadata,
        options: managed.options,
        serverId: managed.serverId,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
      })

    return c.json({
      ok: true,
      managed: serializeManagedRow(updated ?? row, targetServerId),
      settings: clamped,
    })
  })

  router.post('/environments/:id/managed/apply', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    return runApplyForManaged(c, db, {
      userId: auth.userId,
      ctx,
      managedRow: row,
      options,
      targetServerId,
    })
  })

  router.post('/environments/:id/managed/lifecycle', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const action = body.action
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const enqueued = await enqueueManagedLifecycle(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      action,
    })
    if (enqueued instanceof Response) return enqueued
    return c.json(enqueued)
  })

  router.delete('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const canHardDelete = row.status === 'stopped' ||
      row.status === 'failed' ||
      row.status === 'provisioning' ||
      !row.serverId

    if (canHardDelete) {
      // Clear never-applied pending container rows so deleteProjectCascade does
      // not treat them as active (`isActiveContainerStatus('pending')` is true).
      await clearPendingNullIdContainersForEnvironment(db, environmentId)
      await db.delete(managed).where(eq(managed.id, row.id))
      return c.json({ ok: true as const, deleted: true as const })
    }

    // `canHardDelete` already covers `!row.serverId`, so `managed.server_id`
    // is guaranteed here — resolve through the shared helper anyway for
    // consistency with every other existing-row route.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    // Single-click delete: this is the API delete route, not a future
    // "destroy runtime only" action, so mark the payload for the consumer's
    // row-cleanup side effect — deleting the `managed` row after a
    // successful destroy cascades to `principal.managed_id`. The API stays
    // the source of truth for when that cleanup happens (only after the
    // daemon reports success), not the UI.
    const enqueued = await enqueueManagedDestroy(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      removeVolumes: true,
      deleteAfterDestroy: true,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true as const,
      deleted: false as const,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.post('/environments/:id/managed/root-password', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const residual = parseManagedResidual(row.metadata)
    const rootPrincipalId = residual.rootPrincipalId
    if (!rootPrincipalId) {
      return c.json({ error: 'root_principal_missing' }, 500)
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const commandQueue = await assertManagedApplyReady(
      c,
      db,
      ctx,
      row,
      options,
      targetServerId,
    )
    if (commandQueue instanceof Response) return commandQueue

    const [previous] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, rootPrincipalId))
      .limit(1)
    const previousPassword = previous?.password

    const { plaintext } = await rotatePrincipalPassword(
      db,
      dataEncryptionSecrets,
      rootPrincipalId,
    )

    const payload = await buildManagedApplyPayload(c, db, {
      managedRow: row,
      spec: ctx.spec,
      settings: options.settings,
      databases: options.databases,
      serverId: targetServerId,
      environmentId: ctx.environmentId,
      rootUsername: ctx.spec.rootUsername,
    })
    if (isPrepareError(payload)) {
      if (typeof previousPassword === 'string') {
        await db
          .update(principal)
          .set({ password: previousPassword, updatedAt: new Date().toISOString() })
          .where(eq(principal.id, rootPrincipalId))
      }
      return mapManagedApplyPrepareError(c, payload)
    }

    const enqueued = await enqueueManagedApply(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload,
    })
    if (enqueued instanceof Response) {
      if (typeof previousPassword === 'string') {
        await db
          .update(principal)
          .set({ password: previousPassword, updatedAt: new Date().toISOString() })
          .where(eq(principal.id, rootPrincipalId))
      }
      return enqueued
    }

    return c.json({
      ok: true,
      rootPassword: plaintext,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.get('/environments/:id/managed/users', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ users: [] })

    const users = await listManagedPrincipals(db, row.id)
    return c.json({
      users: users
        .filter((entry) => !isManagedRootPrincipal(entry.metadata))
        .map((entry) => serializeManagedUser(entry)),
    })
  })

  router.post('/environments/:id/managed/users', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const fields = parseManagedUserCreateFields(c, ctx, body, options)
    if (fields instanceof Response) return fields
    const { username, databases, privileges } = fields

    const existingUsers = await listManagedPrincipals(db, row.id)
    if (existingUsers.some((entry) => entry.username === username)) {
      return c.json({ error: 'managed_user_exists' }, 409)
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const commandQueue = await assertManagedApplyReady(
      c,
      db,
      ctx,
      row,
      options,
      targetServerId,
    )
    if (commandQueue instanceof Response) return commandQueue

    const { principalId, password } = await createManagedPrincipal(
      db,
      dataEncryptionSecrets,
      {
        managedId: row.id,
        provider: ctx.spec.principalProvider,
        username,
        metadata: {
          engine: ctx.spec.engine,
          databases,
          privileges,
        },
      },
    )

    const payload = await buildManagedApplyPayload(c, db, {
      managedRow: row,
      spec: ctx.spec,
      settings: options.settings,
      databases: options.databases,
      serverId: targetServerId,
      environmentId: ctx.environmentId,
      rootUsername: ctx.spec.rootUsername,
    })
    if (isPrepareError(payload)) {
      await db.delete(principal).where(eq(principal.id, principalId))
      return mapManagedApplyPrepareError(c, payload)
    }

    const enqueued = await enqueueManagedApply(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload,
    })
    if (enqueued instanceof Response) {
      await db.delete(principal).where(eq(principal.id, principalId))
      return enqueued
    }

    const [createdUser] = await db
      .select({ createdAt: principal.createdAt })
      .from(principal)
      .where(eq(principal.id, principalId))
      .limit(1)

    return c.json({
      ok: true,
      user: {
        id: principalId,
        username,
        databases,
        privileges,
        createdAt: createdUser?.createdAt ?? new Date().toISOString(),
      },
      password,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.delete('/environments/:id/managed/users/:principalId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const principalId = c.req.param('principalId')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const [target] = await db
      .select({
        id: principal.id,
        username: principal.username,
        metadata: principal.metadata,
        kind: principal.kind,
        provider: principal.provider,
        managedId: principal.managedId,
        options: principal.options,
        password: principal.password,
        createdAt: principal.createdAt,
        updatedAt: principal.updatedAt,
      })
      .from(principal)
      .where(and(eq(principal.id, principalId), eq(principal.managedId, row.id)))
      .limit(1)
    if (!target) return c.json({ error: 'Not found' }, 404)

    if (isManagedRootPrincipal(target.metadata)) {
      return c.json({ error: 'cannot_drop_root_user' }, 400)
    }

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const prepared = await prepareApplyForManaged(c, db, ctx, row, options, targetServerId, {
      dropUsers: [target.username],
      omitPrincipalIds: [principalId],
    })
    if (prepared instanceof Response) return prepared

    await db.delete(principal).where(eq(principal.id, principalId))

    const enqueued = await enqueueManagedApply(c, db, prepared.commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload: prepared.payload,
    })
    if (enqueued instanceof Response) {
      await db.insert(principal).values({
        id: target.id,
        kind: target.kind,
        provider: target.provider,
        username: target.username,
        managedId: target.managedId,
        metadata: target.metadata,
        options: target.options,
        password: target.password,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
      })
      return enqueued
    }

    return c.json({
      ok: true,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.get('/environments/:id/managed/databases', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ databases: [] })

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)
    return c.json({ databases: options.databases })
  })

  router.post('/environments/:id/managed/databases', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const name = requireStringField(c, body, 'name')
    if (name instanceof Response) return name

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const { pattern, maxLength } = ctx.spec.userOperations.identifier
    if (!pattern.test(name) || name.length > maxLength) {
      return c.json({ error: 'Invalid database name' }, 400)
    }
    if (options.databases.includes(name)) {
      return c.json({ error: 'database_exists' }, 409)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const nextDatabases = [...options.databases, name].sort((a, b) => a.localeCompare(b))
    const nextOptions = writeManagedRowOptions({
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    })

    const prepared = await prepareApplyForManaged(c, db, ctx, row, {
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    }, targetServerId)
    if (prepared instanceof Response) return prepared

    const previousOptions = row.options
    await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))

    const enqueued = await enqueueManagedApply(c, db, prepared.commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload: prepared.payload,
    })
    if (enqueued instanceof Response) {
      await db
        .update(managed)
        .set({
          options: previousOptions,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(managed.id, row.id))
      return enqueued
    }

    return c.json({
      ok: true,
      databases: nextDatabases,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.delete('/environments/:id/managed/databases/:databaseName', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const databaseName = decodeURIComponent(c.req.param('databaseName'))
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)
    if (!options.databases.includes(databaseName)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const initialDatabase = readInitialDatabase(ctx.spec)
    if (databaseName === initialDatabase) {
      return c.json({ error: 'cannot_drop_initial_database' }, 409)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const nextDatabases = options.databases.filter((entry) => entry !== databaseName)
    const nextOptions = writeManagedRowOptions({
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    })

    const prepared = await prepareApplyForManaged(c, db, ctx, row, {
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    }, targetServerId, { dropDatabases: [databaseName] })
    if (prepared instanceof Response) return prepared

    const previousOptions = row.options
    await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))

    const enqueued = await enqueueManagedApply(c, db, prepared.commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload: prepared.payload,
    })
    if (enqueued instanceof Response) {
      await db
        .update(managed)
        .set({
          options: previousOptions,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(managed.id, row.id))
      return enqueued
    }

    return c.json({
      ok: true,
      databases: nextDatabases,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.get('/environments/:id/managed/status', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    const residual = row ? parseManagedResidual(row.metadata) : {}

    const rows = await db
      .select({
        id: container.id,
        serviceId: container.serviceId,
        serverId: container.serverId,
        containerId: container.containerId,
        containerName: container.containerName,
        status: container.status,
        composeServiceName: container.composeServiceName,
        metadata: container.metadata,
        options: container.options,
        createdAt: container.createdAt,
        updatedAt: container.updatedAt,
      })
      .from(container)
      .innerJoin(service, eq(container.serviceId, service.id))
      .where(eq(service.environmentId, environmentId))

    return c.json({
      status: row?.status ?? null,
      host: residual.host ?? null,
      port: residual.port ?? null,
      containers: rows.map(serializeContainerRow),
    })
  })

  router.get('/environments/:id/managed/logs', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const serverId = row.serverId
    if (!serverId) return c.json({ error: 'server_placement_required' }, 409)

    const tail = parseLogsTailQuery(c.req.query('tail'))
    const result = await fetchManagedLogs(c, db, {
      managedId: row.id,
      serverId,
      tail,
    })
    if (result instanceof Response) return result
    return c.json(result)
  })

  router.get('/environments/:id/managed/backups', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ backups: [] })

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const backups = [...options.backups].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )
    return c.json({ backups })
  })

  router.post('/environments/:id/managed/backups', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    // Backup artifacts live on the host that actually ran the engine —
    // `managed.server_id`, not the (possibly drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const database = resolveBackupDatabase(options, body.database)
    if (database === null) {
      return c.json({ error: 'Invalid database' }, 400)
    }

    const built = buildManagedBackupCreatePayload(ctx, row.id, options, database)
    if (isManagedBackupApiError(built)) return mapManagedBackupApiError(c, built)

    const enqueued = await enqueueManagedBackup(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      payload: built.payload,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true,
      backupId: built.backupId,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.delete('/environments/:id/managed/backups/:backupId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const backupId = decodeURIComponent(c.req.param('backupId'))
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const record: ManagedBackupRecord | undefined = options.backups.find(
      (entry) => entry.id === backupId,
    )
    if (!record) return c.json({ error: 'backup_not_found' }, 404)

    // Backup artifacts live on the host that actually ran the engine —
    // `managed.server_id`, not the (possibly drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const built = buildManagedBackupDeletePayload(ctx, row.id, record)
    if (isManagedBackupApiError(built)) return mapManagedBackupApiError(c, built)

    const enqueued = await enqueueManagedBackup(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      payload: built.payload,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.post('/environments/:id/managed/backups/:backupId/restore', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const backupId = decodeURIComponent(c.req.param('backupId'))
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const record: ManagedBackupRecord | undefined = options.backups.find(
      (entry) => entry.id === backupId,
    )
    if (!record) return c.json({ error: 'backup_not_found' }, 404)

    // Restore must run on the host that actually owns the engine —
    // `managed.server_id`, not the (possibly drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId, ctx.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const built = buildManagedRestorePayload(ctx, row.id, record)
    if (isManagedBackupApiError(built)) return mapManagedBackupApiError(c, built)

    const enqueued = await enqueueManagedRestore(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload: built.payload,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.get('/organizations/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const organizationId = c.req.param('id')
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    if (orgResult !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const rows = await db
      .select({
        id: managed.id,
        environmentId: managed.environmentId,
        displayName: managed.displayName,
        engine: managed.engine,
        status: managed.status,
        metadata: managed.metadata,
        options: managed.options,
        serverId: managed.serverId,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
        environmentDisplayName: environment.displayName,
        projectId: project.id,
        projectDisplayName: project.displayName,
        workspaceId: workspace.id,
        workspaceDisplayName: workspace.displayName,
        serverDisplayName: server.displayName,
      })
      .from(managed)
      .innerJoin(environment, eq(managed.environmentId, environment.id))
      .innerJoin(project, eq(environment.projectId, project.id))
      .innerJoin(workspace, eq(project.workspaceId, workspace.id))
      .leftJoin(server, eq(managed.serverId, server.id))
      .where(eq(workspace.organizationId, organizationId))
      .orderBy(desc(managed.createdAt))

    return c.json({
      managed: rows.map((row) => {
        const spec = row.engine ? getManagedEngineSpec(row.engine) : null
        return {
          ...serializeManagedRow(row, row.serverId),
          engineDisplayName: spec?.displayName ?? null,
          environmentDisplayName: row.environmentDisplayName,
          projectId: row.projectId,
          projectDisplayName: row.projectDisplayName,
          workspaceId: row.workspaceId,
          workspaceDisplayName: row.workspaceDisplayName,
          serverDisplayName: row.serverDisplayName,
        }
      }),
    })
  })
}
