import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { ip, peer, server, vpn } from '../db/schema.ts'
import { inetAddressToString } from '../ip-address.ts'

export type PrivateEndpointTransport = 'local' | 'datacenter' | 'vpn'

export type ResolvedPrivateEndpoint = {
  address: string
  transport: PrivateEndpointTransport
  /** Present when transport is `datacenter`. */
  datacenterId?: string
  /** Present when transport is `vpn`. */
  vpnId?: string
}

export type PrivateEndpointError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'peer_tunnel_address_required'; peerId: string }
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

type PeerJoinRow = {
  peerId: string
  serverId: string
  vpnId: string
  vpnCreatedAt: string
  tunnelIpId: string | null
  tunnelAddress: string | null
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
 * Shared-VPN peers for the given server ids. Returns all peer rows on VPNs
 * that include at least one of the listed servers (caller filters to shared).
 */
async function loadVpnPeerRows(
  db: Db,
  serverIds: string[],
): Promise<PeerJoinRow[]> {
  if (serverIds.length === 0) return []

  const membership = await db
    .select({ vpnId: peer.vpnId })
    .from(peer)
    .where(inArray(peer.serverId, serverIds))

  const vpnIds = [...new Set(membership.map((row) => row.vpnId))]
  if (vpnIds.length === 0) return []

  const rows = await db
    .select({
      peerId: peer.id,
      serverId: peer.serverId,
      vpnId: peer.vpnId,
      vpnCreatedAt: vpn.createdAt,
      tunnelIpId: peer.tunnelIpId,
      tunnelAddress: ip.address,
    })
    .from(peer)
    .innerJoin(vpn, eq(peer.vpnId, vpn.id))
    .leftJoin(ip, eq(peer.tunnelIpId, ip.id))
    .where(inArray(peer.vpnId, vpnIds))
    .orderBy(asc(vpn.createdAt))

  return rows.map((row) => ({
    peerId: row.peerId,
    serverId: row.serverId,
    vpnId: row.vpnId,
    vpnCreatedAt: row.vpnCreatedAt,
    tunnelIpId: row.tunnelIpId,
    tunnelAddress: inetAddressToString(row.tunnelAddress) ?? null,
  }))
}

function resolveOneFromCaches(params: {
  fromServerId: string
  toServerId: string
  datacenterByServer: Map<string, string | null>
  addressByServer: Map<string, string>
  peers: PeerJoinRow[]
}): ResolvedPrivateEndpoint | PrivateEndpointError {
  if (params.fromServerId === params.toServerId) {
    return { address: '127.0.0.1', transport: 'local' }
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

  const fromVpnIds = new Set(
    params.peers
      .filter((row) => row.serverId === params.fromServerId)
      .map((row) => row.vpnId),
  )
  const sharedOnTo = params.peers
    .filter(
      (row) =>
        row.serverId === params.toServerId && fromVpnIds.has(row.vpnId),
    )
    .sort((a, b) => a.vpnCreatedAt.localeCompare(b.vpnCreatedAt))

  const chosen = sharedOnTo[0]
  if (!chosen) {
    return {
      kind: 'private_path_unavailable',
      fromServerId: params.fromServerId,
      toServerId: params.toServerId,
    }
  }
  if (!chosen.tunnelAddress) {
    return { kind: 'peer_tunnel_address_required', peerId: chosen.peerId }
  }
  return {
    address: chosen.tunnelAddress,
    transport: 'vpn',
    vpnId: chosen.vpnId,
  }
}

/**
 * Answer "what address does `fromServerId` use to reach `toServerId`?" using
 * transport order local → datacenter → vpn.
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
 * ip query, one peer join — no N+1).
 */
export async function resolvePrivateEndpoints(
  db: Db,
  params: Readonly<{ fromServerId: string; toServerIds: readonly string[] }>,
): Promise<Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>> {
  const out = new Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>()
  if (params.toServerIds.length === 0) return out

  const uniqueTargets = [...new Set(params.toServerIds)]
  const allServerIds = [...new Set([params.fromServerId, ...uniqueTargets])]

  const [datacenterByServer, addressByServer, peers] = await Promise.all([
    loadServerDatacenterIds(db, allServerIds),
    loadDatacenterAddresses(db, allServerIds),
    loadVpnPeerRows(db, allServerIds),
  ])

  for (const toServerId of uniqueTargets) {
    out.set(
      toServerId,
      resolveOneFromCaches({
        fromServerId: params.fromServerId,
        toServerId,
        datacenterByServer,
        addressByServer,
        peers,
      }),
    )
  }
  return out
}
