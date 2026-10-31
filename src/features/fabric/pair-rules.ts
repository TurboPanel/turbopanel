/**
 * The pair rules the deploy planner reads, as pure functions over one batched
 * load: whether two servers share a trusted LAN (no tunnel needed), and
 * whether a direct TurboFabric path exists between them.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { fabric, relay } from '../../db/schema.ts'
import { loadDatacenterPolicies } from '../net/datacenter-networks.ts'
import { loadDatacenterMembershipsForServers } from '../net/datacenter-membership.ts'
import {
  directCandidates,
  type EndpointAddressCaches,
  loadEndpointCaches,
  pairSharesTrustedLan,
} from './fabric-records.ts'
import { loadLanRouteServerIds } from './lan-pairs.ts'

export type PairRules = {
  pairSharesTrustedLan: (a: string, b: string) => boolean
  pairHasDirectTunnel: (a: string, b: string) => boolean
}

async function loadEndpointPins(db: Db, organizationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ serverId: relay.serverId, endpointAddress: relay.endpointAddress })
    .from(relay)
    .innerJoin(fabric, eq(fabric.id, relay.fabricId))
    .where(eq(fabric.organizationId, organizationId))
  const out = new Map<string, string>()
  for (const row of rows) if (row.endpointAddress) out.set(row.serverId, row.endpointAddress)
  return out
}

/** Load pins, policies, daemon features, public addresses and endpoint pins for the servers. */
export async function loadPairRules(
  db: Db,
  params: { organizationId: string; serverIds: readonly string[] }
): Promise<PairRules> {
  const ids = [...new Set(params.serverIds)]
  const [{ caches: endpointCaches }, memberships, lanRouteServerIds, pins] = await Promise.all([
    loadEndpointCaches(db, ids),
    loadDatacenterMembershipsForServers(db, ids),
    loadLanRouteServerIds(db, ids),
    loadEndpointPins(db, params.organizationId),
  ])
  const datacenterIds = new Set<string>()
  for (const rows of memberships.values()) {
    for (const pin of rows) datacenterIds.add(pin.datacenterId)
  }
  const caches: EndpointAddressCaches = {
    ...endpointCaches,
    datacenterMembershipsByServer: memberships,
    policyByDatacenter: await loadDatacenterPolicies(db, [...datacenterIds]),
    lanRouteServerIds,
  }
  const hasDirect = (from: string, to: string): boolean =>
    directCandidates(from, { serverId: to, endpointAddress: pins.get(to) ?? null }, caches).length >
    0
  return {
    pairSharesTrustedLan: (a, b) => pairSharesTrustedLan(a, b, caches),
    pairHasDirectTunnel: (a, b) => hasDirect(a, b) || hasDirect(b, a),
  }
}
