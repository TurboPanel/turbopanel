/**
 * Which servers can skip the TurboFabric tunnel for a shared trusted LAN.
 *
 * Two servers that share a trusted datacenter network talk over that LAN with
 * no tunnel between them, including their cross-server container networks
 * (each routes the other's container range via its LAN address).
 *
 * The pure pair rule lives next to the ladder (`serversShareTrustedLan` in
 * `../net/private-endpoint.ts`); this module only loads its inputs.
 */
import type { Db } from '../../db/connection.ts'
import { loadDatacenterPolicies } from '../net/datacenter-networks.ts'
import { loadDatacenterMembershipsForServers } from '../net/datacenter-membership.ts'
import type { LanPairInputs } from '../net/private-endpoint.ts'

/** Everything the pair rule reads for these servers: pins and their policies. */
export async function loadLanPairInputs(
  db: Db,
  serverIds: readonly string[]
): Promise<LanPairInputs> {
  const ids = [...new Set(serverIds)]
  const membershipsByServer = await loadDatacenterMembershipsForServers(db, ids)
  const datacenterIds = new Set<string>()
  for (const pins of membershipsByServer.values()) {
    for (const pin of pins) datacenterIds.add(pin.datacenterId)
  }
  return {
    membershipsByServer,
    policiesByDatacenter: await loadDatacenterPolicies(db, [...datacenterIds]),
  }
}
