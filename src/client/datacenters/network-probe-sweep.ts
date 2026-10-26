/**
 * Maintenance sweep behind the automatic network fallback (`features/net/
 * network-probe.ts` has the rules). Each tick, for every organization that has
 * two or more trusted networks, it runs the reachability check on the network
 * that carries server-to-server traffic (and on any network still carrying a
 * probe mark, so recovery is noticed), turns the answers into per-pin marks,
 * and stamps `ip.repin_pending_fanout_at` when a mark appears or goes. The
 * routing fan-out that follows is the one `repin-fanout.ts` already drains, so
 * this sweep needs no command queue and no secrets.
 *
 * Cost: one check round trip per server of a probed network, at most once per
 * {@link NETWORK_PROBE_MIN_INTERVAL_MS} per process, and only for
 * organizations that have a second network to fall back to.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { datacenter, ip } from '../../db/schema.ts'
import { loadDatacenterMembershipsForDatacenter } from '../../features/net/datacenter-membership.ts'
import {
  nextProbeMarker,
  probeMarkerOf,
  probeVerdicts,
  withProbeMarker,
} from '../../features/net/network-probe.ts'
import {
  type NetworkCheckReport,
  winningNetworkId,
} from '../../features/net/server-network-check.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { runNetworkCheck } from './network-check-run.ts'

/** A tick sooner than this after the last probe round does nothing. */
export const NETWORK_PROBE_MIN_INTERVAL_MS = 50_000
/** Networks probed in one tick (each one is a round trip to every member). */
export const NETWORK_PROBE_TICK_CAP = 10

export type TrustedNetwork = { id: string; organizationId: string; priority: number }

export type NetworkProbeDeps = {
  runCheck?: (
    db: Db,
    registry: DaemonCellRegistry | undefined,
    params: { organizationId: string; datacenterId: string }
  ) => Promise<NetworkCheckReport>
  now?: () => number
  /** Seams for host-free tests. */
  loadTrustedNetworks?: (db: Db) => Promise<Map<string, TrustedNetwork[]>>
  loadPins?: typeof loadDatacenterMembershipsForDatacenter
}

let lastRoundMs = 0

/** Test seam: forget the last round so the next tick runs. */
export function resetNetworkProbeThrottle(): void {
  lastRoundMs = 0
}

async function loadTrustedNetworksByOrganization(db: Db): Promise<Map<string, TrustedNetwork[]>> {
  const rows = await db
    .select({
      id: datacenter.id,
      organizationId: datacenter.organizationId,
      priority: datacenter.priority,
    })
    .from(datacenter)
    .where(eq(datacenter.isTrusted, true))
  const byOrg = new Map<string, TrustedNetwork[]>()
  for (const row of rows) {
    byOrg.set(row.organizationId, [...(byOrg.get(row.organizationId) ?? []), row])
  }
  // Nothing to fall back to with a single trusted network.
  return new Map([...byOrg].filter(([, networks]) => networks.length >= 2))
}

async function applyVerdicts(
  db: Db,
  datacenterId: string,
  report: NetworkCheckReport,
  nowIso: string,
  loadPins: typeof loadDatacenterMembershipsForDatacenter
): Promise<number> {
  const verdicts = probeVerdicts(report)
  const pins = await loadPins(db, datacenterId)
  let routingChanges = 0
  await forEachSequential(pins, async (pin) => {
    const verdict = verdicts.get(pin.serverId)
    if (!verdict) return
    const transition = nextProbeMarker(probeMarkerOf(pin.metadata), verdict, nowIso)
    if (!transition.write) return
    await db
      .update(ip)
      .set({
        metadata: withProbeMarker(pin.metadata, transition.marker),
        updatedAt: nowIso,
        ...(transition.change === 'none' ? {} : { repinPendingFanoutAt: nowIso }),
      })
      .where(eq(ip.id, pin.ipId))
    if (transition.change !== 'none') routingChanges += 1
  })
  return routingChanges
}

/** Networks to probe for one organization: the winner plus any that still carry a probe mark. */
async function networksToProbe(
  db: Db,
  networks: readonly TrustedNetwork[],
  loadPins: typeof loadDatacenterMembershipsForDatacenter
): Promise<string[]> {
  const winner = winningNetworkId(
    networks.map((n) => ({ id: n.id, priority: n.priority, trusted: true }))
  )
  const ids = new Set<string>(winner ? [winner] : [])
  const others = networks.filter((n) => n.id !== winner)
  await forEachSequential(others, async (network) => {
    const pins = await loadPins(db, network.id)
    const marked = pins.some((pin) => {
      const marker = probeMarkerOf(pin.metadata)
      return marker !== undefined && (marker.downSince !== undefined || marker.failures > 0)
    })
    if (marked) ids.add(network.id)
  })
  return [...ids]
}

/**
 * Run one probe round. Never throws; a network that cannot be probed is left
 * as it is. Returns how many networks were probed and how many pins changed
 * what routing does.
 */
export async function runNetworkProbeSweep(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  deps: NetworkProbeDeps = {}
): Promise<{ probed: number; routingChanges: number }> {
  const nowMs = (deps.now ?? Date.now)()
  if (!registry || nowMs - lastRoundMs < NETWORK_PROBE_MIN_INTERVAL_MS) {
    return { probed: 0, routingChanges: 0 }
  }
  lastRoundMs = nowMs
  const runCheck = deps.runCheck ?? runNetworkCheck
  const loadPins = deps.loadPins ?? loadDatacenterMembershipsForDatacenter
  const nowIso = new Date(nowMs).toISOString()
  let probed = 0
  let routingChanges = 0
  try {
    const byOrg = await (deps.loadTrustedNetworks ?? loadTrustedNetworksByOrganization)(db)
    await forEachSequential([...byOrg], async ([organizationId, networks]) => {
      const ids = await networksToProbe(db, networks, loadPins)
      await forEachSequential(ids, async (datacenterId) => {
        if (probed >= NETWORK_PROBE_TICK_CAP) return
        probed += 1
        const report = await runCheck(db, registry, { organizationId, datacenterId })
        routingChanges += await applyVerdicts(db, datacenterId, report, nowIso, loadPins)
      })
    })
  } catch (err) {
    compatLogWarn(
      'network-probe',
      `probe round failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return { probed, routingChanges }
}
