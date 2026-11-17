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
  TunnelInbound,
  TunnelPeerClientAuth,
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
  /** The names whose site runs here and who may forward each. Sync always asks for it (`withInbound`); only a direct caller that leaves it off gets none. */
  inbound?: TunnelInbound[]
  needsPeerMaterial: boolean
  /** Set only when asked for (`peerClientAuth`): the receiving side's client certificate policy. */
  peerClientAuth?: TunnelPeerClientAuth
  /** Names that could not be routed, with a plain-words reason. */
  skipped: { hostname: string; reason: string }[]
  /** Plain-words notes when a contract cap cut the table short. */
  warnings: string[]
}

function byHostname(a: { hostname: string }, b: { hostname: string }): number {
  return compareText(a.hostname, b.hostname)
}

/** One server's exact addresses for the peer hop, kept apart by where they are reachable. */
export type ServerAddresses = {
  /** Datacenter network addresses, by datacenter id. */
  datacenters: Readonly<Record<string, readonly string[]>>
  /** Dedicated public addresses. */
  public: readonly string[]
}

/** Every known server's addresses. A server with none is absent. */
export type AddressBook = ReadonlyMap<string, ServerAddresses>

/** The addresses two servers use for the hop between them: one list per side. */
export type PairAddresses = { carrier: readonly string[]; site: readonly string[] }

const NO_PAIR: PairAddresses = { carrier: [], site: [] }

const isV6 = (address: string): boolean => address.includes(':')

/**
 * Both lists cut to one IP version they share, or none. With `preferV6` the
 * version of the first address on the site side wins (a datacenter's own
 * order); otherwise IPv4 wins.
 */
function sharedFamily(
  carrier: readonly string[],
  site: readonly string[],
  preferV6: boolean
): PairAddresses {
  const has = (list: readonly string[], v6: boolean) => list.some((a) => isV6(a) === v6)
  const options = [false, true].filter((v6) => has(carrier, v6) && has(site, v6))
  if (options.length === 0) return NO_PAIR
  const first = preferV6 ? isV6(site[0] ?? '') : false
  const v6 = options.includes(first) ? first : options[0] === true
  return {
    carrier: carrier.filter((a) => isV6(a) === v6),
    site: site.filter((a) => isV6(a) === v6),
  }
}

/**
 * The addresses for the hop from a carrying server to a site server. Both sides
 * use a datacenter network only when they share one (the lowest shared id with
 * an address of a shared IP version on each side); otherwise both use their
 * public addresses, again of one shared IP version (IPv4 preferred). The
 * upstream, the peer list, the firewall rule and the receiver's address lock
 * all come from this one choice, so they always agree. Empty = no usable pair.
 */
export function pairAddresses(book: AddressBook, carrierId: string, siteId: string): PairAddresses {
  const carrier = book.get(carrierId)
  const site = book.get(siteId)
  if (!carrier || !site) return NO_PAIR
  const shared = Object.keys(carrier.datacenters).filter((id) => id in site.datacenters)
  for (const id of shared.toSorted(compareText)) {
    const pair = sharedFamily(carrier.datacenters[id] ?? [], site.datacenters[id] ?? [], true)
    if (pair.carrier.length > 0) return pair
  }
  return sharedFamily(carrier.public, site.public, false)
}

