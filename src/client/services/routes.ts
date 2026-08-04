import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { service } from '../../lib/db/schema.ts'
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
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import { parseServiceOptions } from '../../lib/service-options.ts'

/** Compose name lives on `service.compose_service_name` — never persist into metadata. */
const SERVICE_PROMOTED_METADATA_KEYS = ['composeServiceName'] as const

type ServiceRow = {
  id: string
  displayName: string | null
  description: string | null
  environmentId: string
  composeServiceName: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

function serializeService(row: ServiceRow) {
  return {
    id: row.id,
    displayName: row.displayName,
    description: row.description,
    environmentId: row.environmentId,
    composeServiceName: row.composeServiceName,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const SERVICE_SELECT = {
  id: service.id,
  displayName: service.displayName,
  description: service.description,
  environmentId: service.environmentId,
  composeServiceName: service.composeServiceName,
  metadata: service.metadata,
  options: service.options,
  createdAt: service.createdAt,
  updatedAt: service.updatedAt,
} as const

type OptionalServiceOptionsResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: NonNullable<ReturnType<typeof parseServiceOptions>> }
  | { kind: 'error'; response: Response }

function parseOptionalServiceOptions(
  c: Context,
  body: Record<string, unknown>,
): OptionalServiceOptionsResult {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return { kind: 'error', response: optionsResult }
  if (optionsResult === null) return { kind: 'absent' }
  const parsed = parseServiceOptions(optionsResult)
  if (parsed === null) {
    return { kind: 'error', response: c.json({ error: 'invalid_service_options' }, 400) }
  }
  return { kind: 'value', value: parsed }
}

/**
 * `composeServiceName` is derived from the compose document (reconcile /
 * managed allocation / container reconcile) — reject any client-supplied
 * value (including explicit `null`) rather than silently ignoring it.
 */
function rejectComposeServiceNameInBody(
  c: Context,
  body: Record<string, unknown>,
): Response | null {
  if (body.composeServiceName === undefined) return null
  return c.json(
    {
      error: 'compose_service_name_read_only',
      message:
        'compose_service_name is derived from the compose document and cannot be set directly — edit the compose document instead.',
    },
    400,
  )
}

type ServicePatchFields = {
  displayName?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

function buildServicePatchFields(
  c: Context,
  body: Record<string, unknown>,
): ServicePatchFields | Response {
  const composeNameRejected = rejectComposeServiceNameInBody(c, body)
  if (composeNameRejected) return composeNameRejected

  let patchFields: ServicePatchFields
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
      SERVICE_PROMOTED_METADATA_KEYS,
    )
  }

  const optionsResult = parseOptionalServiceOptions(c, body)
  if (optionsResult.kind === 'error') return optionsResult.response
  if (optionsResult.kind === 'value') patchFields.options = optionsResult.value

  return patchFields
}

type ServiceCreateFieldsResult =
  | {
    kind: 'ok'
    displayName: string | null
    description: string | null
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
  }
  | { kind: 'error'; response: Response }

function parseServiceCreateFields(
  c: Context,
  body: Record<string, unknown>,
): ServiceCreateFieldsResult {
  const composeNameRejected = rejectComposeServiceNameInBody(c, body)
  if (composeNameRejected) return { kind: 'error', response: composeNameRejected }

  let displayName: string | null
  let description: string | null
  try {
    displayName = parseDisplayName(body)
    description = parseDescription(body)
  } catch {
    return { kind: 'error', response: c.json({ error: 'Invalid request' }, 400) }
  }

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) {
    return { kind: 'error', response: metadataResult }
  }

  const optionsResult = parseOptionalServiceOptions(c, body)
  if (optionsResult.kind === 'error') {
    return { kind: 'error', response: optionsResult.response }
  }

  const metadata = metadataResult === null
    ? null
    : stripPromotedMetadataKeys(metadataResult, SERVICE_PROMOTED_METADATA_KEYS)

  return {
    kind: 'ok',
    displayName,
    description,
    metadata,
    options: optionsResult.kind === 'value' ? optionsResult.value : null,
  }
}

export function registerServiceRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/services', createSessionMiddleware(opts.secrets))
  router.use('/services/:id', createSessionMiddleware(opts.secrets))

  router.get('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const environmentId = c.req.query('environmentId')
    const composeServiceName = c.req.query('composeServiceName')

    const visibleIds = await listVisible(db, {
      kind: 'service',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ services: [] })
    }

    const conditions = [inArray(service.id, visibleIds)]
    if (environmentId) {
      conditions.push(eq(service.environmentId, environmentId))
    }
    if (composeServiceName) {
      conditions.push(eq(service.composeServiceName, composeServiceName))
    }

    const rows = await db
      .select(SERVICE_SELECT)
      .from(service)
      .where(and(...conditions))
      .orderBy(service.createdAt)

    return c.json({ services: rows.map(serializeService) })
  })

  router.get('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select(SERVICE_SELECT)
      .from(service)
      .where(eq(service.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'service', id)
    if (denied) return denied

    return c.json({ service: serializeService(row) })
  })

  router.post('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const environmentId = requireStringField(c, body, 'environmentId')
    if (environmentId instanceof Response) return environmentId

    const environmentOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
    if (!environmentOrgId || environmentOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'environment', environmentId)
    if (denied) return denied

    const fields = parseServiceCreateFields(c, body)
    if (fields.kind === 'error') return fields.response

    // `compose_service_name` is NOT NULL and derived only from the compose
    // document via reconcile — there is no client-suppliable value that can
    // satisfy it here, so this route can never create a valid row.
    return c.json(
      {
        error: 'service_create_not_supported',
        message:
          'Services are created automatically from the compose document (save the project/environment compose, or create the environment) — POST /services is not supported.',
      },
      400,
    )
  })

  router.patch('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'service', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patchFields = buildServicePatchFields(c, body)
    if (patchFields instanceof Response) return patchFields

    await db
      .update(service)
      .set(patchFields)
      .where(eq(service.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'service', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', id)
    if (immutable) return immutable

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(service).where(eq(service.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
