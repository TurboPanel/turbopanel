import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { service } from '../../lib/db/schema.ts'
import { applyStorageRetentionOnParentDelete } from '../../lib/db/storage-records.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  parseServiceCreateFields,
  parseServicePatchFields,
  serializeService,
  SERVICE_CREATE_NOT_SUPPORTED,
} from './routes-helpers.ts'

const SERVICE_SELECT = {
  id: service.id,
  displayName: service.name,
  description: service.description,
  environmentId: service.environmentId,
  composeServiceName: service.composeServiceName,
  metadata: service.metadata,
  options: service.options,
  createdAt: service.createdAt,
  updatedAt: service.updatedAt,
} as const

function buildServicePatchFields(
  c: Context,
  body: Record<string, unknown>,
) {
  const parsed = parseServicePatchFields(body)
  if ('ok' in parsed && parsed.ok === false && 'message' in parsed) {
    return c.json({ error: parsed.error, message: parsed.message }, parsed.status)
  }
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }
  return parsed.patch
}

export function registerServiceRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for service routes')
  }
  const secrets = opts.secrets

  router.use('/services', createSessionMiddleware(secrets))
  router.use('/services/:id', createSessionMiddleware(secrets))

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

    const fields = parseServiceCreateFields(body)
    if (!fields.ok) {
      if ('message' in fields) {
        return c.json({ error: fields.error, message: fields.message }, fields.status)
      }
      return c.json({ error: fields.error }, fields.status)
    }

    // `compose_service_name` is NOT NULL and derived only from the compose
    // document via reconcile — there is no client-suppliable value that can
    // satisfy it here, so this route can never create a valid row.
    return c.json(SERVICE_CREATE_NOT_SUPPORTED, 400)
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
      await applyStorageRetentionOnParentDelete(tx, { serviceIds: [id] })
      await tx.delete(service).where(eq(service.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
