/**
 * The tunnel sweeps on a self-hosted control plane. `server.ts` calls this
 * from its one-minute certificate timer, with that tick's fresh database
 * client, the same cadence as the hosted cron. The list itself is shared with
 * the hosted cron (`features/tunnels/sweeps.ts`).
 */
import type { Db } from '../../db/connection.ts'
import { logWarn } from '../../lib/logger.ts'
import {
  TUNNEL_SWEEPS,
  runTunnelSweeps,
  type TunnelSweep,
  type TunnelSweepDeps,
} from '../../features/tunnels/sweeps.ts'

/** Runs every tunnel sweep; a sweep that throws is logged and the rest still run. Never throws. */
export async function runSelfHostedTunnelSweeps(
  db: Db,
  deps: TunnelSweepDeps,
  sweeps: readonly TunnelSweep[] = TUNNEL_SWEEPS
): Promise<void> {
  await runTunnelSweeps(
    db,
    deps,
    async (failureLabel, sweep) => {
      try {
        await sweep()
      } catch (err) {
        logWarn(
          'tunnel-sweeps',
          `${failureLabel}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    sweeps
  )
}
