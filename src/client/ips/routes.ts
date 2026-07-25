import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { hosting, ip } from '../../lib/db/schema.ts'
import {
  deriveIpVersion,
  isValidIpAddress,
} from '../../lib/ip-address.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
  parseJsonbObject,
} from '../shared.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const IP_ALLOCATIONS = new Set(['dedicated', 'shared'])
const IP_SCOPES = new Set(['public', 'datacenter', 'loopback'])

const IP_SELECT = {
  id: ip.id,
  organizationId: ip.organizationId,
  datacenterId: ip.datacenterId,
  networkId: ip.networkId,
  serverId: ip.serverId,
  address: ip.address,
  version: ip.version,
  allocation: ip.allocation,
  scope: ip.scope,
  displayName: ip.displayName,
  metadata: ip.metadata,
  options: ip.options,
  createdAt: ip.createdAt,
  updatedAt: ip.updatedAt,
}

const IP_SCOPE_FK_FIELDS = [
  ['datacenterId', 'datacenter'],
  ['networkId', 'network'],
  ['serverId', 'server'],
] as const

type IpScopeFkField = (typeof IP_SCOPE_FK_FIELDS)[number][0]
type IpScopeFkKind = (typeof IP_SCOPE_FK_FIELDS)[number][1]

type IpScopeFks = {
  datacenterId?: string | null
  networkId?: string | null
  serverId?: string | null
}

type CreateIpFields = {
  address: string
  version: number
  allocation: string
  scope: string
  displayName: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
} & IpScopeFks

type IpPatchFields = {
  displayName?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  datacenterId?: string | null
  networkId?: string | null
  serverId?: string | null
  updatedAt: string
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function isIpAddressUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_ip_org_address')
}

async function assertSameOrgEntity(
  c: Context,
  db: Db,
  kind: Parameters<typeof resolveEntityOrganizationId>[1],
  entityId: string,
  organizationId: string,
): Promise<Response | null> {
  const entityOrgId = await resolveEntityOrganizationId(db, kind, entityId)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return null
}

async function validateOptionalScopeFk(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  field: IpScopeFkField,
  kind: IpScopeFkKind,
): Promise<string | null | undefined | Response> {
  if (body[field] === undefined) return undefined
  if (body[field] === null) return null
  if (typeof body[field] !== 'string' || !UUID_RE.test(body[field])) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const id = body[field]
  const denied = await assertSameOrgEntity(c, db, kind, id, organizationId)
  if (denied) return denied
  return id
}

