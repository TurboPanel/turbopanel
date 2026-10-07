/**
 * One sweep tick of the whole-host-loss path, shared by both runtimes (the
 * Workers cron's `reconcile` phase and the self-hosted Deno timer): decide on
 * silent primaries (`features/managed/ha-host-loss-sweep.ts`), then fence
 * demoted members that came back (`features/managed/ha-return-fence.ts`).
 *
 * Lives here, not in `features/`, because it builds the event-time health
 * probe from the runtime's cell registry; the failover modules stay free of
 * that transport (a test pins it).
 */

import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  FRESH_STANDBY_MARGIN_ENV,
  resolveAutoFailover,
  resolveFreshStandbyMarginMs,
} from '../../features/managed/auto-failover-switch.ts'
import { resolveHostLossWindowMs } from '../../features/managed/ha-host-loss.ts'
import { runHostLossSweep } from '../../features/managed/ha-host-loss-sweep.ts'
import { runReturnFenceSweep } from '../../features/managed/ha-return-fence.ts'
import { createFreshStandbyProbe } from '../../client/managed/health-probe.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'

export type HostLossTickEnv = Readonly<Record<string, string | undefined>>

export async function runHostLossTick(
  db: Db,
  deps: {
    commandQueue: CommandQueue
    registry: DaemonCellRegistry
    /** Runtime string env (Workers vars or `Deno.env.toObject()`). */
    env: HostLossTickEnv
  }
): Promise<void> {
  try {
    await runHostLossSweep(db, {
      commandQueue: deps.commandQueue,
      autoFailover: resolveAutoFailover(deps.env),
      probeStandby: createFreshStandbyProbe(db, deps.registry),
      windowMs: resolveHostLossWindowMs(deps.env),
      freshStandbyMarginMs: resolveFreshStandbyMarginMs({
        [FRESH_STANDBY_MARGIN_ENV]: deps.env[FRESH_STANDBY_MARGIN_ENV],
      }),
    })
  } catch (error) {
    compatLogWarn('managed-ha', `host loss sweep failed: ${String(error)}`)
  }
  try {
    await runReturnFenceSweep(db, deps.commandQueue)
  } catch (error) {
    compatLogWarn('managed-ha', `return fence sweep failed: ${String(error)}`)
  }
}
