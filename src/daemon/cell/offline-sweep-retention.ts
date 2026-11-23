/**
 * Retention and maintenance sweeps that ride the offline sweep's cron tick.
 * Each one is isolated so a failure never aborts the others (see
 * offline-sweep.ts).
 */
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  COMMAND_DISPATCH_SWEEP_LIMIT,
  sweepExpiredCommandDispatch,
} from '../../features/commands/command-records.ts'
import {
  releaseStuckManagedApplying,
  sweepStaleCommands,
} from '../../features/commands/stale-sweep.ts'
import { pruneCommandHistory } from '../../features/commands/prune.ts'
import { expireStaleRecoveries } from '../../features/managed/recovery-records.ts'
import { sweepStalledFencing } from '../../features/managed/ha-recovery.ts'
import { AUTOMATIC_FAILOVER_STALE_DETECTING_MESSAGE } from '../../features/managed/recovery.ts'
import {
  sweepExpiredWebhookDeliveries,
  WEBHOOK_DELIVERY_SWEEP_LIMIT,
} from '../../features/webhook-delivery/webhook-delivery-records.ts'
import { pruneUpgradeHistory } from '../../features/upgrades/prune.ts'
import { runUpgradeMaintenance } from '../../features/upgrades/maintenance.ts'
import { closeAbandonedTerminalOpens } from '../../features/audit/audit-records.ts'
import { pruneAuditHistory } from '../../features/audit/prune.ts'
import { getAuditRetentionMonths } from '../../features/settings/audit-retention-settings.ts'
import { prunePeaks } from '../../features/servers/peak.ts'
import { pruneExpiredNonces } from '../../features/servers/daemon-nonce.ts'
import {
  EXECUTION_LOG_SWEEP_LIMIT,
  type ExecutionLogStore,
} from '../../features/execution-logs/types.ts'
import { resolveBuildLabel, resolveInstanceRevision } from '../../app/build-info.ts'
import { INSTANCE_VERSION } from '../../app/version.ts'
import { resolveColocatedServerId } from '../../client/authn/install-state.ts'
import { createDurableObjectDaemonCellRegistry } from './do-registry.ts'
import { closeSocketsWithStaleKeys } from './stale-key-sweep.ts'
import { sweepErrorMessage, sweepTrace } from './offline-sweep-trace.ts'

/**
 * Delete `dispatch` payloads whose failure-retention window elapsed.
 * Reuses this cron's already-open db; isolated so a failure here never aborts
 * the other sweeps.
 */
