import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { hosting } from '../../lib/db/schema.ts'
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
import { parseHostingOptions } from '../../lib/hosting-options.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type OptionalTlsIdResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: string | null }
  | { kind: 'error'; response: Response }

async function parseOptionalTlsId(
  c: Context,
  db: Db,
  organizationId: string,
  tlsIdRaw: unknown,
): Promise<OptionalTlsIdResult> {
  if (tlsIdRaw === undefined) return { kind: 'absent' }
  if (tlsIdRaw === null) return { kind: 'value', value: null }
  if (typeof tlsIdRaw === 'string' && UUID_RE.test(tlsIdRaw)) {
    const tlsOrgId = await resolveEntityOrganizationId(db, 'tls', tlsIdRaw)
    if (tlsOrgId !== organizationId) {
      return { kind: 'error', response: c.json({ error: 'Not found' }, 404) }
    }
    return { kind: 'value', value: tlsIdRaw }
  }
  return { kind: 'error', response: c.json({ error: 'Invalid request' }, 400) }
}

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
    if (entityOrgId !== organizationId) {
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
    if (serviceOrgId !== organizationId) {
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

    let validatedOptions: Record<string, unknown> | null = null
    if (optionsResult !== null) {
      const parsed = parseHostingOptions(optionsResult)
      if (parsed === null) return c.json({ error: 'invalid_hosting_options' }, 400)
      validatedOptions = parsed
    }

    const tlsIdResult = await parseOptionalTlsId(c, db, organizationId, body.tlsId)
    if (tlsIdResult.kind === 'error') return tlsIdResult.response

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(hosting)
        .values({
          displayName,
          description,
          serviceId,
          ...(tlsIdResult.kind === 'value' ? { tlsId: tlsIdResult.value } : {}),
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
    if (optionsResult !== null) {
      const parsed = parseHostingOptions(optionsResult)
      if (parsed === null) return c.json({ error: 'invalid_hosting_options' }, 400)
      patchFields.options = parsed
    }

    const tlsIdResult = await parseOptionalTlsId(c, db, organizationId, body.tlsId)
    if (tlsIdResult.kind === 'error') return tlsIdResult.response
    if (tlsIdResult.kind === 'value') patchFields.tlsId = tlsIdResult.value

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

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(hosting).where(eq(hosting.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
