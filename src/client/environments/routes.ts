import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { environment } from '../../lib/db/schema.ts'
import {
  applyValidatedComposeOption,
  isPlacementServerId,
  stripComposePlacementOption,
} from '../../lib/compose/index.ts'
import { verifyServerInOrg } from './deploy-prepare.ts'
import { reconcileServicesForEnvironment } from './reconcile-after-compose-save.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseDescription,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
  stripPromotedMetadataKeys,
} from '../shared.ts'

/** Placement lives on `environment.server_id` — never persist it into metadata.
 * `component` is reserved for system project identity — never accept it on
 * public environment create/patch. */
const ENVIRONMENT_PROMOTED_METADATA_KEYS = ['serverId', 'component'] as const
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

type EnvironmentPatchFields = {
  displayName?: string | null
  description?: string | null
  serverId?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

type EnvironmentRow = {
  id: string
  displayName: string | null
  description: string | null
  projectId: string
  serverId: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

function serializeEnvironment(row: EnvironmentRow) {
  return {
    id: row.id,
    displayName: row.displayName,
    description: row.description,
    projectId: row.projectId,
    serverId: row.serverId,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const ENVIRONMENT_SELECT = {
  id: environment.id,
  displayName: environment.name,
  description: environment.description,
  projectId: environment.projectId,
  serverId: environment.serverId,
  metadata: environment.metadata,
  options: environment.options,
  createdAt: environment.createdAt,
  updatedAt: environment.updatedAt,
} as const

function buildEnvironmentPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): EnvironmentPatchFields | Response {
  let patchFields: EnvironmentPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) {
    patchFields.metadata = stripPromotedMetadataKeys(
      metadataResult,
      ENVIRONMENT_PROMOTED_METADATA_KEYS,
    )
  }
  return patchFields
}

function applyEnvironmentOptionsPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  patchFields: EnvironmentPatchFields,
): Response | undefined {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult === null) return

  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return c.json({ error: 'compose_invalid', issues: composeOption.issues }, 400)
  }
  stripComposePlacementOption(optionsResult)
  patchFields.options = optionsResult
}

/**
 * Optional `serverId` on create/patch. `undefined` means the field was omitted;
 * `null` clears placement; a UUID pins a same-org server.
 */
async function parseOptionalServerId(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<string | null | undefined | Response> {
  if (!('serverId' in body)) return undefined

  const value = body.serverId
  if (value === null) return null
  if (!isPlacementServerId(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (!(await verifyServerInOrg(db, value, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
  return value
}

async function applyEnvironmentServerIdPatch(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  patchFields: EnvironmentPatchFields,
): Promise<Response | undefined> {
  const serverId = await parseOptionalServerId(c, db, organizationId, body)
  if (serverId instanceof Response) return serverId
  if (serverId === undefined) return
  patchFields.serverId = serverId
}

type CreateEnvironmentInput = {
  projectId: string
  displayName: string | null
  description: string | null
  serverId?: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

function parseCreateEnvironmentNames(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): { displayName: string | null; description: string | null } | Response {
  try {
    return {
      displayName: parseDisplayName(body),
      description: parseDescription(body),
    }
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
}

function parseCreateEnvironmentJsonb(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): {
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
} | Response {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return c.json({ error: 'compose_invalid', issues: composeOption.issues }, 400)
  }
  if (optionsResult !== null) {
    stripComposePlacementOption(optionsResult)
  }

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  const metadata = metadataResult === null
    ? null
    : stripPromotedMetadataKeys(metadataResult, ENVIRONMENT_PROMOTED_METADATA_KEYS)

  return { metadata, options: optionsResult }
}

async function parseCreateEnvironmentInput(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
): Promise<CreateEnvironmentInput | Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body

  const projectId = requireStringField(c, body, 'projectId')
  if (projectId instanceof Response) return projectId

  const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
  if (!projectOrgId || projectOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = await assertCanCreateOr403(c, 'project', projectId)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, 'project', projectId)
  if (immutable) return immutable

  const names = parseCreateEnvironmentNames(c, body)
  if (names instanceof Response) return names

  const jsonb = parseCreateEnvironmentJsonb(c, body)
  if (jsonb instanceof Response) return jsonb

  const serverId = await parseOptionalServerId(c, db, organizationId, body)
  if (serverId instanceof Response) return serverId

  return {
    projectId,
    name: names.displayName,
    description: names.description,
    ...(serverId !== undefined ? { serverId } : {}),
    metadata: jsonb.metadata,
    options: jsonb.options,
  }
}

export function registerEnvironmentRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment routes')
  }
  const secrets = opts.secrets

  router.use('/environments', createSessionMiddleware(secrets))
  router.use('/environments/:id', createSessionMiddleware(secrets))

  router.get('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const projectId = c.req.query('projectId')

    const visibleIds = await listVisible(db, {
      kind: 'environment',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ environments: [] })
    }

    const conditions = [inArray(environment.id, visibleIds)]
    if (projectId) {
      conditions.push(eq(environment.projectId, projectId))
    }

    const rows = await db
      .select(ENVIRONMENT_SELECT)
      .from(environment)
      .where(and(...conditions))
      .orderBy(environment.createdAt)

    return c.json({ environments: rows.map(serializeEnvironment) })
  })

  router.get('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select(ENVIRONMENT_SELECT)
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'environment', id)
    if (denied) return denied

    return c.json({ environment: serializeEnvironment(row) })
  })

  router.post('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const input = await parseCreateEnvironmentInput(c, db, orgResult)
    if (input instanceof Response) return input

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(environment)
        .values({
          name: input.displayName,
          description: input.description,
          projectId: input.projectId,
          ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
          ...(input.metadata !== null ? { metadata: input.metadata } : {}),
          ...(input.options !== null ? { options: input.options } : {}),
        })
        .returning({ id: environment.id })
      return inserted.id
    })

    await reconcileServicesForEnvironment(db, id)

    return c.json({ ok: true as const, id })
  })

  router.patch('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'environment', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'environment', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patchFields = buildEnvironmentPatchFields(c, body)
    if (patchFields instanceof Response) return patchFields

    const serverIdError = await applyEnvironmentServerIdPatch(
      c,
      db,
      organizationId,
      body,
      patchFields,
    )
    if (serverIdError) return serverIdError

    const optionsError = applyEnvironmentOptionsPatch(c, body, patchFields)
    if (optionsError) return optionsError

    await db
      .update(environment)
      .set(patchFields)
      .where(eq(environment.id, id))

    if (patchFields.options !== undefined) {
      await reconcileServicesForEnvironment(db, id)
    }

    return c.json({ ok: true as const })
  })

  router.delete('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'environment', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'environment', id)
    if (immutable) return immutable

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(environment).where(eq(environment.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
