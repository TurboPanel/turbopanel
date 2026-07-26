import type { Context } from 'hono'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import { resealSecretForDaemon } from '../authn/data-encryption.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import type { WireguardApplyCommandPayload } from '../../lib/commands/schemas.ts'
import {
  deriveWireguardInterfaceName,
  isValidWireguardPublicKey,
  WIREGUARD_PERSISTENT_KEEPALIVE,
} from '../../lib/commands/wireguard.ts'
import { ip, network, peer, server, vpn } from '../../lib/db/schema.ts'
import { parseIpVersion, stripInetPrefixSuffix } from '../../lib/ip-address.ts'
import type { Db } from '../../db.ts'

export type VpnApplyPrepareError =
  | { kind: 'peer_tunnel_address_required'; peerId: string }
  | { kind: 'vpn_has_no_peers' }
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'gateway_datacenter_required'; peerId: string; serverId: string }
  | {
    kind: 'gateway_datacenter_cidr_required'
    peerId: string
    datacenterId: string
  }

export type PreparedVpnApply = {
  interfaceName: string
  payloads: Array<{
    serverId: string
    payload: WireguardApplyCommandPayload
  }>
}

function prefixLengthFromCidr(cidrValue: string): number | null {
  const slash = cidrValue.lastIndexOf('/')
  if (slash <= 0) return null
  const prefixPart = cidrValue.slice(slash + 1)
  if (!/^\d+$/.test(prefixPart)) return null
  return Number.parseInt(prefixPart, 10)
}

function hostRouteForTunnelAddress(tunnelAddress: string): string {
  const version = parseIpVersion(tunnelAddress)
  if (version === 6) return `${tunnelAddress}/128`
  return `${tunnelAddress}/32`
}

function formatInterfaceAddress(tunnelAddress: string, vpnCidr: string): string {
  const prefix = prefixLengthFromCidr(vpnCidr)
  if (prefix !== null) {
    return `${tunnelAddress}/${prefix}`
  }
  const version = parseIpVersion(tunnelAddress)
  if (version === 6) return `${tunnelAddress}/128`
  return `${tunnelAddress}/32`
}

function resolvePeerEndpoint(
  other: {
    endpoint: string | null
    listenPort: number | null
    ipAddress: string | null
  },
): string | undefined {
  if (other.endpoint && other.endpoint.length > 0) {
    return other.endpoint
  }
  if (other.ipAddress && other.listenPort !== null) {
    const version = parseIpVersion(other.ipAddress)
    if (version === 6) {
      return `[${other.ipAddress}]:${other.listenPort}`
    }
    return `${other.ipAddress}:${other.listenPort}`
  }
  return undefined
}

async function resealPeerPresharedForServer(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  sealed: string | null,
): Promise<string | undefined | VpnApplyPrepareError> {
  if (!sealed) return undefined

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  if (!dataEncryptionSecrets || !secretsConfig) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const envelope = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    sealed,
  )
  return envelope
}

function isPrepareError(value: unknown): value is VpnApplyPrepareError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

async function loadPeerRows(db: Db, vpnId: string) {
  return await db
    .select({
      id: peer.id,
      serverId: peer.serverId,
      endpointIpId: peer.endpointIpId,
      tunnelIpId: peer.tunnelIpId,
      role: peer.role,
      publicKey: peer.publicKey,
      listenPort: peer.listenPort,
      endpoint: peer.endpoint,
      presharedKey: peer.presharedKey,
      createdAt: peer.createdAt,
    })
    .from(peer)
    .where(eq(peer.vpnId, vpnId))
}

type PeerRow = Awaited<ReturnType<typeof loadPeerRows>>[number]

type ServerRow = {
  id: string
  datacenterId: string | null
  connected: boolean
  daemonStatus: string
}

async function loadPeerServers(
  db: Db,
  peerRows: PeerRow[],
): Promise<Map<string, ServerRow>> {
  const byId = new Map<string, ServerRow>()
  const serverIds = [...new Set(peerRows.map((row) => row.serverId))]
  if (serverIds.length === 0) return byId

  const rows = await db
    .select({
      id: server.id,
      datacenterId: server.datacenterId,
      connected: server.connected,
      daemonStatus: server.daemonStatus,
    })
    .from(server)
    .where(inArray(server.id, serverIds))
  for (const row of rows) {
    byId.set(row.id, row)
  }
  return byId
}

