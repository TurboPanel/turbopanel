import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { container, server, service } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  parseCreateContainerFields,
  parsePatchContainerFields,
  serializeContainer,
} from './routes-helpers.ts'

const CONTAINER_SELECT = {
  id: container.id,
  serviceId: container.serviceId,
  serverId: container.serverId,
  containerId: container.containerId,
  containerName: container.containerName,
  status: container.status,
  role: container.role,
  composeServiceName: container.composeServiceName,
  ordinal: container.ordinal,
  metadata: container.metadata,
  options: container.options,
  createdAt: container.createdAt,
  updatedAt: container.updatedAt,
} as const

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
    const status = c.req.query('status')
    const environmentId = c.req.query('environmentId')

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
    if (status) {
      conditions.push(eq(container.status, status))
    }
    if (environmentId) {
      conditions.push(
        inArray(
          container.serviceId,
          db.select({ id: service.id }).from(service).where(
            eq(service.environmentId, environmentId),
          ),
        ),
      )
    }

    const rows = await db
      .select(CONTAINER_SELECT)
      .from(container)
      .where(and(...conditions))
      .orderBy(container.createdAt)

    return c.json({ containers: rows.map(serializeContainer) })
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
      .select(CONTAINER_SELECT)
      .from(container)
      .where(eq(container.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'container', id)
    if (denied) return denied

    return c.json({ container: serializeContainer(row) })
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

    const parsed = parseCreateContainerFields(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }
    const fields = parsed.fields

    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', fields.serviceId)
    if (!serviceOrgId || serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const serverRows = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, fields.serverId))
      .limit(1)

    const serverOrgId = serverRows[0]?.organizationId
    if (!serverOrgId || serverOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'service', fields.serviceId)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', fields.serviceId)
    if (immutable) return immutable

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(container)
        .values({
          serviceId: fields.serviceId,
          serverId: fields.serverId,
          containerId: fields.containerId,
          containerName: fields.containerName,
          status: fields.status,
          composeServiceName: fields.composeServiceName,
          ordinal: fields.ordinal,
          ...(fields.metadata !== null ? { metadata: fields.metadata } : {}),
          ...(fields.options !== null ? { options: fields.options } : {}),
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

    const immutable = await assertNotSystemOwnedOr403(c, 'container', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parsePatchContainerFields(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }
    const patchFields = parsed.patch

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

    const immutable = await assertNotSystemOwnedOr403(c, 'container', id)
    if (immutable) return immutable

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(container).where(eq(container.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
