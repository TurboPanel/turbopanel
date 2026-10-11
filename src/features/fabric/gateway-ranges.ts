/**
 * Gateway ranges as they resolve for a fabric, and the one context the range
 * policy ({@link checkAdvertisedRanges}) is checked against. Shared by the
 * write paths (relay PATCH, container pool change, relay allocation) and the
 * reconcile payload builder.
 */
import type { Db } from '../../db/connection.ts'
import {
  type DatacenterSubnetRow,
  type DerivedAdvertisedRelay,
  loadDatacenterSubnetsForServers,
  resolveDerivedAdvertisedCidrsByRelay,
} from '../net/datacenter-networks.ts'
import {
  type AdvertisedRangeContext,
  type GatewayRangeSet,
  safeAdvertisedRangesByGateway,
} from './advertised-ranges.ts'
import { parseFabricOptions } from './cidr.ts'

/** What the policy compares a gateway range against, from a fabric and its relays. */
export function advertisedRangeContext(
  fabric: { cidr: string; options: unknown },
  relays: readonly { prefix: string }[],
  otherGateways: AdvertisedRangeContext['otherGateways'] = []
): AdvertisedRangeContext {
  return {
    fabricCidr: fabric.cidr,
    containerPool: parseFabricOptions(fabric.options).containerPool,
    relayPrefixes: relays.map((relay) => relay.prefix),
    otherGateways,
  }
}

/**
 * The datacenter subnets each gateway server falls back to, loaded for the
 * gateways among `relays` (none loaded when there is no gateway).
 */
export function loadGatewaySubnets(
  db: Db,
  relays: readonly DerivedAdvertisedRelay[]
): Promise<Map<string, DatacenterSubnetRow[]>> {
  const serverIds = relays.filter((relay) => relay.role === 'gateway').map((r) => r.serverId)
  return loadDatacenterSubnetsForServers(db, serverIds)
}

/**
 * The ranges each gateway advertises: its explicit list, or (when empty) the
 * IPv4 subnets of the datacenters it is pinned into. Members resolve to none.
 */
export async function loadResolvedGatewayRanges(
  db: Db,
  relays: readonly DerivedAdvertisedRelay[]
): Promise<Map<string, string[]>> {
  return resolveDerivedAdvertisedCidrsByRelay(relays, await loadGatewaySubnets(db, relays))
}

/** The resolved ranges of every gateway except `relayId`, for the overlap check. */
export function otherGatewayRanges(
  relays: readonly Pick<DerivedAdvertisedRelay, 'id' | 'serverId' | 'role'>[],
  resolved: ReadonlyMap<string, readonly string[]>,
  relayId: string
): GatewayRangeSet[] {
  return relays
    .filter((relay) => relay.role === 'gateway' && relay.id !== relayId)
    .map((relay) => ({
      id: relay.id,
      serverId: relay.serverId,
      cidrs: resolved.get(relay.id) ?? [],
    }))
}

/**
 * Resolved ranges with every range the policy refuses left out, so a stored or
 * datacenter-derived range that breaks the daemon's rules never becomes an
 * `AllowedIPs` entry (the daemon would refuse the host's whole payload).
 */
export function withoutUnsafeRanges(
  relays: readonly Pick<DerivedAdvertisedRelay, 'id' | 'serverId' | 'role'>[],
  resolved: ReadonlyMap<string, readonly string[]>,
  context: Omit<AdvertisedRangeContext, 'otherGateways'>
): Map<string, string[]> {
  const gateways: GatewayRangeSet[] = relays
    .filter((relay) => relay.role === 'gateway')
    .map((relay) => ({
      id: relay.id,
      serverId: relay.serverId,
      cidrs: resolved.get(relay.id) ?? [],
    }))
  const safe = safeAdvertisedRangesByGateway(gateways, context)
  const out = new Map<string, string[]>()
  for (const [id, cidrs] of resolved) out.set(id, safe.get(id) ?? [...cidrs])
  return out
}
