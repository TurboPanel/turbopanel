/**
 * The firewall's view of tunnel forwarding: the servers that carry a tunnel
 * for a site that runs here may open the peer hop port (`TUNNEL_PEER_PORT`),
 * and nobody new beyond their exact addresses. The hosting port needs no peer
 * opening: the peer server forwards to it on loopback. The addresses are the `peerAddresses` the
 * route builder sends to this server, so the rule and the Caddy address lock
 * can never name different servers.
 */
import type { Db } from '../../db/connection.ts'
import { isValidIpAddress } from '../../lib/ip-address.ts'
import type { DerivedExposure } from '../firewall/derive.ts'
import { TUNNEL_PEER_PORT } from '../../contracts/commands/tunnel-routes.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { daemonTakesPeerClientAuth } from './daemon-gate.ts'
import { buildTunnelRoutes } from './route-builder.ts'
import { loadRoutingFacts } from './route-facts.ts'

const HOSTING_HTTPS_PORT = 443

export const TUNNEL_PEER_COMMENT = 'Tunnel peers'

/**
 * The same test the forwarding table contract applies to a peer: a bare IP
 * literal, never a range. The firewall accepts ranges, so without this an
 * address row like `10.0.0.5/24` would be refused in the Caddy table (no lock)
 * while the firewall rule opened the whole /24.
 */
function isExactPeerAddress(address: string): boolean {
  return !address.includes('/') && isValidIpAddress(address)
}

/** Pure: the exposure for a server's inbound peer addresses, or none when it has no peers. */
export function tunnelPeerExposures(
  peerAddresses: readonly string[],
  peerPort: number
): DerivedExposure[] {
  const exact = peerAddresses.filter(isExactPeerAddress)
  if (exact.length === 0) return []
  return [
    {
      source: 'hosting',
      scope: 'host',
      proto: 'tcp',
      ports: String(peerPort),
      reach: 'peers',
      comment: TUNNEL_PEER_COMMENT,
      sources: exact,
    },
  ]
}

/**
 * The port peers dial on a receiver: the peer hop port on a daemon with
 * `tunnel-peer-mtls-v1`, the hosting HTTPS port on an older one (its tunnels
 * keep working as before). Never 80, 443/udp or the panel port.
 */
export function tunnelPeerPortFor(features: readonly string[] | undefined): number {
  return daemonTakesPeerClientAuth(features) ? TUNNEL_PEER_PORT : HOSTING_HTTPS_PORT
}

/** Peer exposures for one server, on the port its daemon version serves. */
export async function loadTunnelPeerExposures(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<DerivedExposure[]> {
  const facts = await loadRoutingFacts(db, organizationId)
  if (facts.tunnels.length === 0) return []
  const built = buildTunnelRoutes(serverId, facts.tunnels, facts.addresses)
  const state = await getServerDaemonStateByServerId(db, serverId)
  return tunnelPeerExposures(built.peerAddresses, tunnelPeerPortFor(state?.projection?.features))
}
