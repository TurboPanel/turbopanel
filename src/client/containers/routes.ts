import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { container, server } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

export function registerContainerRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/containers', createSessionMiddleware(opts.secrets))
  router.use('/containers/:id', createSessionMiddleware(opts.secrets))

  router.get('/containers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serviceId = c.req.query('serviceId')
    const serverId = c.req.query('serverId')

    const visibleIds = await listVisible(db, {
      kind: 'container',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ containers: [] })
    }

    const conditions = [inArray(container.id, visibleIds)]
    if (serviceId) {
      conditions.push(eq(container.serviceId, serviceId))
    }
    if (serverId) {
      conditions.push(eq(container.serverId, serverId))
    }

    const rows = await db
      .select({
        id: container.id,
        serviceId: container.serviceId,
        serverId: container.serverId,
        metadata: container.metadata,
        options: container.options,
        createdAt: container.createdAt,
        updatedAt: container.updatedAt,
      })
      .from(container)
      .where(and(...conditions))
      .orderBy(container.createdAt)

    return c.json({ containers: rows })
  })

  router.get('/containers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'container', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select({
        id: container.id,
        serviceId: container.serviceId,
        serverId: container.serverId,
        metadata: container.metadata,
        options: container.options,
        createdAt: container.createdAt,
        updatedAt: container.updatedAt,
      })
      .from(container)
      .where(eq(container.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'container', id)
    if (denied) return denied

    return c.json({ container: row })
  })

  router.post('/containers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const serviceId = requireStringField(c, body, 'serviceId')
    if (serviceId instanceof Response) return serviceId

    const serverId = requireStringField(c, body, 'serverId')
    if (serverId instanceof Response) return serverId

    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
    if (!serviceOrgId || serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const serverRows = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)

    const serverOrgId = serverRows[0]?.organizationId
    if (!serverOrgId || serverOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'service', serviceId)
    if (denied) return denied

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(container)
        .values({
          serviceId,
          serverId,
          ...(metadataResult !== null ? { metadata: metadataResult } : {}),
          ...(optionsResult !== null ? { options: optionsResult } : {}),
        })
        .returning({ id: container.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/containers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'container', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'container', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: {
      metadata?: Record<string, unknown> | null
      options?: Record<string, unknown> | null
      updatedAt: string
    }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    if (metadataResult !== null) patchFields.metadata = metadataResult

    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult
    if (optionsResult !== null) patchFields.options = optionsResult

    await db
      .update(container)
      .set(patchFields)
      .where(eq(container.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/containers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'container', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'container', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(container).where(eq(container.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
