import { eq, inArray } from 'drizzle-orm'
import { resealSecretForDaemon } from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import type { WireguardApplyCommandPayload } from '../../lib/commands/schemas.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import {
  deriveWireguardInterfaceName,
  isValidWireguardPublicKey,
  WIREGUARD_PERSISTENT_KEEPALIVE,
} from '../../lib/commands/wireguard.ts'
import { ip, peer, server, vpn } from '../../lib/db/schema.ts'
import { parseIpVersion, stripInetPrefixSuffix } from '../../lib/ip-address.ts'
import {
  assertServerDatacenterReady,
  loadDatacenterCidrs,
} from '../../lib/net/datacenter-networks.ts'
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

export type VpnApplyResealDeps = {
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

export type PreparedVpnApply = {
  interfaceName: string
  payloads: Array<{
    serverId: string
    payload: WireguardApplyCommandPayload
  }>
}

export type VpnApplyEnqueueResult = {
  peerId: string
  serverId: string
  commandId?: string
  status: 'queued' | 'failed'
  error?: string
}

export function isVpnApplyPrepareError(value: unknown): value is VpnApplyPrepareError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

function prefixLengthFromCidr(cidrValue: string): number | null {
  const slash = cidrValue.lastIndexOf('/')
  if (slash <= 0) return null
  const prefixPart = cidrValue.slice(slash + 1)
  if (!/^\d+$/.test(prefixPart)) return null
  return Number.parseInt(prefixPart, 10)
}

export function hostRouteForTunnelAddress(tunnelAddress: string): string {
  const version = parseIpVersion(tunnelAddress)
  if (version === 6) return `${tunnelAddress}/128`
  return `${tunnelAddress}/32`
}

export function formatInterfaceAddress(tunnelAddress: string, vpnCidr: string): string {
  const prefix = prefixLengthFromCidr(vpnCidr)
  if (prefix !== null) {
    return `${tunnelAddress}/${prefix}`
  }
  const version = parseIpVersion(tunnelAddress)
  if (version === 6) return `${tunnelAddress}/128`
  return `${tunnelAddress}/32`
}

export function resolvePeerEndpoint(
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
  db: Db,
  resealDeps: VpnApplyResealDeps | undefined,
  serverId: string,
  sealed: string | null,
): Promise<string | undefined | VpnApplyPrepareError> {
  if (!sealed) return undefined

  if (!resealDeps) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const envelope = await resealSecretForDaemon(
    resealDeps.secretsConfig,
    resealDeps.dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    sealed,
  )
  return envelope
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
    })
    .from(server)
    .where(inArray(server.id, serverIds))
  for (const row of rows) {
    byId.set(row.id, row)
  }
  return byId
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
    const online = srv.connected === true
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

/**
 * Gateways must be pinned to a datacenter that has at least one CIDR-bearing
 * site network. Delegates to {@link assertServerDatacenterReady} and maps the
 * placement errors onto VPN apply wire codes.
 */
