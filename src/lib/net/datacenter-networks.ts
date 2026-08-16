import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { ip, network } from '../db/schema.ts'
import { loadDatacenterMembershipsForServers } from './datacenter-membership.ts'

export type DatacenterCidrRequiredError = {
  kind: 'datacenter_cidr_required'
  datacenterId: string
}

export type ServerDatacenterReadyError =
  | { kind: 'datacenter_required'; serverId: string }
  | DatacenterCidrRequiredError

/**
 * Load every CIDR-bearing `network(kind='datacenter')` row for the given
 * datacenter ids, grouped as `datacenterId → cidr[]` (at most one site CIDR
 * per datacenter under the current unique index).
 */
export async function loadDatacenterCidrs(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, string[]>> {
  const byDc = new Map<string, string[]>()
  if (datacenterIds.length === 0) return byDc

  const rows = await db
    .select({
      datacenterId: network.datacenterId,
      cidr: network.cidr,
    })
    .from(network)
    .where(
      and(
        eq(network.kind, 'datacenter'),
        isNotNull(network.cidr),
        inArray(network.datacenterId, datacenterIds),
      ),
    )

  for (const row of rows) {
    if (!row.datacenterId || !row.cidr) continue
    const list = byDc.get(row.datacenterId) ?? []
    list.push(row.cidr)
    byDc.set(row.datacenterId, list)
  }
  return byDc
}

/** Prerequisite for private/replica placement: the site has a CIDR. */
export async function assertDatacenterHasCidr(
  db: Db,
  datacenterId: string,
): Promise<null | DatacenterCidrRequiredError> {
  const cidrsByDc = await loadDatacenterCidrs(db, [datacenterId])
  const cidrs = cidrsByDc.get(datacenterId) ?? []
  if (cidrs.length === 0) {
    return { kind: 'datacenter_cidr_required', datacenterId }
  }
  return null
}

/**
 * Placement prerequisite: the server has at least one datacenter membership
 * pin **and** that datacenter has a CIDR-bearing site network.
 */
export async function assertServerDatacenterReady(
  db: Db,
  serverId: string,
): Promise<null | ServerDatacenterReadyError> {
  const memberships = await loadDatacenterMembershipsForServers(db, [serverId])
  const pins = memberships.get(serverId) ?? []
  const first = pins[0]
  if (!first) {
    return { kind: 'datacenter_required', serverId }
  }

  return await assertDatacenterHasCidr(db, first.datacenterId)
}

export type GatewayRelayReadyError =
  | { kind: 'gateway_datacenter_required'; serverId: string }
  | { kind: 'gateway_datacenter_cidr_required'; datacenterId: string }

/**
 * Gateways must hold a datacenter membership pin on a site that has a CIDR.
 * Delegates to {@link assertServerDatacenterReady} and maps the placement
 * errors onto gateway wire codes (keyed on `serverId`).
 */
export async function assertGatewayRelaysReady(
  db: Db,
  rows: ReadonlyArray<{ serverId: string; role: string }>,
): Promise<GatewayRelayReadyError | null> {
  for (const row of rows) {
    if (row.role !== 'gateway') continue
    const ready = await assertServerDatacenterReady(db, row.serverId)
    if (!ready) continue
    if (ready.kind === 'datacenter_required') {
      return {
        kind: 'gateway_datacenter_required',
        serverId: row.serverId,
      }
    }
    return {
      kind: 'gateway_datacenter_cidr_required',
      datacenterId: ready.datacenterId,
    }
  }
  return null
}

/** True when the server has any membership pin into the given datacenter. */
export async function serverIsMemberOfDatacenter(
  db: Db,
  serverId: string,
  datacenterId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ip.id })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.serverId, serverId),
        eq(ip.datacenterId, datacenterId),
      ),
    )
    .limit(1)
  return Boolean(row)
}
