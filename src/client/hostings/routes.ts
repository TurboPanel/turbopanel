import { and, eq, inArray } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { hosting } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseName,
  parseDescription,
  parseJsonBody,
  parseJsonbObject,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  assertCreateHostingBindScope,
  assertMergedHostingBindScope,
  buildHostingPatchFields,
  parseCreateServiceId,
  parseOptionalHostingOptions,
  resolveOptionalHostingFks,
} from './routes-helpers.ts'

export function registerHostingRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  const secrets = opts.secrets

  router.use('/hostings', createSessionMiddleware(secrets))
  router.use('/hostings/:id', createSessionMiddleware(secrets))

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
        name: hosting.name,
        description: hosting.description,
        serviceId: hosting.serviceId,
        tlsId: hosting.tlsId,
        ipId: hosting.ipId,
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
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select({
        id: hosting.id,
        name: hosting.name,
        description: hosting.description,
        serviceId: hosting.serviceId,
        tlsId: hosting.tlsId,
        ipId: hosting.ipId,
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

    const serviceId = parseCreateServiceId(body)
    if (!serviceId) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
    if (serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'service', serviceId)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', serviceId)
    if (immutable) return immutable

    let name: string | null
    let description: string | null
    try {
      name = parseName(body)
      description = parseDescription(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult

    const optionsResult = parseOptionalHostingOptions(c, body)
    if (optionsResult.kind === 'error') return optionsResult.response
    const validatedOptions = optionsResult.kind === 'value' ? optionsResult.value : null

    const fks = await resolveOptionalHostingFks(c, db, organizationId, body)
    if (fks.kind === 'error') return fks.response

    const scopeDenied = await assertCreateHostingBindScope(
      c,
      db,
      fks.ipId,
      validatedOptions,
    )
    if (scopeDenied) return scopeDenied

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(hosting)
        .values({
          name,
          description,
          serviceId,
          ...(fks.tlsId.kind === 'value' ? { tlsId: fks.tlsId.value } : {}),
          ...(fks.ipId.kind === 'value' ? { ipId: fks.ipId.value } : {}),
          ...(metadataResult !== null ? { metadata: metadataResult } : {}),
          ...(validatedOptions !== null ? { options: validatedOptions } : {}),
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
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'hosting', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'hosting', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const [existingHosting] = await db
      .select({ ipId: hosting.ipId, options: hosting.options })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    if (!existingHosting) return c.json({ error: 'Not found' }, 404)

    const patchFields = await buildHostingPatchFields(c, db, organizationId, body)
    if (patchFields instanceof Response) return patchFields

    const scopeDenied = await assertMergedHostingBindScope(
      c,
      db,
      existingHosting,
      patchFields,
    )
    if (scopeDenied) return scopeDenied

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
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'hosting', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'hosting', id)
    if (immutable) return immutable

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(hosting).where(eq(hosting.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
