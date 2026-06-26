import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { environment, service } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseDescription,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'

export function registerServiceRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/services', createSessionMiddleware(opts.secrets))
  router.use('/services/:id', createSessionMiddleware(opts.secrets))

  router.get('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const environmentId = c.req.query('environmentId')

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

    const rows = await db
      .select({
        id: service.id,
        displayName: service.displayName,
        description: service.description,
        environmentId: service.environmentId,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
      })
      .from(service)
      .where(and(...conditions))
      .orderBy(service.createdAt)

    return c.json({ services: rows })
  })

  router.get('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select({
        id: service.id,
        displayName: service.displayName,
        description: service.description,
        environmentId: service.environmentId,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
      })
      .from(service)
      .where(eq(service.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'service', id)
    if (denied) return denied

    return c.json({ service: row })
  })

  router.post('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
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

    let displayName: string | null
    let description: string | null
    try {
      displayName = parseDisplayName(body)
      description = parseDescription(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(service)
        .values({ displayName, description, environmentId })
        .returning({ id: service.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'service', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: { displayName?: string | null; description?: string | null; updatedAt: string }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

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

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'service', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(service).where(eq(service.id, id))
    })

    return c.json({ ok: true as const })
  })
}