export async function validateGateways(
  db: Db,
  peerRows: PeerRow[],
): Promise<VpnApplyPrepareError | null> {
  for (const row of peerRows) {
    if (row.role !== 'gateway') continue
    const ready = await assertServerDatacenterReady(db, row.serverId)
    if (!ready) continue
    if (ready.kind === 'datacenter_required') {
      return {
        kind: 'gateway_datacenter_required',
        peerId: row.id,
        serverId: row.serverId,
      }
    }
    return {
      kind: 'gateway_datacenter_cidr_required',
      peerId: row.id,
      datacenterId: ready.datacenterId,
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

export function buildAllowedIps(params: {
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

type PeerMaterialResult =
  | WireguardApplyCommandPayload['peers'][number]
  | VpnApplyPrepareError
  | 'skip'

async function buildPeerMaterial(
  db: Db,
  resealDeps: VpnApplyResealDeps | undefined,
  params: {
    targetServerId: string
    targetDatacenterId: string | null
    other: PeerRow
    ipById: Map<string, string>
    primaryGatewayByDc: Map<string, string>
    siteCidrsByDc: Map<string, string[]>
    serversById: Map<string, ServerRow>
  },
): Promise<PeerMaterialResult> {
  const { other, ipById, targetServerId, targetDatacenterId } = params
  const tunnelAddress = resolveTunnelAddress(other, ipById)
  if (!tunnelAddress) {
    return { kind: 'peer_tunnel_address_required', peerId: other.id }
  }
  // Bootstrap pass: peers without a reconciled key are omitted from remote lists.
  if (!other.publicKey || !isValidWireguardPublicKey(other.publicKey)) {
    return 'skip'
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
      db,
      resealDeps,
      targetServerId,
      other.presharedKey,
    )
    if (isVpnApplyPrepareError(resealed)) return resealed
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
  db: Db,
  resealDeps: VpnApplyResealDeps | undefined,
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
    const material = await buildPeerMaterial(db, resealDeps, {
      targetServerId: target.serverId,
      targetDatacenterId,
      other,
      ipById: context.ipById,
      primaryGatewayByDc: context.primaryGatewayByDc,
      siteCidrsByDc: context.siteCidrsByDc,
      serversById: context.serversById,
    })
    if (material === 'skip') continue
    if (isVpnApplyPrepareError(material)) return material
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
  db: Db,
  vpnId: string,
  resealDeps?: VpnApplyResealDeps,
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
  const gatewayError = await validateGateways(db, peerRows)
  if (gatewayError) return gatewayError

  const primaryGatewayByDc = resolvePrimaryGatewayByDatacenter(peerRows, serversById)
  const ipById = await loadPeerIpAddresses(db, peerRows)
  const interfaceName = deriveWireguardInterfaceName(vpnRow.id)
  const payloads: PreparedVpnApply['payloads'] = []

  for (const target of peerRows) {
    const payload = await buildTargetPayload(db, resealDeps, target, peerRows, {
      vpnId,
      interfaceName,
      vpnCidr: vpnRow.cidr,
      ipById,
      primaryGatewayByDc,
      siteCidrsByDc,
      serversById,
    })
    if (isVpnApplyPrepareError(payload)) return payload
    payloads.push({ serverId: target.serverId, payload })
  }

  return { interfaceName, payloads }
}

/**
 * Enqueue one `server.wireguard.apply` command per prepared peer payload.
 * Used by the client apply route and the consumer mesh-complete follow-up.
 */
export async function enqueuePreparedVpnApply(params: {
  db: Db
  commandQueue: CommandQueue
  actorType: string
  actorId: string
  prepared: PreparedVpnApply
  expiresAt?: string
}): Promise<VpnApplyEnqueueResult[]> {
  const expiresAt = params.expiresAt ??
    new Date(Date.now() + 300_000).toISOString()

  return await Promise.all(
    params.prepared.payloads.map(async ({ serverId: targetServerId, payload }) => {
      const peerId = payload.peerId
      try {
        const record = await createCommandRecord(params.db, {
          serverId: targetServerId,
          actorType: params.actorType,
          actorId: params.actorId,
          type: 'server.wireguard.apply',
          payload,
          expiresAt,
        })

        const envelope: CommandEnvelope = {
          commandId: record.id,
          serverId: targetServerId,
          type: 'server.wireguard.apply',
          attempt: 1,
          queuedAt: record.queuedAt ?? record.createdAt,
        }

        try {
          await params.commandQueue.enqueue(envelope)
        } catch {
          await transitionCommand(params.db, record.id, {
            status: 'failed',
            error: 'Command queue unavailable',
          })
          return {
            peerId,
            serverId: targetServerId,
            status: 'failed' as const,
            error: 'Command queue unavailable',
          }
        }

        return {
          peerId,
          serverId: targetServerId,
          commandId: record.id,
          status: 'queued' as const,
        }
      } catch {
        return {
          peerId,
          serverId: targetServerId,
          status: 'failed' as const,
          error: 'enqueue_failed',
        }
      }
    }),
  )
}

/** True when every peer on the VPN has a reconciled WireGuard public key. */
export async function vpnPeersAllKeyed(db: Db, vpnId: string): Promise<boolean> {
  const rows = await db
    .select({ publicKey: peer.publicKey })
    .from(peer)
    .where(eq(peer.vpnId, vpnId))
  if (rows.length === 0) return false
  return rows.every((row) =>
    typeof row.publicKey === 'string' && isValidWireguardPublicKey(row.publicKey)
  )
}

/**
 * After a bootstrap apply fills a previously-null public key, enqueue a full
 * mesh apply once every peer on the VPN is keyed.
 */
export async function maybeEnqueueVpnMeshComplete(params: {
  db: Db
  commandQueue: CommandQueue
  resealDeps?: VpnApplyResealDeps
  actorType: string
  actorId: string
  vpnId: string
  filledNullKey: boolean
}): Promise<void> {
  if (!params.filledNullKey) return
  if (!(await vpnPeersAllKeyed(params.db, params.vpnId))) return

  const prepared = await prepareVpnApplyPayloads(
    params.db,
    params.vpnId,
    params.resealDeps,
  )
  if ('kind' in prepared) return

  await enqueuePreparedVpnApply({
    db: params.db,
    commandQueue: params.commandQueue,
    actorType: params.actorType,
    actorId: params.actorId,
    prepared,
  })
}
