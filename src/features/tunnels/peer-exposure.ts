/**
 * The firewall's view of tunnel forwarding: the servers that carry a tunnel
 * for a site that runs here may open the hosting HTTPS port, and nobody new
 * beyond their exact addresses. The addresses are the `peerAddresses` the
 * route builder sends to this server, so the rule and the Caddy address lock
 * can never name different servers.
 */
import type { Db } from '../../db/connection.ts'
import { isValidIpAddress } from '../../lib/ip-address.ts'
import type { DerivedExposure } from '../firewall/derive.ts'
import { buildTunnelRoutes } from './route-builder.ts'
import { loadRoutingFacts } from './route-facts.ts'

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
export function tunnelPeerExposures(peerAddresses: readonly string[]): DerivedExposure[] {
  const exact = peerAddresses.filter(isExactPeerAddress)
  if (exact.length === 0) return []
  return [
    {
      source: 'hosting',
      scope: 'host',
      proto: 'tcp',
      ports: '443',
      reach: 'peers',
      comment: TUNNEL_PEER_COMMENT,
      sources: exact,
    },
  ]
}

/** HTTPS only: not 80, not 443/udp, not the panel port. */
export async function loadTunnelPeerExposures(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<DerivedExposure[]> {
  const facts = await loadRoutingFacts(db, organizationId)
  if (facts.tunnels.length === 0) return []
  const built = buildTunnelRoutes(serverId, facts.tunnels, facts.addresses)
  return tunnelPeerExposures(built.peerAddresses)
}
