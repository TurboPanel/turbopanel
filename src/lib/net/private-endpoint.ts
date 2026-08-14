import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { fabric, ip, relay, server } from '../db/schema.ts'
import { inetAddressToString } from '../ip-address.ts'

export type PrivateEndpointTransport = 'local' | 'datacenter' | 'fabric'

export type ResolvedPrivateEndpoint = {
  address: string
  transport: PrivateEndpointTransport
  /** Present when transport is `datacenter`. */
  datacenterId?: string
  /** Present when transport is `fabric`. */
  fabricId?: string
}

export type PrivateEndpointError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | {
    kind: 'private_path_unavailable'
    fromServerId: string
    toServerId: string
  }

export function isPrivateEndpointError(
  value: unknown,
): value is PrivateEndpointError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/**
 * Map a prepare error to a 422 JSON body with `{ error: kind }` only — never
 * leak id fields on the wire (mirrors managed `prepareErrorResponse`).
 */
export function privateEndpointErrorResponse(
  c: Context,
  error: PrivateEndpointError,
): Response {
  return c.json({ error: error.kind }, 422)
}

/** One `ip WHERE server_id AND scope='datacenter'` row (oldest first). */
export async function loadServerDatacenterAddress(
  db: Db,
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'datacenter')))
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

type ServerDcRow = {
  id: string
  datacenterId: string | null
}

type RelayJoinRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
}

async function loadServerDatacenterIds(
  db: Db,
  serverIds: string[],
): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>()
  if (serverIds.length === 0) return byId

  const rows = await db
    .select({
      id: server.id,
      datacenterId: server.datacenterId,
    })
    .from(server)
    .where(inArray(server.id, serverIds))

  for (const row of rows as ServerDcRow[]) {
    byId.set(row.id, row.datacenterId)
  }
  return byId
}

async function loadDatacenterAddresses(
  db: Db,
  serverIds: string[],
): Promise<Map<string, string>> {
  const byServer = new Map<string, string>()
  if (serverIds.length === 0) return byServer

  const rows = await db
    .select({
      serverId: ip.serverId,
      address: ip.address,
      createdAt: ip.createdAt,
    })
    .from(ip)
    .where(
      and(
        inArray(ip.serverId, serverIds),
        eq(ip.scope, 'datacenter'),
      ),
    )
    .orderBy(asc(ip.createdAt))

  for (const row of rows) {
    if (!row.serverId || byServer.has(row.serverId)) continue
    const address = inetAddressToString(row.address)
    if (address) byServer.set(row.serverId, address)
  }
  return byServer
}

/**
 * Relays on fabrics that include at least one of the listed servers.
 * The peer address is `relay.address` (no `ip` join).
 */
async function loadFabricRelayRows(
  db: Db,
  serverIds: string[],
): Promise<RelayJoinRow[]> {
  if (serverIds.length === 0) return []

  const membership = await db
    .select({ fabricId: relay.fabricId })
    .from(relay)
    .where(inArray(relay.serverId, serverIds))

  const fabricIds = [...new Set(membership.map((row) => row.fabricId))]
  if (fabricIds.length === 0) return []

  const rows = await db
    .select({
      relayId: relay.id,
      serverId: relay.serverId,
      fabricId: relay.fabricId,
      fabricCreatedAt: fabric.createdAt,
      address: relay.address,
    })
    .from(relay)
    .innerJoin(fabric, eq(relay.fabricId, fabric.id))
    .where(inArray(relay.fabricId, fabricIds))
    .orderBy(asc(fabric.createdAt))

  const out: RelayJoinRow[] = []
  for (const row of rows) {
    const address = inetAddressToString(row.address) ??
      (typeof row.address === 'string' ? row.address : String(row.address))
    if (!address) continue
    out.push({
      relayId: row.relayId,
      serverId: row.serverId,
      fabricId: row.fabricId,
      fabricCreatedAt: row.fabricCreatedAt,
      address,
    })
  }
  return out
}

/**
 * Ordered ladder: local → fabric → datacenter.
 * Same-host loopback first; a shared relay mesh takes the cross-host private
 * path; same-site datacenter IPs are the fallback when no fabric path exists.
 */
function resolveOneFromCaches(params: {
  fromServerId: string
  toServerId: string
  datacenterByServer: Map<string, string | null>
  addressByServer: Map<string, string>
  relays: RelayJoinRow[]
}): ResolvedPrivateEndpoint | PrivateEndpointError {
  if (params.fromServerId === params.toServerId) {
    return { address: '127.0.0.1', transport: 'local' }
  }

  const fromFabricIds = new Set(
    params.relays
      .filter((row) => row.serverId === params.fromServerId)
      .map((row) => row.fabricId),
  )
  const sharedOnTo = params.relays
    .filter(
      (row) =>
        row.serverId === params.toServerId && fromFabricIds.has(row.fabricId),
    )
    .sort((a, b) => a.fabricCreatedAt.localeCompare(b.fabricCreatedAt))

  const chosen = sharedOnTo[0]
  if (chosen) {
    return {
      address: chosen.address,
      transport: 'fabric',
      fabricId: chosen.fabricId,
    }
  }

  const fromDc = params.datacenterByServer.get(params.fromServerId) ?? null
  const toDc = params.datacenterByServer.get(params.toServerId) ?? null
  if (fromDc !== null && toDc !== null && fromDc === toDc) {
    const address = params.addressByServer.get(params.toServerId)
    if (!address) {
      return { kind: 'datacenter_ip_required', serverId: params.toServerId }
    }
    return {
      address,
      transport: 'datacenter',
      datacenterId: toDc,
    }
  }

  return {
    kind: 'private_path_unavailable',
    fromServerId: params.fromServerId,
    toServerId: params.toServerId,
  }
}

/**
 * Answer "what address does `fromServerId` use to reach `toServerId`?" using
 * transport order local → fabric → datacenter.
 */
export async function resolvePrivateEndpoint(
  db: Db,
  params: Readonly<{ fromServerId: string; toServerId: string }>,
): Promise<ResolvedPrivateEndpoint | PrivateEndpointError> {
  const results = await resolvePrivateEndpoints(db, {
    fromServerId: params.fromServerId,
    toServerIds: [params.toServerId],
  })
  const value = results.get(params.toServerId)
  if (!value) {
    return {
      kind: 'private_path_unavailable',
      fromServerId: params.fromServerId,
      toServerId: params.toServerId,
    }
  }
  return value
}

/**
 * Batched resolver for one source server → many targets (one server query, one
 * ip query, one relay join — no N+1).
 */
export async function resolvePrivateEndpoints(
  db: Db,
  params: Readonly<{ fromServerId: string; toServerIds: readonly string[] }>,
): Promise<Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>> {
  const out = new Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>()
  if (params.toServerIds.length === 0) return out

  const uniqueTargets = [...new Set(params.toServerIds)]
  const allServerIds = [...new Set([params.fromServerId, ...uniqueTargets])]

  const [datacenterByServer, addressByServer, relays] = await Promise.all([
    loadServerDatacenterIds(db, allServerIds),
    loadDatacenterAddresses(db, allServerIds),
    loadFabricRelayRows(db, allServerIds),
  ])

  for (const toServerId of uniqueTargets) {
    out.set(
      toServerId,
      resolveOneFromCaches({
        fromServerId: params.fromServerId,
        toServerId,
        datacenterByServer,
        addressByServer,
        relays,
      }),
    )
  }
  return out
}
