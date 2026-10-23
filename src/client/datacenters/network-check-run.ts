import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { datacenter, organization, server } from '../../db/schema.ts'
import { parseDatacenterOptions } from '../../features/datacenters/datacenter-options.ts'
import { loadDatacenterMembershipsForDatacenter } from '../../features/net/datacenter-membership.ts'
import {
  type NetworkCheckReport,
  type NetworkCheckServerOutcome,
  planNetworkCheck,
  summarizeNetworkCheck,
} from '../../features/net/server-network-check.ts'
import { parseOrganizationOptions } from '../../features/organizations/organization-options.ts'
import { resolveEffectiveSshPort } from '../../features/servers/host-defaults.ts'
import { parseServerOptions } from '../../features/servers/server-metadata.ts'
import { NETWORK_CHECK_PROBE_TIMEOUT_MS, probeServerNetworkCheck } from './network-check-probe.ts'

/** Each server's ssh port: its own setting, then the network's, then the organization's, else 22. */
async function loadSshPorts(
  db: Db,
  organizationId: string,
  datacenterId: string,
  serverIds: readonly string[]
): Promise<Map<string, number>> {
  if (serverIds.length === 0) return new Map()
  const [org] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const [dc] = await db
    .select({ options: datacenter.options })
    .from(datacenter)
    .where(and(eq(datacenter.id, datacenterId), eq(datacenter.organizationId, organizationId)))
    .limit(1)
  const rows = await db
    .select({ id: server.id, options: server.options })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const orgOptions = org ? parseOrganizationOptions(org.options) : null
  const dcOptions = dc ? parseDatacenterOptions(dc.options) : null
  return new Map(
    rows.map((row) => [
      row.id,
      resolveEffectiveSshPort(parseServerOptions(row.options), dcOptions, orgOptions).sshPort,
    ])
  )
}

/**
 * Check, from each member of the network, that it can reach every other
 * member on the address pinned in this network. Never throws: a host that
 * cannot be asked reads as "not tested".
 */
export async function runNetworkCheck(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  params: { organizationId: string; datacenterId: string }
): Promise<NetworkCheckReport> {
  const pins = await loadDatacenterMembershipsForDatacenter(db, params.datacenterId)
  // One pin per server: the first address is enough to prove the path.
  const members = [
    ...new Map(
      pins.map((p) => [p.serverId, { serverId: p.serverId, address: p.address }])
    ).values(),
  ]
  const ports = await loadSshPorts(
    db,
    params.organizationId,
    params.datacenterId,
    members.map((m) => m.serverId)
  )
  const plan = planNetworkCheck(members, ports)
  const outcomes = new Map<string, NetworkCheckServerOutcome>()
  await Promise.all(
    plan.map(async (entry) => {
      outcomes.set(
        entry.serverId,
        await probeServerNetworkCheck(db, registry, {
          serverId: entry.serverId,
          targets: entry.targets,
          timeoutMs: NETWORK_CHECK_PROBE_TIMEOUT_MS,
        })
      )
    })
  )
  return summarizeNetworkCheck(params.datacenterId, plan, outcomes)
}
