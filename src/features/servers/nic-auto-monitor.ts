/**
 * When a server gets a datacenter-network address pinned to it, and the NIC
 * that address lives on is not already in the monitored set, and the server
 * has an unused NIC-slot under its cap, silently add that one NIC to the
 * monitored set — the operator never has to open server settings for the
 * common "second NIC just got a routing role" case.
 *
 * This is a narrow, additive carve-out of the standing default (v4 NIC
 * monitoring decisions, 2026-09-05): "monitor only the default-route NIC;
 * extra NICs are added explicitly." That default is unchanged for every
 * other trigger — server create, a heartbeat, an unrelated settings save.
 * This module only ever runs from a fresh datacenter-network attach
 * (`src/client/datacenters/routes.ts`), never evicts an existing monitored
 * NIC, and never turns a failure into an error for the caller: a missing
 * topology snapshot, an unresolved interface, a disconnected daemon, or no
 * free slot are all silent no-ops — the operator can still add the NIC by
 * hand in server settings exactly as before.
 */
import { eq } from 'drizzle-orm'
import type { Db, getDaemonCellRegistry } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { normalizeIpAddress } from '../../lib/ip-address.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { parseServerHostResources } from './server-metadata.ts'
import { getLatestTopologyGeneration } from './server-topology-records.ts'
import type { NetworkDeviceTopology, TopologySnapshot } from '../../contracts/topology-types.ts'
import { EMPTY_TOPOLOGY_OVERRIDES } from '../../contracts/topology-types.ts'
import { computeSlotMapping } from '../../contracts/topology-slot-mapping.ts'
import type { MetricsDeploymentKind } from '../../contracts/capability-plan.ts'
import {
  loadOrganizationOptions,
  loadServerHardwareProfile,
  loadServerTierEntitlements,
  mergeAndPersistHardwareProfile,
  pushHardwareProfileUpdate,
  resolveNicSlotLimit,
} from './hardware-profile.ts'

/**
 * The physical `uplink` device id an interface name resolves to among
 * recorded network devices, or `null` when the interface is not present, or
 * present but not an uplink (a bond/bridge member, a VLAN child, a tunnel, a
 * container bridge — none monitorable, the same rule the hardware-profile PUT
 * already enforces via `findUnmonitorableNicSlotId`).
 */
export function resolveUplinkDeviceIdByInterface(
  networks: readonly NetworkDeviceTopology[] | undefined,
  interfaceName: string
): string | null {
  const device = (networks ?? []).find(
    (candidate) => candidate.name === interfaceName && candidate.kind === 'uplink'
  )
  return device?.deviceId ?? null
}

export type NicAutoMonitorDecision =
  | { action: 'add'; nicSlotDeviceIds: string[] }
  | { action: 'skip'; reason: 'already-monitored' | 'no-free-slot' }

/**
 * Pure decision: given the server's current NIC-slot override (empty means
 * "auto: gateway only"), its topology snapshot, the candidate uplink device,
 * and its resolved slot limit, decide whether to append the device to the
 * monitored set. Never evicts — only appends, and only into genuine headroom.
 */
export function decideNicAutoMonitor(
  currentOverride: readonly string[],
  snapshot: TopologySnapshot,
  candidateDeviceId: string,
  nicSlotLimit: number
): NicAutoMonitorDecision {
  const effective = computeSlotMapping(snapshot, {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlotDeviceIds: [...currentOverride],
  }).normalNicSlots
  if (effective.includes(candidateDeviceId)) {
    return { action: 'skip', reason: 'already-monitored' }
  }
  if (effective.length >= nicSlotLimit) {
    return { action: 'skip', reason: 'no-free-slot' }
  }
  return { action: 'add', nicSlotDeviceIds: [...effective, candidateDeviceId] }
}

/**
 * Resolve the interface a freshly-pinned address is reported on, from this
 * server's own last-reported `resources.ips`. `undefined` when the address
 * has not been reported (or has no interface field) — the daemon may not
 * have sent a fresh hello since the address was assigned to it.
 */
async function resolveReportedInterface(
  db: Db,
  serverId: string,
  address: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const rawMetadata = row?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const resources = parseServerHostResources(metadata.resources)
  const normalized = normalizeIpAddress(address)
  return resources?.ips?.find((ip) => normalizeIpAddress(ip.address) === normalized)?.interface
}

/**
 * Run the auto-monitor decision for one freshly-created `(serverId,
 * address)` datacenter-network pin. Call this after the pin's transaction has
 * committed — it reads topology + hardware-profile state and, on the daemon
 * push, does live I/O, none of which belongs inside that transaction. Never
 * throws.
 */
export async function autoMonitorNicForDatacenterAttach(
  db: Db,
  registry: ReturnType<typeof getDaemonCellRegistry>,
  serverId: string,
  address: string,
  deployment: MetricsDeploymentKind
): Promise<void> {
  try {
    const interfaceName = await resolveReportedInterface(db, serverId, address)
    if (!interfaceName) return

    const latest = await getLatestTopologyGeneration(db, serverId)
    if (!latest) return
    const snapshot = latest.snapshot as TopologySnapshot
    const deviceId = resolveUplinkDeviceIdByInterface(snapshot.networks, interfaceName)
    if (!deviceId) return

    const { hardwareProfile, organizationId, serverOptions, machineClass } =
      await loadServerHardwareProfile(db, serverId)
    const currentOverride = hardwareProfile?.nicSlotDeviceIds ?? []

    const [orgOptions, tier] = await Promise.all([
      loadOrganizationOptions(db, organizationId),
      loadServerTierEntitlements(db, serverId, deployment),
    ])
    const limit = resolveNicSlotLimit({
      machineClass,
      latestSnapshot: snapshot,
      orgOptions,
      serverOptions,
      deployment,
      tier,
    })

    const decision = decideNicAutoMonitor(currentOverride, snapshot, deviceId, limit)
    if (decision.action === 'skip') return

    const persisted = await mergeAndPersistHardwareProfile(db, serverId, {
      nicSlotDeviceIds: decision.nicSlotDeviceIds,
    })
    if (persisted.notFound) return
    await pushHardwareProfileUpdate(registry, serverId, persisted.merged)
  } catch {
    // Best-effort convenience only — never let this affect the datacenter
    // attach it rides behind. The operator can still add the NIC by hand.
  }
}

/**
 * Run {@link autoMonitorNicForDatacenterAttach} for every pin in `pins`, in
 * order, against the same server's evolving state — so two new members of
 * the same server in one request are counted against a shrinking slot budget
 * rather than each reading the pre-request state. Fire-and-forget: call
 * without `await` from a route so it never delays the HTTP response.
 */
export async function autoMonitorNicsForDatacenterAttach(
  db: Db,
  registry: ReturnType<typeof getDaemonCellRegistry>,
  pins: ReadonlyArray<{ serverId: string; address: string }>,
  deployment: MetricsDeploymentKind
): Promise<void> {
  await forEachSequential(pins, (pin) =>
    autoMonitorNicForDatacenterAttach(db, registry, pin.serverId, pin.address, deployment)
  )
}
