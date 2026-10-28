/**
 * The firewall's view of tunnel forwarding: the servers that carry a tunnel
 * for a site that runs here may open the hosting HTTPS port, and nobody new
 * beyond their exact addresses. The addresses are the `peerAddresses` the
 * route builder sends to this server, so the rule and the Caddy address lock
 * can never name different servers.
 */
import type { Db } from '../../db/connection.ts'
import type { DerivedExposure } from '../firewall/derive.ts'
import { buildTunnelRoutes } from './route-builder.ts'
import { loadRoutingFacts } from './route-facts.ts'

export const TUNNEL_PEER_COMMENT = 'Tunnel peers'

/** Pure: the exposure for a server's inbound peer addresses, or none when it has no peers. */
export function tunnelPeerExposures(peerAddresses: readonly string[]): DerivedExposure[] {
  if (peerAddresses.length === 0) return []
  return [
    {
      source: 'hosting',
      scope: 'host',
      proto: 'tcp',
      ports: '443',
      reach: 'peers',
      comment: TUNNEL_PEER_COMMENT,
      sources: [...peerAddresses],
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
