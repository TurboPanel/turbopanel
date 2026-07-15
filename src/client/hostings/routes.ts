import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { hosting, tls } from '../../lib/db/schema.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseDescription,
  parseJsonBody,
  parseJsonbObject,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

export function registerHostingRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/hostings', createSessionMiddleware(opts.secrets))
  router.use('/hostings/:id', createSessionMiddleware(opts.secrets))

  router.get('/hostings', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serviceId = c.req.query('serviceId')

    const visibleIds = await listVisible(db, {
      kind: 'hosting',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ hostings: [] })
    }

    const conditions = [inArray(hosting.id, visibleIds)]
    if (serviceId) {
      conditions.push(eq(hosting.serviceId, serviceId))
    }

    const rows = await db
      .select({
        id: hosting.id,
        displayName: hosting.displayName,
        description: hosting.description,
        serviceId: hosting.serviceId,
        tlsId: hosting.tlsId,
        metadata: hosting.metadata,
        options: hosting.options,
        createdAt: hosting.createdAt,
        updatedAt: hosting.updatedAt,
      })
      .from(hosting)
      .where(and(...conditions))
      .orderBy(hosting.createdAt)

    return c.json({ hostings: rows })
  })

  router.get('/hostings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'hosting', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select({
        id: hosting.id,
        displayName: hosting.displayName,
        description: hosting.description,
        serviceId: hosting.serviceId,
        tlsId: hosting.tlsId,
        metadata: hosting.metadata,
        options: hosting.options,
        createdAt: hosting.createdAt,
        updatedAt: hosting.updatedAt,
      })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'hosting', id)
    if (denied) return denied

    return c.json({ hosting: row })
  })

  router.post('/hostings', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const serviceIdRaw = body.serviceId
    if (typeof serviceIdRaw !== 'string' || serviceIdRaw.trim().length === 0) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    const serviceId = serviceIdRaw.trim()

    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
    if (!serviceOrgId || serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'service', serviceId)
    if (denied) return denied

    let displayName: string | null
    let description: string | null
    try {
      displayName = parseDisplayName(body)
      description = parseDescription(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult

    let tlsId: string | null | undefined
    if (body.tlsId !== undefined) {
      if (body.tlsId === null) {
        tlsId = null
      } else if (typeof body.tlsId === 'string' && UUID_RE.test(body.tlsId)) {
        const tlsOrgId = await resolveEntityOrganizationId(db, 'tls', body.tlsId)
        if (!tlsOrgId || tlsOrgId !== organizationId) {
          return c.json({ error: 'Not found' }, 404)
        }
        tlsId = body.tlsId
      } else {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(hosting)
        .values({
          displayName,
          description,
          serviceId,
          ...(tlsId !== undefined ? { tlsId } : {}),
          ...(metadataResult !== null ? { metadata: metadataResult } : {}),
          ...(optionsResult !== null ? { options: optionsResult } : {}),
        })
        .returning({ id: hosting.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/hostings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'hosting', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'hosting', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: {
      displayName?: string | null
      description?: string | null
      metadata?: Record<string, unknown> | null
      options?: Record<string, unknown> | null
      tlsId?: string | null
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

    if (body.tlsId !== undefined) {
      if (body.tlsId === null) {
        patchFields.tlsId = null
      } else if (typeof body.tlsId === 'string' && UUID_RE.test(body.tlsId)) {
        const [tlsRow] = await db
          .select({ id: tls.id, organizationId: tls.organizationId })
          .from(tls)
          .where(eq(tls.id, body.tlsId))
          .limit(1)
        if (!tlsRow || tlsRow.organizationId !== organizationId) {
          return c.json({ error: 'Not found' }, 404)
        }
        patchFields.tlsId = body.tlsId
      } else {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    await db
      .update(hosting)
      .set(patchFields)
      .where(eq(hosting.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/hostings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'hosting', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'hosting', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(hosting).where(eq(hosting.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