/** The servers that run the site that this carrier can reach, with the address for each pair. */
function remoteUpstreams(
  carrierId: string,
  doorway: DoorwayFact,
  addresses: AddressBook
): TunnelRouteUpstream[] {
  return doorway.siteServerIds
    .flatMap((id) => {
      const list = pairAddresses(addresses, carrierId, id).site
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
  return 'No server that runs this site has an address this server can reach (a shared datacenter network, or public addresses of an IP version both servers have; the two servers may share no IP version)'
}

/**
 * Why a name is not routed, for every name that some carrying server skipped.
 * A name routed everywhere has no entry; the first reason found is kept.
 */
export function unroutedReasons(
  carriers: readonly string[],
  tunnels: readonly TunnelFact[],
  addresses: AddressBook
): Map<string, string> {
  const reasons = new Map<string, string>()
  for (const carrier of carriers) {
    for (const note of buildTunnelRoutes(carrier, tunnels, addresses).skipped) {
      if (!reasons.has(note.hostname)) reasons.set(note.hostname, note.reason)
    }
  }
  return reasons
}

/** Other servers that carry the tunnel may pass visitors to a site that runs here. */
function addInboundPeers(
  peers: Set<string>,
  own: Set<string>,
  tunnel: TunnelFact,
  serverId: string,
  addresses: AddressBook
): void {
  // Sorted, so the order of the own addresses does not depend on the order carriers are listed.
  for (const carrier of [...tunnel.carrying].toSorted(compareText)) {
    if (carrier === serverId) continue
    const pair = pairAddresses(addresses, carrier, serverId)
    for (const address of pair.carrier) peers.add(address)
    for (const address of pair.site) own.add(address)
  }
}

/** One table entry for a name this server carries, or the reason it cannot be routed. */
function routeFor(
  doorway: DoorwayFact,
  siteHere: boolean,
  carrierId: string,
  addresses: AddressBook
): { route: TunnelRoute } | { reason: string } {
  const upstreams = siteHere ? [] : remoteUpstreams(carrierId, doorway, addresses)
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

/** What a server that runs a site learns: who may forward each name, and which names are local-only. */
type InboundFacts = {
  peers: Map<string, Set<string>>
  locked: Set<string>
  /** This server's own addresses the peers reach it on. */
  listen: Set<string>
}

/** Record, for a name whose site runs on `serverId`, its other carriers and whether it is local-only. */
function noteInbound(
  facts: InboundFacts,
  peers: Set<string>,
  tunnel: TunnelFact,
  doorway: DoorwayFact,
  serverId: string,
  addresses: AddressBook
): void {
  addInboundPeers(peers, facts.listen, tunnel, serverId, addresses)
  const own = facts.peers.get(doorway.hostname) ?? new Set<string>()
  addInboundPeers(own, facts.listen, tunnel, serverId, addresses)
  facts.peers.set(doorway.hostname, own)
  if (doorway.isLocalOnly) facts.locked.add(doorway.hostname)
}

type Collected = {
  routes: Map<string, TunnelRoute>
  peers: Set<string>
  inbound: InboundFacts
  skipped: RouteBuildResult['skipped']
}

/** One tunnel's doorways: who may forward to the site here, and the routes this server carries. */
function collectDoorways(
  tunnel: TunnelFact,
  serverId: string,
  addresses: AddressBook,
  into: Collected
): void {
  const carriesHere = tunnel.carrying.includes(serverId)
  for (const doorway of tunnel.doorways) {
    const siteHere = doorway.siteServerIds.includes(serverId)
    if (siteHere) noteInbound(into.inbound, into.peers, tunnel, doorway, serverId, addresses)
    if (!carriesHere || into.routes.has(doorway.hostname)) continue
    const built = routeFor(doorway, siteHere, serverId, addresses)
    if ('route' in built) into.routes.set(doorway.hostname, built.route)
    else into.skipped.push({ hostname: doorway.hostname, reason: built.reason })
  }
}

export function buildTunnelRoutes(
  serverId: string,
  tunnels: readonly TunnelFact[],
  addresses: AddressBook,
  options: {
    withInbound?: boolean
    withLockAdd?: boolean
    peerClientAuth?: TunnelPeerClientAuth
  } = {}
): RouteBuildResult {
  const routes = new Map<string, TunnelRoute>()
  const peers = new Set<string>()
  const inbound: InboundFacts = { peers: new Map(), locked: new Set(), listen: new Set() }
  const skipped: RouteBuildResult['skipped'] = []
  for (const tunnel of tunnels) {
    collectDoorways(tunnel, serverId, addresses, { routes, peers, inbound, skipped })
  }
  const found = finishTable(routes, peers, inbound.listen, skipped)
  const table = options.peerClientAuth
    ? { ...found, peerClientAuth: options.peerClientAuth }
    : found
  if (!options.withInbound) return table
  const lockNames = options.withLockAdd ? inbound.locked : new Set<string>()
  return { ...table, inbound: finishInbound(inbound.peers, table.warnings, lockNames) }
}

/**
 * Per name, the exact addresses allowed to forward it, sorted and cut at the
 * contract caps (with a note). A name that only this server carries keeps an
 * empty list: the daemon then admits loopback alone.
 */
function finishInbound(
  inbound: ReadonlyMap<string, ReadonlySet<string>>,
  warnings: string[],
  lockNames: ReadonlySet<string>
): TunnelInbound[] {
  const all = [...inbound.entries()]
    .map(([hostname, peers]) => ({
      hostname,
      peers: [...peers].toSorted(compareText),
      ...(lockNames.has(hostname) ? { lock: true as const } : {}),
    }))
    .toSorted(byHostname)
  const kept = all.slice(0, TUNNEL_TABLE_CAPS.routes)
  if (all.length > kept.length) {
    warnings.push(`Only ${TUNNEL_TABLE_CAPS.routes} locked names can be sent to one server`)
  }
  return kept.map((entry) => {
    if (entry.peers.length <= TUNNEL_TABLE_CAPS.addresses) return entry
    warnings.push(
      `Only ${TUNNEL_TABLE_CAPS.addresses} peer addresses can be sent for ${entry.hostname}`
    )
    return { ...entry, peers: entry.peers.slice(0, TUNNEL_TABLE_CAPS.addresses) }
  })
}

/** Sort, cut at the contract caps (with a note), and decide whether a certificate is needed. */
function finishTable(
  routes: ReadonlyMap<string, TunnelRoute>,
  peers: ReadonlySet<string>,
  listen: ReadonlySet<string>,
  skipped: RouteBuildResult['skipped']
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
  const own = peerAddresses.length > 0 ? [...listen] : []
  const listenAddresses = own.slice(0, TUNNEL_TABLE_CAPS.addresses)
  if (own.length > listenAddresses.length) {
    warnings.push(`Only ${TUNNEL_TABLE_CAPS.addresses} listen addresses can be sent to one server`)
  }
  return {
    routes: kept,
    peerAddresses,
    listenAddresses,
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
  built: Pick<
    RouteBuildResult,
    'routes' | 'peerAddresses' | 'listenAddresses' | 'inbound' | 'peerClientAuth'
  >,
  material: Pick<TunnelPeerMaterial, 'certificatePem' | 'caCertPem'> | undefined
): Promise<string> {
  return await sha256Hex(
    JSON.stringify({
      routes: built.routes,
      peerAddresses: built.peerAddresses,
      listenAddresses: built.listenAddresses,
      certificatePem: material?.certificatePem ?? null,
      caCertPem: material?.caCertPem ?? null,
      // Only when sent, so a daemon without the feature keeps the hash it had.
      ...(built.inbound ? { inbound: built.inbound } : {}),
      // Only when sent: a change of policy changes the hash, so a server is sent its certificate again.
      ...(built.peerClientAuth ? { peerClientAuth: built.peerClientAuth } : {}),
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
  if (built.inbound) payload.inbound = built.inbound
  if (built.peerClientAuth) payload.peerClientAuth = built.peerClientAuth
  return payload
}