async function resolveIpScopeFks(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<IpScopeFks | Response> {
  const result: IpScopeFks = {}
  for (const [field, kind] of IP_SCOPE_FK_FIELDS) {
    const value = await validateOptionalScopeFk(
      c,
      db,
      organizationId,
      body,
      field,
      kind,
    )
    if (value instanceof Response) return value
    if (value !== undefined) result[field] = value
  }
  return result
}

async function appendOrgScopedIdFilter(
  c: Context,
  db: Db,
  organizationId: string,
  conditions: SQL[],
  queryKey: 'datacenterId' | 'serverId' | 'networkId',
  kind: 'datacenter' | 'server' | 'network',
): Promise<Response | null> {
  const raw = c.req.query(queryKey)?.trim()
  if (!raw) return null
  if (!UUID_RE.test(raw)) return c.json({ error: 'Invalid request' }, 400)
  const denied = await assertSameOrgEntity(c, db, kind, raw, organizationId)
  if (denied) return denied
  conditions.push(eq(ip[queryKey], raw))
  return null
}

function appendEnumQueryFilter(
  c: Context,
  conditions: SQL[],
  queryKey: 'scope' | 'allocation',
  allowed: Set<string>,
): Response | null {
  const raw = c.req.query(queryKey)?.trim()
  if (!raw) return null
  if (!allowed.has(raw)) return c.json({ error: 'Invalid request' }, 400)
  conditions.push(eq(ip[queryKey], raw))
  return null
}

async function buildIpListConditions(
  c: Context,
  db: Db,
  organizationId: string,
  visibleIds: string[],
): Promise<SQL[] | Response> {
  const conditions: SQL[] = [
    inArray(ip.id, visibleIds),
    eq(ip.organizationId, organizationId),
  ]

  for (const [queryKey, kind] of [
    ['datacenterId', 'datacenter'],
    ['serverId', 'server'],
    ['networkId', 'network'],
  ] as const) {
    const denied = await appendOrgScopedIdFilter(
      c,
      db,
      organizationId,
      conditions,
      queryKey,
      kind,
    )
    if (denied) return denied
  }

  const scopeDenied = appendEnumQueryFilter(c, conditions, 'scope', IP_SCOPES)
  if (scopeDenied) return scopeDenied

  const allocationDenied = appendEnumQueryFilter(
    c,
    conditions,
    'allocation',
    IP_ALLOCATIONS,
  )
  if (allocationDenied) return allocationDenied

  return conditions
}

function parseCreateIpAddress(
  c: Context,
  body: Record<string, unknown>,
): { address: string; version: number } | Response {
  const addressRaw = body.address
  if (typeof addressRaw !== 'string' || !isValidIpAddress(addressRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const address = addressRaw.trim()
  const version = deriveIpVersion(address)
  if (version === null) return c.json({ error: 'Invalid request' }, 400)

  if (body.version !== undefined) {
    if (typeof body.version !== 'number' || body.version !== version) {
      return c.json({ error: 'Invalid request' }, 400)
    }
  }

  return { address, version }
}

function parseCreateIpEnums(
  c: Context,
  body: Record<string, unknown>,
): { allocation: string; scope: string } | Response {
  const allocation = body.allocation
  if (typeof allocation !== 'string' || !IP_ALLOCATIONS.has(allocation)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const scope = body.scope
  if (typeof scope !== 'string' || !IP_SCOPES.has(scope)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { allocation, scope }
}

async function parseCreateIpFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<CreateIpFields | Response> {
  const addressFields = parseCreateIpAddress(c, body)
  if (addressFields instanceof Response) return addressFields

  const enums = parseCreateIpEnums(c, body)
  if (enums instanceof Response) return enums

  let displayName: string | null
  try {
    displayName = parseDisplayName(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadata = parseJsonbObject(c, body, 'metadata')
  if (metadata instanceof Response) return metadata
  const options = parseJsonbObject(c, body, 'options')
  if (options instanceof Response) return options

  const scopeFks = await resolveIpScopeFks(c, db, organizationId, body)
  if (scopeFks instanceof Response) return scopeFks

  return {
    ...addressFields,
    ...enums,
    displayName,
    metadata,
    options,
    ...scopeFks,
  }
}

async function buildIpPatchFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<IpPatchFields | Response> {
  if (
    body.address !== undefined ||
    body.version !== undefined ||
    body.allocation !== undefined ||
    body.scope !== undefined
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  let patchFields: IpPatchFields
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

  const scopeFks = await resolveIpScopeFks(c, db, organizationId, body)
  if (scopeFks instanceof Response) return scopeFks
  Object.assign(patchFields, scopeFks)

  return patchFields
}

export function registerIpRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for ip routes')
  }
  const secrets = opts.secrets

  router.use('/ips', createSessionMiddleware(secrets))
  router.use('/ips/:id', createSessionMiddleware(secrets))

  router.get('/ips', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const manageDenied = await assertCanManageOr403(c, 'organization', organizationId)
    if (manageDenied) return manageDenied

    const visibleIds = await listVisible(db, {
      kind: 'ip',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ ips: [] })
    }

    const conditions = await buildIpListConditions(
      c,
      db,
      organizationId,
      visibleIds,
    )
    if (conditions instanceof Response) return conditions

    const rows = await db
      .select(IP_SELECT)
      .from(ip)
      .where(and(...conditions))
      .orderBy(ip.createdAt)

    return c.json({ ips: rows })
  })

  router.get('/ips/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'ip', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'ip', id)
    if (denied) return denied

    const [row] = await db
      .select(IP_SELECT)
      .from(ip)
      .where(eq(ip.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)

    return c.json({ ip: row })
  })

  router.post('/ips', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = await parseCreateIpFields(c, db, organizationId, body)
    if (fields instanceof Response) return fields

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(ip)
          .values({
            organizationId,
            address: fields.address,
            version: fields.version,
            allocation: fields.allocation,
            scope: fields.scope,
            displayName: fields.displayName,
            ...(fields.datacenterId !== undefined
              ? { datacenterId: fields.datacenterId }
              : {}),
            ...(fields.networkId !== undefined
              ? { networkId: fields.networkId }
              : {}),
            ...(fields.serverId !== undefined ? { serverId: fields.serverId } : {}),
            ...(fields.metadata !== null ? { metadata: fields.metadata } : {}),
            ...(fields.options !== null ? { options: fields.options } : {}),
          })
          .returning({ id: ip.id })
        return inserted.id
      })
      return c.json({ ok: true as const, id })
    } catch (err) {
      if (isIpAddressUniqueViolation(err)) {
        return c.json({ error: 'ip_address_in_use' }, 409)
      }
      throw err
    }
  })

  router.patch('/ips/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'ip', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'ip', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patchFields = await buildIpPatchFields(c, db, organizationId, body)
    if (patchFields instanceof Response) return patchFields

    await db.update(ip).set(patchFields).where(eq(ip.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/ips/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'ip', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'ip', id)
    if (denied) return denied

    const [hostingRow] = await db
      .select({ id: hosting.id })
      .from(hosting)
      .where(eq(hosting.ipId, id))
      .limit(1)
    if (hostingRow) {
      return c.json({ error: 'ip_in_use' }, 409)
    }

    await db.delete(ip).where(eq(ip.id, id))

    return c.json({ ok: true as const })
  })
}
