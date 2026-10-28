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
  TunnelRoutesCommandPayload,
} from '../../contracts/commands/tunnel-routes.ts'

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
}

function byHostname(a: { hostname: string }, b: { hostname: string }): number {
  return a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0
}

/** The exact datacenter addresses of a server, or none when it has no datacenter address. */
type AddressBook = ReadonlyMap<string, readonly string[]>

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
      if (siteHere) {
        // Peers are the other servers that carry this tunnel and so may pass visitors on.
        for (const carrier of tunnel.carrying) {
          if (carrier === serverId) continue
          for (const address of addresses.get(carrier) ?? []) peers.add(address)
        }
      }
      if (!carriesHere || routes.has(doorway.hostname)) continue
      const upstreams = siteHere
        ? []
        : doorway.siteServerIds.flatMap((id) => {
            const list = addresses.get(id) ?? []
            return list.length > 0 ? [{ serverId: id, addresses: [...list] }] : []
          })
      if (!siteHere && upstreams.length === 0) {
        skipped.push({
          hostname: doorway.hostname,
          reason:
            doorway.siteServerIds.length === 0
              ? 'The site for this name does not run on any server yet'
              : 'No server that runs this site has a datacenter address',
        })
        continue
      }
      // A server it forwards to must never forward back (the daemon answers a peer with an
      // error instead of passing it on again), so those servers are peers here too.
      for (const upstream of upstreams) upstream.addresses.forEach((a) => peers.add(a))
      routes.set(doorway.hostname, {
        hostname: doorway.hostname,
        local: siteHere,
        lock: doorway.isLocalOnly,
        upstreams: upstreams.sort((a, b) => (a.serverId < b.serverId ? -1 : 1)),
      })
    }
  }

  const peerAddresses = [...peers].sort()
  const own = peerAddresses.length > 0 ? [...(addresses.get(serverId) ?? [])] : []
  return {
    routes: [...routes.values()].sort(byHostname),
    peerAddresses,
    listenAddresses: own,
    needsPeerMaterial: routes.size > 0 || peerAddresses.length > 0,
    skipped,
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
