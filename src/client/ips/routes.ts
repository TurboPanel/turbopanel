import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { hosting, ip, peer } from '../../lib/db/schema.ts'
import { parseIpVersion } from '../../lib/ip-address.ts'
import { isAddressInVpnCidr } from '../../lib/net/vpn-address-allocator.ts'
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
import {
  assertIpScopeFkRules,
  isIpAddressUniqueViolation,
  parseCreateIpAddress,
  type IpScopeFks,
} from './ip-create-validation.ts'

export {
  assertIpScopeFkRules,
  isIpAddressUniqueViolation,
  parseCreateIpAddress,
} from './ip-create-validation.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const IP_ALLOCATIONS = new Set(['dedicated', 'shared'])
const IP_SCOPES = new Set(['public', 'datacenter', 'loopback', 'vpn'])

const IP_SELECT = {
  id: ip.id,
  organizationId: ip.organizationId,
  datacenterId: ip.datacenterId,
  networkId: ip.networkId,
  serverId: ip.serverId,
  vpnId: ip.vpnId,
  address: ip.address,
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
  ['vpnId', 'vpn'],
] as const

type IpScopeFkField = (typeof IP_SCOPE_FK_FIELDS)[number][0]
type IpScopeFkKind = (typeof IP_SCOPE_FK_FIELDS)[number][1]

type CreateIpFields = {
  address: string
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
  vpnId?: string | null
  updatedAt: string
}

type IpRow = {
  id: string
  organizationId: string
  datacenterId: string | null
  networkId: string | null
  serverId: string | null
  vpnId: string | null
  address: string
  allocation: string
  scope: string
  displayName: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

function serializeIpRow(row: IpRow) {
  return {
    ...row,
    version: parseIpVersion(row.address),
  }
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
  queryKey: 'datacenterId' | 'serverId' | 'networkId' | 'vpnId',
  kind: 'datacenter' | 'server' | 'network' | 'vpn',
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
    ['vpnId', 'vpn'],
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

/**
 * Validate that a `scope='vpn'` address falls inside its VPN's overlay CIDR —
 * the same containment rule enforced for peer tunnel-IP assignment
 * (`isAddressInVpnCidr` in `vpn-address-allocator.ts`).
 */
async function assertVpnScopedAddressInCidr(
  c: Context,
  db: Db,
  vpnId: string,
  address: string,
): Promise<Response | null> {
  const inCidr = await isAddressInVpnCidr(db, vpnId, address)
  if (!inCidr) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return null
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

  const scopeDenied = assertIpScopeFkRules(c, enums.scope, scopeFks)
  if (scopeDenied) return scopeDenied

  if (enums.scope === 'vpn' && scopeFks.vpnId) {
    const cidrDenied = await assertVpnScopedAddressInCidr(
      c,
      db,
      scopeFks.vpnId,
      addressFields.address,
    )
    if (cidrDenied) return cidrDenied
  }

  return {
    ...addressFields,
    ...enums,
    displayName,
    metadata,
    options,
    ...scopeFks,
  }
}

type ExistingIpScope = {
  scope: string
  vpnId: string | null
  serverId: string | null
  datacenterId: string | null
  networkId: string | null
  address: string
}

function rejectImmutableIpPatchFields(
  c: Context,
  body: Record<string, unknown>,
): Response | null {
  const immutable = ['address', 'version', 'allocation', 'scope'] as const
  if (immutable.some((key) => body[key] !== undefined)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return null
}

function applyJsonbPatchFields(
  c: Context,
  body: Record<string, unknown>,
  patchFields: IpPatchFields,
): Response | null {
  for (const key of ['metadata', 'options'] as const) {
    const result = parseJsonbObject(c, body, key)
    if (result instanceof Response) return result
    if (result !== null) patchFields[key] = result
  }
  return null
}

/** Final FK values = existing row plus incoming patch (undefined keeps prior). */
function mergeIpScopeFks(
  existing: ExistingIpScope,
  scopeFks: IpScopeFks,
): IpScopeFks {
  return {
    vpnId: scopeFks.vpnId !== undefined ? scopeFks.vpnId : existing.vpnId,
    serverId: scopeFks.serverId !== undefined ? scopeFks.serverId : existing.serverId,
    datacenterId: scopeFks.datacenterId !== undefined
      ? scopeFks.datacenterId
      : existing.datacenterId,
    networkId: scopeFks.networkId !== undefined
      ? scopeFks.networkId
      : existing.networkId,
  }
}

async function assertVpnIpPatchRules(
  c: Context,
  db: Db,
  existing: ExistingIpScope,
  finalScopeFks: IpScopeFks,
): Promise<Response | null> {
  if (existing.scope !== 'vpn') return null

  // Explicitly reject clearing vpnId on a vpn-scoped row (CHECK would 500).
  if (finalScopeFks.vpnId === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (!finalScopeFks.vpnId) return null

  return await assertVpnScopedAddressInCidr(
    c,
    db,
    finalScopeFks.vpnId,
    existing.address,
  )
}

async function buildIpPatchFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  existing: ExistingIpScope,
): Promise<IpPatchFields | Response> {
  const immutableDenied = rejectImmutableIpPatchFields(c, body)
  if (immutableDenied) return immutableDenied

  let patchFields: IpPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const jsonbDenied = applyJsonbPatchFields(c, body, patchFields)
  if (jsonbDenied) return jsonbDenied

  const scopeFks = await resolveIpScopeFks(c, db, organizationId, body)
  if (scopeFks instanceof Response) return scopeFks

  const finalScopeFks = mergeIpScopeFks(existing, scopeFks)

  // Reuse create-time scope/FK rules against the post-patch shape.
  const scopeDenied = assertIpScopeFkRules(c, existing.scope, finalScopeFks)
  if (scopeDenied) return scopeDenied

  const vpnDenied = await assertVpnIpPatchRules(c, db, existing, finalScopeFks)
  if (vpnDenied) return vpnDenied

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

    return c.json({ ips: rows.map((row) => serializeIpRow(row)) })
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

    return c.json({ ip: serializeIpRow(row) })
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
            ...(fields.vpnId !== undefined ? { vpnId: fields.vpnId } : {}),
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

    const [existingIp] = await db
      .select({
        scope: ip.scope,
        vpnId: ip.vpnId,
        serverId: ip.serverId,
        datacenterId: ip.datacenterId,
        networkId: ip.networkId,
        address: ip.address,
      })
      .from(ip)
      .where(eq(ip.id, id))
      .limit(1)
    if (!existingIp) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patchFields = await buildIpPatchFields(
      c,
      db,
      organizationId,
      body,
      existingIp,
    )
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

    const [peerTunnelRow] = await db
      .select({ id: peer.id })
      .from(peer)
      .where(eq(peer.tunnelIpId, id))
      .limit(1)
    if (peerTunnelRow) {
      return c.json({ error: 'ip_in_use' }, 409)
    }

    await db.delete(ip).where(eq(ip.id, id))

    return c.json({ ok: true as const })
  })
}
