import type { Context } from 'hono'
import { eq, inArray } from 'drizzle-orm'
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
} from '../../lib/commands/wireguard.ts'
import { ip, network, peer, vpn } from '../../lib/db/schema.ts'
import { parseIpVersion } from '../../lib/ip-address.ts'
import type { Db } from '../../db.ts'

export type VpnApplyPrepareError =
  | { kind: 'peer_tunnel_address_required'; peerId: string }
  | { kind: 'vpn_has_no_peers' }
  | { kind: 'daemon_key_unavailable'; serverId: string }

export type PreparedVpnApply = {
  interfaceName: string
  payloads: Array<{
    serverId: string
    payload: WireguardApplyCommandPayload
  }>
}

function prefixLengthFromCidr(cidrValue: string | null | undefined): number | null {
  if (!cidrValue) return null
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

function formatInterfaceAddress(tunnelAddress: string, networkCidr: string | null): string {
  const prefix = prefixLengthFromCidr(networkCidr)
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
      ipId: peer.ipId,
      publicKey: peer.publicKey,
      tunnelAddress: peer.tunnelAddress,
      listenPort: peer.listenPort,
      endpoint: peer.endpoint,
      presharedKey: peer.presharedKey,
    })
    .from(peer)
    .where(eq(peer.vpnId, vpnId))
}

type PeerRow = Awaited<ReturnType<typeof loadPeerRows>>[number]

async function loadNetworkCidr(db: Db, networkId: string | null): Promise<string | null> {
  if (!networkId) return null
  const [netRow] = await db
    .select({ cidr: network.cidr })
    .from(network)
    .where(eq(network.id, networkId))
    .limit(1)
  return netRow?.cidr ?? null
}

async function loadPeerIpAddresses(db: Db, peerRows: PeerRow[]): Promise<Map<string, string>> {
  const ipById = new Map<string, string>()
  const ipIds = peerRows
    .map((row) => row.ipId)
    .filter((id): id is string => id !== null)
  if (ipIds.length === 0) return ipById

  const ipRows = await db
    .select({ id: ip.id, address: ip.address })
    .from(ip)
    .where(inArray(ip.id, ipIds))
  for (const row of ipRows) {
    ipById.set(row.id, row.address)
  }
  return ipById
}

async function buildPeerMaterial(
  c: Context<AppEnv>,
  db: Db,
  targetServerId: string,
  other: PeerRow,
  ipById: Map<string, string>,
): Promise<WireguardApplyCommandPayload['peers'][number] | VpnApplyPrepareError> {
  if (!other.tunnelAddress) {
    return { kind: 'peer_tunnel_address_required', peerId: other.id }
  }
  if (!isValidWireguardPublicKey(other.publicKey)) {
    throw new Error(`Invalid WireGuard public key for peer ${other.id}`)
  }

  const material: WireguardApplyCommandPayload['peers'][number] = {
    peerId: other.id,
    publicKey: other.publicKey,
    allowedIps: [hostRouteForTunnelAddress(other.tunnelAddress)],
  }

  const endpoint = resolvePeerEndpoint({
    endpoint: other.endpoint,
    listenPort: other.listenPort,
    ipAddress: other.ipId ? ipById.get(other.ipId) ?? null : null,
  })
  if (endpoint) material.endpoint = endpoint

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
  networkCidr: string | null
  ipById: Map<string, string>
}

async function buildTargetPayload(
  c: Context<AppEnv>,
  db: Db,
  target: PeerRow,
  peerRows: PeerRow[],
  context: VpnApplyContext,
): Promise<WireguardApplyCommandPayload | VpnApplyPrepareError> {
  if (!target.tunnelAddress) {
    return { kind: 'peer_tunnel_address_required', peerId: target.id }
  }

  const peers: WireguardApplyCommandPayload['peers'] = []
  for (const other of peerRows) {
    if (other.id === target.id) continue
    const material = await buildPeerMaterial(c, db, target.serverId, other, context.ipById)
    if (isPrepareError(material)) return material
    peers.push(material)
  }

  const payload: WireguardApplyCommandPayload = {
    vpnId: context.vpnId,
    peerId: target.id,
    interfaceName: context.interfaceName,
    address: formatInterfaceAddress(target.tunnelAddress, context.networkCidr),
    peers,
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
      networkId: vpn.networkId,
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

  const networkCidr = await loadNetworkCidr(db, vpnRow.networkId)
  const ipById = await loadPeerIpAddresses(db, peerRows)
  const interfaceName = deriveWireguardInterfaceName(vpnRow.id)
  const payloads: PreparedVpnApply['payloads'] = []

  for (const target of peerRows) {
    const payload = await buildTargetPayload(c, db, target, peerRows, {
      vpnId,
      interfaceName,
      networkCidr,
      ipById,
    })
    if (isPrepareError(payload)) return payload
    payloads.push({ serverId: target.serverId, payload })
  }

  return { interfaceName, payloads }
}
