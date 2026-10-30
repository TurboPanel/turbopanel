/**
 * Which servers can skip the TurboFabric tunnel for a shared trusted LAN.
 *
 * Two servers that share a trusted datacenter network talk over that LAN with
 * no tunnel between them, including their cross-server container networks
 * (each routes the other's container range via its LAN address). That needs
 * both daemons to understand `tunnel: false` and `lanRoutes`
 * (`fabric-lan-routes-v1`); a pair where either daemon is older keeps today's
 * tunnel over the LAN so nothing breaks while the fleet updates.
 *
 * The pure pair rule lives next to the ladder (`serversShareTrustedLan` in
 * `../net/private-endpoint.ts`); this module only loads its inputs.
 */
import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { FABRIC_LAN_ROUTES_FEATURE } from '../../lib/version-wire.ts'
import { parseServerDaemonState } from '../servers/daemon-state.ts'
import { loadDatacenterPolicies } from '../net/datacenter-networks.ts'
import { loadDatacenterMembershipsForServers } from '../net/datacenter-membership.ts'
import type { LanPairInputs } from '../net/private-endpoint.ts'

/** True when the daemon's last advertised features include LAN routes. */
export function daemonAdvertisesLanRoutes(daemon: unknown): boolean {
  return (parseServerDaemonState(daemon)?.projection?.features ?? []).includes(
    FABRIC_LAN_ROUTES_FEATURE
  )
}

/** The servers (of those listed) whose daemon advertises `fabric-lan-routes-v1`. */
export async function loadLanRouteServerIds(
  db: Db,
  serverIds: readonly string[]
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(inArray(server.id, [...new Set(serverIds)]))
  return new Set(rows.filter((row) => daemonAdvertisesLanRoutes(row.daemon)).map((row) => row.id))
}

/** Everything the pair rule reads for these servers: pins, their policies and daemon features. */
export async function loadLanPairInputs(
  db: Db,
  serverIds: readonly string[]
): Promise<LanPairInputs> {
  const ids = [...new Set(serverIds)]
  const [membershipsByServer, lanRouteServerIds] = await Promise.all([
    loadDatacenterMembershipsForServers(db, ids),
    loadLanRouteServerIds(db, ids),
  ])
  const datacenterIds = new Set<string>()
  for (const pins of membershipsByServer.values()) {
    for (const pin of pins) datacenterIds.add(pin.datacenterId)
  }
  return {
    membershipsByServer,
    policiesByDatacenter: await loadDatacenterPolicies(db, [...datacenterIds]),
    lanRouteServerIds,
  }
}
