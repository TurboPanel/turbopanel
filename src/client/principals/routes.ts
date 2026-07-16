import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { assignment, principal } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

const PRINCIPAL_KINDS = new Set(['system', 'database'])
const PRINCIPAL_PROVIDERS = new Set(['pam', 'postgres', 'mysql', 'redis'])
const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function requireUuidParam(
  c: Context<AppEnv>,
  value: string,
): string | Response {
  if (!isUuid(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

const PRINCIPAL_SELECT = {
  id: principal.id,
  kind: principal.kind,
  provider: principal.provider,
  username: principal.username,
  metadata: principal.metadata,
  options: principal.options,
  createdAt: principal.createdAt,
  updatedAt: principal.updatedAt,
}

type PrincipalRow = {
  id: string
  kind: string
  provider: string
  username: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

function parseUsername(
  c: Context<AppEnv>,
  value: unknown,
): string | Response {
  if (typeof value !== 'string' || !value || value.length > 255 || !USERNAME_RE.test(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

function parseKind(c: Context<AppEnv>, value: unknown): string | Response {
  if (typeof value !== 'string' || !PRINCIPAL_KINDS.has(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

function parseProvider(c: Context<AppEnv>, value: unknown): string | Response {
  if (typeof value !== 'string' || !PRINCIPAL_PROVIDERS.has(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

function parseServiceIds(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): string[] | Response {
  const value = body.serviceIds
  if (!Array.isArray(value) || value.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || !isUuid(entry)) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    ids.push(entry)
  }
  return [...new Set(ids)].toSorted((a, b) => a.localeCompare(b))
}

function rejectPasswordField(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Response | undefined {
  if (body.password !== undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }
}

async function assertServicesWritableInOrg(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  serviceIds: string[],
): Promise<Response | null> {
  for (const serviceId of serviceIds) {
    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
    if (!serviceOrgId || serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }
    const denied = await assertCanCreateOr403(c, 'service', serviceId)
    if (denied) return denied
  }
  return null
}

async function loadServiceIdsByPrincipal(
  db: Db,
  principalIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (principalIds.length === 0) return map

  const rows = await db
    .select({
      principalId: assignment.principalId,
      serviceId: assignment.serviceId,
    })
    .from(assignment)
    .where(inArray(assignment.principalId, principalIds))

  for (const row of rows) {
    const list = map.get(row.principalId) ?? []
    list.push(row.serviceId)
    map.set(row.principalId, list)
  }

  for (const [principalId, serviceIds] of map) {
    const sorted = serviceIds.toSorted((a, b) => a.localeCompare(b))
    map.set(principalId, sorted)
  }
  return map
}

function enrichPrincipal(
  row: PrincipalRow,
  serviceIdsByPrincipal: Map<string, string[]>,
) {
  return {
    ...row,
    serviceIds: serviceIdsByPrincipal.get(row.id) ?? [],
  }
}

async function replaceAssignments(
  tx: Db,
  principalId: string,
  nextServiceIds: string[],
): Promise<void> {
  const existing = await tx
    .select({ serviceId: assignment.serviceId })
    .from(assignment)
    .where(eq(assignment.principalId, principalId))

  const current = new Set(existing.map((row) => row.serviceId))
  const next = new Set(nextServiceIds)

  const toDelete = [...current].filter((id) => !next.has(id))
  const toInsert = [...next].filter((id) => !current.has(id))

  if (toDelete.length > 0) {
    await tx
      .delete(assignment)
      .where(
        and(
          eq(assignment.principalId, principalId),
          inArray(assignment.serviceId, toDelete),
        ),
      )
  }

  if (toInsert.length > 0) {
    await tx.insert(assignment).values(
      toInsert.map((serviceId) => ({
        principalId,
        serviceId,
      })),
    )
  }
}

type PrincipalPatchFields = {
  kind?: string
  provider?: string
  username?: string
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

type PrincipalPatchPlan = {
  updateFields: PrincipalPatchFields
  nextServiceIds?: string[]
}

function applyOptionalStringPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  field: 'kind' | 'provider' | 'username',
  parse: (c: Context<AppEnv>, value: unknown) => string | Response,
  updateFields: PrincipalPatchFields,
): Response | undefined {
  if (body[field] === undefined) return
  const parsed = parse(c, body[field])
  if (parsed instanceof Response) return parsed
  updateFields[field] = parsed
}

async function buildPrincipalPatchPlan(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<PrincipalPatchPlan | Response> {
  const passwordRejected = rejectPasswordField(c, body)
  if (passwordRejected) return passwordRejected

  const updateFields: PrincipalPatchFields = {
    updatedAt: new Date().toISOString(),
  }

  const kindError = applyOptionalStringPatch(c, body, 'kind', parseKind, updateFields)
  if (kindError) return kindError

  const providerError = applyOptionalStringPatch(
    c,
    body,
    'provider',
    parseProvider,
    updateFields,
  )
  if (providerError) return providerError

  const usernameError = applyOptionalStringPatch(
    c,
    body,
    'username',
    parseUsername,
    updateFields,
  )
  if (usernameError) return usernameError

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) updateFields.metadata = metadataResult

  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult !== null) updateFields.options = optionsResult

  let nextServiceIds: string[] | undefined
  if (body.serviceIds !== undefined) {
    const serviceIds = parseServiceIds(c, body)
    if (serviceIds instanceof Response) return serviceIds
    const servicesDenied = await assertServicesWritableInOrg(
      c,
      db,
      organizationId,
      serviceIds,
    )
    if (servicesDenied) return servicesDenied
    nextServiceIds = serviceIds
  }

  if (Object.keys(updateFields).length === 1 && nextServiceIds === undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { updateFields, nextServiceIds }
}

export function registerPrincipalRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for principal routes')
  }
  const secrets = opts.secrets

  router.use('/principals', createSessionMiddleware(secrets))
  router.use('/principals/:id', createSessionMiddleware(secrets))
  router.use('/principals/:id/password', createSessionMiddleware(secrets))

  router.get('/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'principal',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ principals: [] })
    }

    let principalIds = visibleIds
    const serviceIdFilter = c.req.query('serviceId')
    if (serviceIdFilter) {
      if (!isUuid(serviceIdFilter)) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      const assigned = await db
        .select({ principalId: assignment.principalId })
        .from(assignment)
        .where(
          and(
            eq(assignment.serviceId, serviceIdFilter),
            inArray(assignment.principalId, visibleIds),
          ),
        )
      principalIds = [...new Set(assigned.map((row) => row.principalId))]
      if (principalIds.length === 0) {
        return c.json({ principals: [] })
      }
    }

    const rows = await db
      .select(PRINCIPAL_SELECT)
      .from(principal)
      .where(inArray(principal.id, principalIds))
      .orderBy(principal.createdAt)

    const serviceIdsByPrincipal = await loadServiceIdsByPrincipal(
      db,
      rows.map((row) => row.id),
    )

    return c.json({
      principals: rows.map((row) => enrichPrincipal(row, serviceIdsByPrincipal)),
    })
  })

  router.get('/principals/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = requireUuidParam(c, c.req.param('id'))
    if (id instanceof Response) return id
    const entityOrgId = await resolveEntityOrganizationId(db, 'principal', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'principal', id)
    if (denied) return denied

    const rows = await db
      .select(PRINCIPAL_SELECT)
      .from(principal)
      .where(eq(principal.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const serviceIdsByPrincipal = await loadServiceIdsByPrincipal(db, [id])
    return c.json({ principal: enrichPrincipal(row, serviceIdsByPrincipal) })
  })

  router.post('/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const passwordRejected = rejectPasswordField(c, body)
    if (passwordRejected) return passwordRejected

    const kind = parseKind(c, body.kind)
    if (kind instanceof Response) return kind

    const provider = parseProvider(c, body.provider)
    if (provider instanceof Response) return provider

    const username = parseUsername(c, body.username)
    if (username instanceof Response) return username

    const serviceIds = parseServiceIds(c, body)
    if (serviceIds instanceof Response) return serviceIds

    const servicesDenied = await assertServicesWritableInOrg(
      c,
      db,
      organizationId,
      serviceIds,
    )
    if (servicesDenied) return servicesDenied

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(principal)
        .values({
          kind,
          provider,
          username,
          ...(metadataResult !== null ? { metadata: metadataResult } : {}),
          ...(optionsResult !== null ? { options: optionsResult } : {}),
        })
        .returning({ id: principal.id })

      await tx.insert(assignment).values(
        serviceIds.map((serviceId) => ({
          principalId: inserted.id,
          serviceId,
        })),
      )

      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/principals/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = requireUuidParam(c, c.req.param('id'))
    if (id instanceof Response) return id
    const entityOrgId = await resolveEntityOrganizationId(db, 'principal', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'principal', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const plan = await buildPrincipalPatchPlan(c, db, organizationId, body)
    if (plan instanceof Response) return plan

    await db.transaction(async (tx) => {
      await tx
        .update(principal)
        .set(plan.updateFields)
        .where(eq(principal.id, id))
      if (plan.nextServiceIds !== undefined) {
        await replaceAssignments(tx, id, plan.nextServiceIds)
      }
    })

    return c.json({ ok: true as const })
  })

  router.post('/principals/:id/password', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = requireUuidParam(c, c.req.param('id'))
    if (id instanceof Response) return id
    const entityOrgId = await resolveEntityOrganizationId(db, 'principal', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'principal', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const password = requireStringField(c, body, 'password')
    if (password instanceof Response) return password

    // Future: seal this value as a tpsecret/tpdaemon envelope and decrypt only
    // via the daemon secrets path (`POST /api/daemon/v1/secrets/decrypt`). For
    // now the plaintext is persisted write-only — never returned by any GET.
    await db
      .update(principal)
      .set({
        password,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(principal.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/principals/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = requireUuidParam(c, c.req.param('id'))
    if (id instanceof Response) return id
    const entityOrgId = await resolveEntityOrganizationId(db, 'principal', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'principal', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(principal).where(eq(principal.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
