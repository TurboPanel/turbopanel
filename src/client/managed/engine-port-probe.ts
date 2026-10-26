import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { classifyEngineReach, type EngineReach } from '../../features/managed/ha-host-loss.ts'
import type { EnginePortProbe } from '../../features/managed/ha-host-loss-sweep.ts'
import { haMemberDialForReporter } from '../../features/managed/ha-desired.ts'
import { getManagedEngineSpec } from '../../features/managed/index.ts'
import {
  NETWORK_CHECK_PROBE_TIMEOUT_MS,
  type NetworkCheckProbeDeps,
  probeServerNetworkCheck,
} from '../datacenters/network-check-probe.ts'

/**
 * The lost-host failover's second signal: ask one replica's daemon to open a
 * TCP connection, from its own server, to the primary's database port, at the
 * address that replica uses for replication (`server-network-check-v1`; the
 * daemon cuts the attempt off after 3 s and sends no bytes).
 *
 * Never throws. Everything but a completed attempt reads as `unknown`, which
 * can never support a promotion.
 */
export function createEnginePortProbe(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  deps: NetworkCheckProbeDeps = {}
): EnginePortProbe {
  return async ({ peer, primary, engine }): Promise<EngineReach> => {
    try {
      const spec = getManagedEngineSpec(engine)
      if (!spec || peer.serverId === primary.serverId) return 'unknown'
      const dial = await haMemberDialForReporter(db, peer.serverId, primary, spec.defaultPort)
      if (!dial) return 'unknown'
      const outcome = await probeServerNetworkCheck(
        db,
        registry,
        {
          serverId: peer.serverId,
          targets: [{ peerServerId: primary.serverId, address: dial.host, port: dial.port }],
          timeoutMs: NETWORK_CHECK_PROBE_TIMEOUT_MS,
        },
        deps
      )
      if (outcome.status !== 'checked' || outcome.results.length !== 1) return 'unknown'
      return classifyEngineReach(outcome.results[0])
    } catch {
      return 'unknown'
    }
  }
}
