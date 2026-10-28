/**
 * Builds the `server.tunnel.routes` payload for one server from facts the
 * caller loaded. Pure: no database, no clock. The server is told, for every
 * tunnel it carries, where each name's site runs; a name whose site runs on
 * the server itself is marked local and the daemon leaves it to the site's own
 * web server. Servers that run a site also learn which other servers may send
 * them tunnel visitors, so the peer-facing listener admits exactly those
 * addresses.
 */
import type {
  TunnelPeerMaterial,
  TunnelRoute,
  TunnelRouteUpstream,
  TunnelRoutesCommandPayload,
} from '../../contracts/commands/tunnel-routes.ts'
import { compareText } from './order.ts'

/** The daemon contract's caps; a table above them would be refused whole. */
export const TUNNEL_TABLE_CAPS = {
  routes: 2000,
  upstreamsPerRoute: 16,
  addressesPerUpstream: 8,
  addresses: 64,
} as const

export type DoorwayFact = {
  hostname: string
  /** Servers that run the site this name belongs to. Empty = the site runs nowhere yet. */
  siteServerIds: readonly string[]
  /** True = only tunnel visitors and peers are answered; false = the name is also public. */
  isLocalOnly: boolean
}

export type TunnelFact = {
  /** Servers that run a connector for this tunnel. */
  carrying: readonly string[]
  doorways: readonly DoorwayFact[]
}

export type RouteBuildResult = {
  /** The payload without `hash` and `peerMaterial`; `needsPeerMaterial` says if the caller must add it. */
  routes: TunnelRoute[]
  peerAddresses: string[]
  listenAddresses: string[]
  needsPeerMaterial: boolean
  /** Names that could not be routed, with a plain-words reason. */
  skipped: { hostname: string; reason: string }[]
  /** Plain-words notes when a contract cap cut the table short. */
  warnings: string[]
}

function byHostname(a: { hostname: string }, b: { hostname: string }): number {
  return compareText(a.hostname, b.hostname)
}

/** The exact datacenter addresses of a server, or none when it has no datacenter address. */
type AddressBook = ReadonlyMap<string, readonly string[]>

/** The servers that run the site, with their addresses; servers with no address are left out. */
function remoteUpstreams(doorway: DoorwayFact, addresses: AddressBook): TunnelRouteUpstream[] {
  return doorway.siteServerIds
    .flatMap((id) => {
      const list = addresses.get(id) ?? []
      if (list.length === 0) return []
      return [{ serverId: id, addresses: list.slice(0, TUNNEL_TABLE_CAPS.addressesPerUpstream) }]
    })
    .toSorted((a, b) => compareText(a.serverId, b.serverId))
    .slice(0, TUNNEL_TABLE_CAPS.upstreamsPerRoute)
}

function skipReason(doorway: DoorwayFact): string {
  if (doorway.siteServerIds.length === 0) {
    return 'The site for this name does not run on any server yet'
  }
  return 'No server that runs this site has a datacenter address'
}

/** Other servers that carry the tunnel may pass visitors to a site that runs here. */
function addInboundPeers(
  peers: Set<string>,
  tunnel: TunnelFact,
  serverId: string,
  addresses: AddressBook
): void {
  for (const carrier of tunnel.carrying) {
    if (carrier === serverId) continue
    for (const address of addresses.get(carrier) ?? []) peers.add(address)
  }
}

/** One table entry for a name this server carries, or the reason it cannot be routed. */
function routeFor(
  doorway: DoorwayFact,
  siteHere: boolean,
  addresses: AddressBook
): { route: TunnelRoute } | { reason: string } {
  const upstreams = siteHere ? [] : remoteUpstreams(doorway, addresses)
  if (!siteHere && upstreams.length === 0) return { reason: skipReason(doorway) }
  return {
    route: {
      hostname: doorway.hostname,
      local: siteHere,
      lock: doorway.isLocalOnly,
      upstreams,
    },
  }
}

export function buildTunnelRoutes(
  serverId: string,
  tunnels: readonly TunnelFact[],
  addresses: AddressBook
): RouteBuildResult {
  const routes = new Map<string, TunnelRoute>()
  const peers = new Set<string>()
  const skipped: RouteBuildResult['skipped'] = []

  for (const tunnel of tunnels) {
    const carriesHere = tunnel.carrying.includes(serverId)
    for (const doorway of tunnel.doorways) {
      const siteHere = doorway.siteServerIds.includes(serverId)
      if (siteHere) addInboundPeers(peers, tunnel, serverId, addresses)
      if (!carriesHere || routes.has(doorway.hostname)) continue
      const built = routeFor(doorway, siteHere, addresses)
      if ('route' in built) routes.set(doorway.hostname, built.route)
      else skipped.push({ hostname: doorway.hostname, reason: built.reason })
    }
  }
  return finishTable(serverId, routes, peers, skipped, addresses)
}

/** Sort, cut at the contract caps (with a note), and decide whether a certificate is needed. */
function finishTable(
  serverId: string,
  routes: ReadonlyMap<string, TunnelRoute>,
  peers: ReadonlySet<string>,
  skipped: RouteBuildResult['skipped'],
  addresses: AddressBook
): RouteBuildResult {
  const warnings: string[] = []
  const allPeers = [...peers].toSorted(compareText)
  const peerAddresses = allPeers.slice(0, TUNNEL_TABLE_CAPS.addresses)
  if (allPeers.length > peerAddresses.length) {
    warnings.push(`Only ${TUNNEL_TABLE_CAPS.addresses} peer addresses can be sent to one server`)
  }
  const allRoutes = [...routes.values()].toSorted(byHostname)
  const kept = allRoutes.slice(0, TUNNEL_TABLE_CAPS.routes)
  if (allRoutes.length > kept.length) {
    warnings.push(`Only ${TUNNEL_TABLE_CAPS.routes} Tunnel hostnames can be sent to one server`)
  }
  const own = peerAddresses.length > 0 ? (addresses.get(serverId) ?? []) : []
  return {
    routes: kept,
    peerAddresses,
    listenAddresses: own.slice(0, TUNNEL_TABLE_CAPS.addresses),
    needsPeerMaterial: kept.length > 0 || peerAddresses.length > 0,
    skipped,
    warnings,
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Hash of the desired state. The certificate and trust bundle are part of it
 * so a renewed certificate is re-applied; the sealed key is not, because
 * sealing the same key twice gives different text.
 */
export async function hashTunnelRoutes(
  built: Pick<RouteBuildResult, 'routes' | 'peerAddresses' | 'listenAddresses'>,
  material: Pick<TunnelPeerMaterial, 'certificatePem' | 'caCertPem'> | undefined
): Promise<string> {
  return await sha256Hex(
    JSON.stringify({
      routes: built.routes,
      peerAddresses: built.peerAddresses,
      listenAddresses: built.listenAddresses,
      certificatePem: material?.certificatePem ?? null,
      caCertPem: material?.caCertPem ?? null,
    })
  )
}

/** Assemble the wire payload. Material is required whenever the build says so. */
export async function toRoutesPayload(
  built: RouteBuildResult,
  material: TunnelPeerMaterial | undefined
): Promise<TunnelRoutesCommandPayload> {
  if (built.needsPeerMaterial && !material) {
    throw new Error('Peer material is required for a server that carries or hosts tunnel names')
  }
  const payload: TunnelRoutesCommandPayload = {
    hash: await hashTunnelRoutes(built, material),
    routes: built.routes,
    peerAddresses: built.peerAddresses,
  }
  if (built.listenAddresses.length > 0) payload.listenAddresses = built.listenAddresses
  if (material) payload.peerMaterial = material
  return payload
}
