import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { network, server } from '../db/schema.ts'

export type DatacenterCidrRequiredError = {
  kind: 'datacenter_cidr_required'
  datacenterId: string
}

export type ServerDatacenterReadyError =
  | { kind: 'datacenter_required'; serverId: string }
  | DatacenterCidrRequiredError

/**
 * Load every CIDR-bearing `network(kind='datacenter')` row for the given
 * datacenter ids, grouped as `datacenterId → cidr[]`.
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

/** Prerequisite for private/replica placement: the site has at least one CIDR. */
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
 * Placement prerequisite: the server is pinned to a datacenter **and** that
 * datacenter has at least one CIDR-bearing `network(kind='datacenter')` row.
 */
export async function assertServerDatacenterReady(
  db: Db,
  serverId: string,
): Promise<null | ServerDatacenterReadyError> {
  const [row] = await db
    .select({ datacenterId: server.datacenterId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  if (!row?.datacenterId) {
    return { kind: 'datacenter_required', serverId }
  }

  return await assertDatacenterHasCidr(db, row.datacenterId)
}