export async function sweepExpiredCommandDispatchSafely(
  db: Db,
  opts?: {
    commandQueue?: CommandQueue
    /** Delete expired dispatch rows (retention). Default true. */
    retention?: boolean
    /** Time out stranded commands and recoveries. Default true. */
    recovery?: boolean
  }
): Promise<void> {
  if (opts?.retention !== false) {
    try {
      const deleted = await sweepExpiredCommandDispatch(db, {
        limit: COMMAND_DISPATCH_SWEEP_LIMIT,
      })
      if (deleted > 0) {
        sweepTrace('command-dispatch-swept', { deleted })
      }
    } catch (err) {
      sweepTrace('command-dispatch-sweep-failed', {
        error: sweepErrorMessage(err),
      })
    }
  }
  if (opts?.recovery === false) return
  // Recover commands stranded non-terminal by a mid-run restart (the
  // consumer's timeout lives only in memory), then unwedge managed rows
  // stuck at 'applying' with no live command left. Same isolation: a
  // failure here never aborts the other sweeps.
  try {
    const timedOut = await sweepStaleCommands(db, { commandQueue: opts?.commandQueue })
    // A fence step that never answered ends its recovery at the deadline.
    await sweepStalledFencing(db, { commandQueue: opts?.commandQueue })
    // Recoveries first: a row still in flight keeps its managed row at
    // `applying`, and an expired one releases it itself.
    const expiredDetecting = await expireStaleRecoveries(db, {
      reason: AUTOMATIC_FAILOVER_STALE_DETECTING_MESSAGE,
    })
    const released = await releaseStuckManagedApplying(db)
    if (timedOut > 0 || released.length > 0 || expiredDetecting.length > 0) {
      sweepTrace('stale-command-swept', {
        timedOut,
        releasedManaged: released.length,
        expiredDetectingRecoveries: expiredDetecting.length,
      })
    }
  } catch (err) {
    sweepTrace('stale-command-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Drop webhook delivery ids past their replay-protection retention window.
 * Rides this cron's already-open db and is isolated the same way, so a failure
 * here never aborts the other sweeps.
 */
export async function sweepExpiredWebhookDeliveriesSafely(db: Db): Promise<void> {
  try {
    const deleted = await sweepExpiredWebhookDeliveries(db, {
      limit: WEBHOOK_DELIVERY_SWEEP_LIMIT,
    })
    if (deleted > 0) {
      sweepTrace('webhook-deliveries-swept', { deleted })
    }
  } catch (err) {
    sweepTrace('webhook-delivery-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Drop used sign-in challenges past their window, then close hosted sockets
 * whose daemon key was revoked or replaced (one read; a cell is reached only
 * for a row it returns). Each half is isolated.
 */
export async function sweepDaemonTrustSafely(
  db: Db,
  registry: DaemonCellRegistry,
  opts?: { nonces?: boolean }
): Promise<void> {
  if (opts?.nonces !== false) {
    try {
      const pruned = await pruneExpiredNonces(db)
      if (pruned > 0) sweepTrace('daemon-nonces-swept', { pruned })
    } catch (err) {
      sweepTrace('daemon-nonce-sweep-failed', { error: sweepErrorMessage(err) })
    }
  }
  try {
    const closed = await closeSocketsWithStaleKeys(db, registry)
    if (closed > 0) sweepTrace('stale-key-sockets-closed', { closed })
  } catch (err) {
    sweepTrace('stale-key-sweep-failed', { error: sweepErrorMessage(err) })
  }
}

/**
 * Prune aged upgrade steps and terminal runs. Rides this cron's already-open
 * db on the 15-minute window and is isolated so a failure never aborts the
 * other sweeps.
 */
export async function sweepUpgradeHistorySafely(db: Db, doneRetentionDays?: number): Promise<void> {
  try {
    const counts = await pruneUpgradeHistory(db, { doneRetentionDays })
    if (counts.doneSteps > 0 || counts.failedSteps > 0 || counts.runs > 0) {
      sweepTrace('upgrade-history-swept', counts)
    }
  } catch (err) {
    sweepTrace('upgrade-history-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Retention prune of audit rows older than the instance's window (see
 * features/audit/prune.ts), then the close rows owed to terminal sessions whose
 * end nobody reported. Same 15-minute window and the same isolation.
 */
export async function sweepAuditHistorySafely(db: Db): Promise<void> {
  try {
    const months = await getAuditRetentionMonths(db)
    const deleted = await pruneAuditHistory(db, { months })
    if (deleted > 0) {
      sweepTrace('audit-history-swept', { deleted })
    }
  } catch (err) {
    sweepTrace('audit-history-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
  try {
    const closed = await closeAbandonedTerminalOpens(db)
    if (closed > 0) sweepTrace('terminal-close-rows-written', { closed })
  } catch (err) {
    sweepTrace('terminal-close-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Retention prune of `peak` buckets older than the 7-day grace window (see
 * features/servers/peak.ts). Same 15-minute window and the same isolation.
 */
export async function sweepPeakHistorySafely(db: Db): Promise<void> {
  try {
    const deleted = await prunePeaks(db)
    if (deleted > 0) {
      sweepTrace('peak-history-swept', { deleted })
    }
  } catch (err) {
    sweepTrace('peak-history-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Retention prune of aged terminal `command` rows (see features/commands/prune.ts).
 * Rides the same 15-minute window and is isolated so a failure never aborts the
 * other sweeps.
 */
export async function sweepCommandHistorySafely(db: Db): Promise<void> {
  try {
    const deleted = await pruneCommandHistory(db)
    if (deleted > 0) {
      sweepTrace('command-history-swept', { deleted })
    }
  } catch (err) {
    sweepTrace('command-history-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Advance managed upgrades. The cadence is the `upgradeTick` job (default 15
 * minutes, `TURBOPANEL_JOB_CADENCES`), independent of history prune.
 * The check for a new build (and an automatic start) runs on the first tick at
 * or after this install's minute of the hour (`schedule.ts`), so once an hour.
 * Manifest fetches are cached. Dispatch is capped inside the coordinator.
 */
export async function runUpgradeMaintenanceSafely(db: Db, env: CloudflareBindings): Promise<void> {
  try {
    const registry = createDurableObjectDaemonCellRegistry(env, db)
    const envRecord = env as unknown as Record<string, string | undefined>
    const revision = resolveInstanceRevision(envRecord)
    const colocated = await resolveColocatedServerId(db, registry)
    await runUpgradeMaintenance({
      db,
      registry,
      runtime: 'workers',
      resolveManifests: true,
      env: envRecord,
      instanceInstalled: {
        version: INSTANCE_VERSION,
        commit: revision.commit,
      },
      buildLabel: resolveBuildLabel(envRecord),
      colocatedServerId: colocated,
    })
    sweepTrace('upgrade-tick')
  } catch (err) {
    sweepTrace('upgrade-tick-failed', { error: sweepErrorMessage(err) })
  }
}

/**
 * Delete command transcripts past their retention window. Rides this cron's
 * existing tick (no new timer, no new connection) and is isolated so a storage
 * failure never aborts the other sweeps.
 *
 * `retentionDays` comes from the Workers env (see `runOfflineSweep`) so hosted
 * deployments can override the 30-day default the same way the Deno path does.
 */
export async function sweepExpiredExecutionLogsSafely(
  store: ExecutionLogStore,
  retentionDays: number
): Promise<void> {
  try {
    const deleted = await store.sweepExpired({
      retentionDays,
      limit: EXECUTION_LOG_SWEEP_LIMIT,
    })
    if (deleted > 0) {
      sweepTrace('execution-logs-swept', { deleted, retentionDays })
    }
  } catch (err) {
    sweepTrace('execution-logs-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}
