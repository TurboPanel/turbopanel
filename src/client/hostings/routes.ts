import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { hosting, ip } from '../../lib/db/schema.ts'
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
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import { parseHostingOptions, resolveHostingBind } from '../../lib/hosting-options.ts'

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

type OptionalIpIdResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: string | null }
  | { kind: 'error'; response: Response }

async function parseOptionalIpId(
  c: Context,
  db: Db,
  organizationId: string,
  ipIdRaw: unknown,
): Promise<OptionalIpIdResult> {
  if (ipIdRaw === undefined) return { kind: 'absent' }
  if (ipIdRaw === null) return { kind: 'value', value: null }
  if (typeof ipIdRaw === 'string' && UUID_RE.test(ipIdRaw)) {
    const ipOrgId = await resolveEntityOrganizationId(db, 'ip', ipIdRaw)
    if (ipOrgId !== organizationId) {
      return { kind: 'error', response: c.json({ error: 'Not found' }, 404) }
    }
    return { kind: 'value', value: ipIdRaw }
  }
  return { kind: 'error', response: c.json({ error: 'Invalid request' }, 400) }
}

async function assertHostingPublicBindScope(
  c: Context,
  db: Db,
  ipId: string,
  options: ReturnType<typeof parseHostingOptions> | null,
): Promise<Response | null> {
  const bind = resolveHostingBind(options ?? undefined)
  if (bind !== 'public') return null
  const [ipRow] = await db
    .select({ scope: ip.scope })
    .from(ip)
    .where(eq(ip.id, ipId))
    .limit(1)
  if (ipRow?.scope !== 'public') {
    return c.json({ error: 'hosting_bind_scope_mismatch' }, 400)
  }
  return null
}

type OptionalHostingOptionsResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: NonNullable<ReturnType<typeof parseHostingOptions>> }
  | { kind: 'error'; response: Response }

function parseOptionalHostingOptions(
  c: Context,
  body: Record<string, unknown>,
): OptionalHostingOptionsResult {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return { kind: 'error', response: optionsResult }
  if (optionsResult === null) return { kind: 'absent' }
  const parsed = parseHostingOptions(optionsResult)
  if (parsed === null) {
    return { kind: 'error', response: c.json({ error: 'invalid_hosting_options' }, 400) }
  }
  return { kind: 'value', value: parsed }
}

type HostingFkResult =
  | { kind: 'error'; response: Response }
  | {
    kind: 'ok'
    tlsId: Extract<OptionalTlsIdResult, { kind: 'absent' | 'value' }>
    ipId: Extract<OptionalIpIdResult, { kind: 'absent' | 'value' }>
  }

async function resolveOptionalHostingFks(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<HostingFkResult> {
  const tlsIdResult = await parseOptionalTlsId(c, db, organizationId, body.tlsId)
  if (tlsIdResult.kind === 'error') {
    return { kind: 'error', response: tlsIdResult.response }
  }
  const ipIdResult = await parseOptionalIpId(c, db, organizationId, body.ipId)
  if (ipIdResult.kind === 'error') {
    return { kind: 'error', response: ipIdResult.response }
  }
  return { kind: 'ok', tlsId: tlsIdResult, ipId: ipIdResult }
}

type HostingPatchFields = {
  displayName?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  tlsId?: string | null
  ipId?: string | null
  updatedAt: string
}

async function buildHostingPatchFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<HostingPatchFields | Response> {
  let patchFields: HostingPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) patchFields.metadata = metadataResult

  const optionsResult = parseOptionalHostingOptions(c, body)
  if (optionsResult.kind === 'error') return optionsResult.response
  if (optionsResult.kind === 'value') patchFields.options = optionsResult.value

  const fks = await resolveOptionalHostingFks(c, db, organizationId, body)
  if (fks.kind === 'error') return fks.response
  if (fks.tlsId.kind === 'value') patchFields.tlsId = fks.tlsId.value
  if (fks.ipId.kind === 'value') patchFields.ipId = fks.ipId.value

  return patchFields
}

async function assertCreateHostingBindScope(
  c: Context,
  db: Db,
  ipIdResult: Extract<OptionalIpIdResult, { kind: 'absent' | 'value' }>,
  options: ReturnType<typeof parseHostingOptions> | null,
): Promise<Response | null> {
  if (ipIdResult.kind !== 'value' || !ipIdResult.value) return null
  return assertHostingPublicBindScope(c, db, ipIdResult.value, options)
}

async function assertMergedHostingBindScope(
  c: Context,
  db: Db,
  existing: Readonly<{ ipId: string | null; options: unknown }>,
  patchFields: Readonly<{ ipId?: string | null; options?: Record<string, unknown> | null }>,
): Promise<Response | null> {
  const mergedOptions = patchFields.options === undefined
    ? parseHostingOptions(existing.options)
    : parseHostingOptions(patchFields.options)
  const effectiveIpId = patchFields.ipId === undefined
    ? existing.ipId
    : patchFields.ipId
  if (!effectiveIpId) return null
  return assertHostingPublicBindScope(c, db, effectiveIpId, mergedOptions)
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
        displayName: hosting.name,
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
        displayName: hosting.name,
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

    const immutable = await assertNotSystemOwnedOr403(c, 'service', serviceId)
    if (immutable) return immutable

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
          name: displayName,
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