async function loadDatacenterCidrs(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, string[]>> {
  const byDc = new Map<string, string[]>()
  if (datacenterIds.length === 0) return byDc

  const rows = await db
    .select({
      datacenterId: network.datacenterId,
      cidr: network.cidr,
    })
    .from(network)
    .where(
      and(
        eq(network.kind, 'datacenter'),
        isNotNull(network.cidr),
        inArray(network.datacenterId, datacenterIds),
      ),
    )

  for (const row of rows) {
    if (!row.datacenterId || !row.cidr) continue
    const list = byDc.get(row.datacenterId) ?? []
    list.push(row.cidr)
    byDc.set(row.datacenterId, list)
  }
  return byDc
}

/**
 * One deterministic primary gateway per datacenter: lowest `createdAt` among
 * online gateways, else lowest `createdAt` overall.
 */
export function resolvePrimaryGatewayByDatacenter(
  peerRows: PeerRow[],
  serversById: Map<string, ServerRow>,
): Map<string, string> {
  type Candidate = { peerId: string; createdAt: string; online: boolean }
  const byDc = new Map<string, Candidate[]>()

  for (const row of peerRows) {
    if (row.role !== 'gateway') continue
    const srv = serversById.get(row.serverId)
    if (!srv?.datacenterId) continue
    const online = srv.connected === true && srv.daemonStatus === 'online'
    const list = byDc.get(srv.datacenterId) ?? []
    list.push({ peerId: row.id, createdAt: row.createdAt, online })
    byDc.set(srv.datacenterId, list)
  }

  const primary = new Map<string, string>()
  for (const [datacenterId, candidates] of byDc) {
    const sorted = [...candidates].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    const online = sorted.find((c) => c.online)
    const chosen = online ?? sorted[0]
    if (chosen) primary.set(datacenterId, chosen.peerId)
  }
  return primary
}

function validateGateways(
  peerRows: PeerRow[],
  serversById: Map<string, ServerRow>,
  cidrsByDc: Map<string, string[]>,
): VpnApplyPrepareError | null {
  for (const row of peerRows) {
    if (row.role !== 'gateway') continue
    const srv = serversById.get(row.serverId)
    if (!srv?.datacenterId) {
      return {
        kind: 'gateway_datacenter_required',
        peerId: row.id,
        serverId: row.serverId,
      }
    }
    const cidrs = cidrsByDc.get(srv.datacenterId) ?? []
    if (cidrs.length === 0) {
      return {
        kind: 'gateway_datacenter_cidr_required',
        peerId: row.id,
        datacenterId: srv.datacenterId,
      }
    }
  }
  return null
}

async function loadPeerIpAddresses(db: Db, peerRows: PeerRow[]): Promise<Map<string, string>> {
  const ipById = new Map<string, string>()
  const ipIds = new Set<string>()
  for (const row of peerRows) {
    if (row.endpointIpId) ipIds.add(row.endpointIpId)
    if (row.tunnelIpId) ipIds.add(row.tunnelIpId)
  }
  if (ipIds.size === 0) return ipById

  const ipRows = await db
    .select({ id: ip.id, address: ip.address })
    .from(ip)
    .where(inArray(ip.id, [...ipIds]))
  for (const row of ipRows) {
    ipById.set(row.id, stripInetPrefixSuffix(row.address))
  }
  return ipById
}

function resolveTunnelAddress(
  row: PeerRow,
  ipById: Map<string, string>,
): string | null {
  if (!row.tunnelIpId) return null
  return ipById.get(row.tunnelIpId) ?? null
}

function buildAllowedIps(params: {
  other: PeerRow
  hostRoute: string
  targetDatacenterId: string | null
  primaryGatewayByDc: Map<string, string>
  siteCidrsByDc: Map<string, string[]>
  serversById: Map<string, ServerRow>
}): string[] {
  const allowed = new Set<string>([params.hostRoute])
  if (params.other.role !== 'gateway') {
    return [...allowed]
  }

  const otherServer = params.serversById.get(params.other.serverId)
  const otherDc = otherServer?.datacenterId ?? null
  if (!otherDc) return [...allowed]

  const primaryPeerId = params.primaryGatewayByDc.get(otherDc)
  if (primaryPeerId !== params.other.id) return [...allowed]

  // Skip same-datacenter targets so a host does not route its own LAN over the tunnel.
  if (params.targetDatacenterId !== null && params.targetDatacenterId === otherDc) {
    return [...allowed]
  }

  for (const cidr of params.siteCidrsByDc.get(otherDc) ?? []) {
    allowed.add(cidr)
  }
  return [...allowed]
}

async function buildPeerMaterial(
  c: Context<AppEnv>,
  db: Db,
  params: {
    targetServerId: string
    targetDatacenterId: string | null
    other: PeerRow
    ipById: Map<string, string>
    primaryGatewayByDc: Map<string, string>
    siteCidrsByDc: Map<string, string[]>
    serversById: Map<string, ServerRow>
  },
): Promise<WireguardApplyCommandPayload['peers'][number] | VpnApplyPrepareError> {
  const { other, ipById, targetServerId, targetDatacenterId } = params
  const tunnelAddress = resolveTunnelAddress(other, ipById)
  if (!tunnelAddress) {
    return { kind: 'peer_tunnel_address_required', peerId: other.id }
  }
  if (!isValidWireguardPublicKey(other.publicKey)) {
    throw new Error(`Invalid WireGuard public key for peer ${other.id}`)
  }

  const hostRoute = hostRouteForTunnelAddress(tunnelAddress)
  const allowedIps = buildAllowedIps({
    other,
    hostRoute,
    targetDatacenterId,
    primaryGatewayByDc: params.primaryGatewayByDc,
    siteCidrsByDc: params.siteCidrsByDc,
    serversById: params.serversById,
  })

  const material: WireguardApplyCommandPayload['peers'][number] = {
    peerId: other.id,
    publicKey: other.publicKey,
    allowedIps,
  }

  const endpoint = resolvePeerEndpoint({
    endpoint: other.endpoint,
    listenPort: other.listenPort,
    ipAddress: other.endpointIpId ? ipById.get(other.endpointIpId) ?? null : null,
  })
  if (endpoint) {
    material.endpoint = endpoint
    material.persistentKeepalive = WIREGUARD_PERSISTENT_KEEPALIVE
  }

  if (other.presharedKey) {
    const resealed = await resealPeerPresharedForServer(
      c,
      db,
      targetServerId,
      other.presharedKey,
    )
    if (isPrepareError(resealed)) return resealed
    if (resealed) material.presharedKeyEnvelope = resealed
  }

  return material
}

type VpnApplyContext = {
  vpnId: string
  interfaceName: string
  vpnCidr: string
  ipById: Map<string, string>
  primaryGatewayByDc: Map<string, string>
  siteCidrsByDc: Map<string, string[]>
  serversById: Map<string, ServerRow>
}

async function buildTargetPayload(
  c: Context<AppEnv>,
  db: Db,
  target: PeerRow,
  peerRows: PeerRow[],
  context: VpnApplyContext,
): Promise<WireguardApplyCommandPayload | VpnApplyPrepareError> {
  const tunnelAddress = resolveTunnelAddress(target, context.ipById)
  if (!tunnelAddress) {
    return { kind: 'peer_tunnel_address_required', peerId: target.id }
  }

  const targetServer = context.serversById.get(target.serverId)
  const targetDatacenterId = targetServer?.datacenterId ?? null

  const peers: WireguardApplyCommandPayload['peers'] = []
  for (const other of peerRows) {
    if (other.id === target.id) continue
    const material = await buildPeerMaterial(c, db, {
      targetServerId: target.serverId,
      targetDatacenterId,
      other,
      ipById: context.ipById,
      primaryGatewayByDc: context.primaryGatewayByDc,
      siteCidrsByDc: context.siteCidrsByDc,
      serversById: context.serversById,
    })
    if (isPrepareError(material)) return material
    peers.push(material)
  }

  const enableIpForwarding = Boolean(
    target.role === 'gateway' &&
      targetDatacenterId &&
      context.primaryGatewayByDc.get(targetDatacenterId) === target.id,
  )

  const payload: WireguardApplyCommandPayload = {
    vpnId: context.vpnId,
    peerId: target.id,
    interfaceName: context.interfaceName,
    address: formatInterfaceAddress(tunnelAddress, context.vpnCidr),
    peers,
    ...(enableIpForwarding ? { enableIpForwarding: true } : {}),
  }
  if (target.listenPort !== null) {
    payload.listenPort = target.listenPort
  }
  return payload
}

export async function prepareVpnApplyPayloads(
  c: Context<AppEnv>,
  db: Db,
  vpnId: string,
): Promise<PreparedVpnApply | VpnApplyPrepareError> {
  const [vpnRow] = await db
    .select({
      id: vpn.id,
      cidr: vpn.cidr,
    })
    .from(vpn)
    .where(eq(vpn.id, vpnId))
    .limit(1)

  if (!vpnRow) {
    return { kind: 'vpn_has_no_peers' }
  }

  const peerRows = await loadPeerRows(db, vpnId)
  if (peerRows.length === 0) {
    return { kind: 'vpn_has_no_peers' }
  }

  const serversById = await loadPeerServers(db, peerRows)
  const datacenterIds = [
    ...new Set(
      [...serversById.values()]
        .map((row) => row.datacenterId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ]
  const siteCidrsByDc = await loadDatacenterCidrs(db, datacenterIds)
  const gatewayError = validateGateways(peerRows, serversById, siteCidrsByDc)
  if (gatewayError) return gatewayError

  const primaryGatewayByDc = resolvePrimaryGatewayByDatacenter(peerRows, serversById)
  const ipById = await loadPeerIpAddresses(db, peerRows)
  const interfaceName = deriveWireguardInterfaceName(vpnRow.id)
  const payloads: PreparedVpnApply['payloads'] = []

  for (const target of peerRows) {
    const payload = await buildTargetPayload(c, db, target, peerRows, {
      vpnId,
      interfaceName,
      vpnCidr: vpnRow.cidr,
      ipById,
      primaryGatewayByDc,
      siteCidrsByDc,
      serversById,
    })
    if (isPrepareError(payload)) return payload
    payloads.push({ serverId: target.serverId, payload })
  }

  return { interfaceName, payloads }
}
