/**
 * Offline sweep — a single Cron Trigger (see `wrangler.jsonc` `triggers.crons`)
 * that closes the "hard poweroff never shows offline" gap: a daemon that
 * disappears without a clean WebSocket close (power loss, network partition,
 * kernel panic) leaves no `webSocketClose`/`webSocketError` event, so nothing
 * ever tells Postgres the server went away (see src/daemon/cell/AGENTS.md →
 * "Presence model" disconnect-first trade-off).
 *
 * Design ("Option B"):
 *   1. One cheap Postgres read for servers Postgres currently believes are
 *      connected (`listConnectedServersForSweep`), plus recently-offline rows
 *      for self-heal (`listRecentlyOfflineServersForSweep`).
 *   2. Fan out a *read-only* liveness RPC to each candidate's Durable
 *      Object (`DaemonCell.checkLiveness`). It only inspects the free,
 *      runtime-tracked WebSocket auto-response timestamp — the same value
 *      the daemon's idle ping (`DAEMON_CELL_PING`) keeps warm — and never
 *      touches SQLite. A healthy server costs one Workers subrequest and
 *      nothing else.
 *   3. Stale connected servers get a Postgres write (reusing
 *      `onDaemonDisconnected`) and a notification. Live+warm servers that
 *      Postgres still marks offline get re-projected online (self-heal):
 *      AE-active candidates via Postgres-only `onDaemonConnectedFromEvidence`
 *      (no DO wake) only when the AE latest sample is newer than the offline
 *      transition; otherwise probed candidates via `onDaemonConnected` after
 *      `checkLiveness` already woke the cell.
 *
 * Cost model (AE short-circuit): **one fleet-wide Analytics Engine SQL read
 * per tick replaces N per-minute DO wakes**. Connected servers present in
 * the recent-host-sample set are provably alive — skip `checkLiveness`
 * entirely (zero subrequests). Suspects (absent from AE) keep the existing
 * check → demote path. AE-active recently-offline self-heal is also wake-free
 * (Postgres-only projection). When AE config is missing or the query throws,
 * fall back to today's check-all behavior so offline detection is never lost.
 *
 * This intentionally does NOT reintroduce a per-DO recurring alarm — every
 * `setAlarm()` reschedule is a billed SQLite row write (see do.ts "Alarm /
 * hibernation" + src/daemon/cell/AGENTS.md billing model). Centralizing the
 * "when to check" clock into one Cron Trigger avoids that cost entirely and
 * scales with the number of *connected* servers, not the number of ticks.
 *
 * Detection latency: up to one cron interval (60s, Cloudflare's finest cron
 * granularity) plus `OFFLINE_SWEEP_STALE_MS` grace — worst case is close to
 * but a good deal cheaper than re-arming a DO alarm per server. Overlap is
 * serialized by a Postgres `setting` CAS lease (`OFFLINE_SWEEP_LOCK`); each
 * tick is also bounded by `OFFLINE_SWEEP_TICK_BUDGET_MS`. Servers skipped
 * when that deadline is reached — or when they sit past `MAX_SWEEP_FANOUT` —
 * are picked up next tick by `rotateSweepBatch`. Do not "fix" truncation by
 * raising `MAX_SWEEP_FANOUT`. The tick budget is a hard deadline: awaited
 * phases race remaining time, and `OFFLINE_SWEEP_LOCK.expiresAt` covers the
 * enforced live runtime so a still-running holder cannot be stolen.
 */
import {
  type Db,
  DB_OP_TIMEOUT_MS,
  endDbConnection,
  raceWithTimeout,
  runWithDbTimeout,
} from '../../db/connection.ts'
import { resolveWorkersDb } from '../../platform/workers/workers-bindings.ts'
import { runManagedIngressOrphanSweep } from '../../features/managed/ingress-desired.ts'
import { runHostLossTick } from './host-loss-tick.ts'
import { runDatacenterRepinFanoutSweep } from '../../client/datacenters/repin-fanout.ts'
import { runNetworkProbeSweep } from '../../client/datacenters/network-probe-sweep.ts'
import { runSystemReconcileSweep } from '../../features/system/reconcile.ts'
import { runBackupsReconcileSweep } from '../../features/backups/reconcile.ts'
import { runFolderReconcileSweep } from './folder-reconcile-sweep.ts'
import { runFolderRemovalSweep } from '../../features/folders/removal.ts'
import { runPrincipalRemovalSweep } from '../../client/principals/removal-sweep.ts'
import type { FirewallApplyGate } from '../../features/firewall/enforcement.ts'
import { runFirewallPreviewSweep } from '../../features/firewall/preview.ts'
import { runLeafRenewalSweepTick } from '../../client/tls/leaf-renewal-sweep.ts'
import { runDnsCertificateCleanupTick } from '../../features/tls/dns-certificates/cleanup.ts'
import { buildDnsCertContext } from '../../client/tls/dns-certificate-context.ts'
import { runHttpIssuanceSweepTick } from '../../client/tls/http-issuance-sweep.ts'
import { peerLeafDelivery } from '../../features/tunnels/sync.ts'
import { runTunnelSweeps } from '../../features/tunnels/sweeps.ts'
import { runHostingLetsEncryptSweepTick } from '../../client/hostings/letsencrypt-sweep.ts'
import { type AlertSender, NOOP_ALERT_SENDER } from '../../features/alerts/alert-sender.ts'
import {
  ALL_GATES_OPEN,
  CRON_CADENCES,
  type CronGates,
  loadCronGates,
  isDue,
  type CronCadenceTable,
} from './cron-gates.ts'
import { type JobDueInput, type JobIdOn, jobDue, RUNTIME_DIFFERENCES } from '../../jobs/table.ts'
import { runManagedExternalAccessPendingSweep } from '../../features/managed/external-access.ts'
import { resolveAlertSender } from '../../features/alerts/resolve-alert-sender.ts'
import { retryDueDeliveries } from '../../features/notifications/emit.ts'
import { sendDueDigests } from '../../features/notifications/digest.ts'
import { pruneNotificationHistory } from '../../features/notifications/cleanup.ts'
import { alertNewOrphanFolders } from '../../features/notifications/folder-alerts.ts'
import {
  ALERT_DELIVERY_BUDGET_MS,
  notifyDemotions,
} from '../../features/alerts/notify-demotions.ts'
import { noticeDisconnectedServers } from './disconnect-notice.ts'
import { isMassDisconnect } from './mass-disconnect.ts'
import { sweepPinSilence } from '../pin-silence.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { createWorkersCommandQueue } from '../../features/commands/workers-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { parseUpgradeStepRetentionDays } from '../../features/upgrades/prune.ts'
import { resolveJobCadencesFromEnv } from '../../features/settings/job-cadences.ts'
import {
  parseExecutionLogRetentionDays,
  type R2BucketLike,
  resolveExecutionLogStore,
} from '../../features/execution-logs/store-selection.ts'
import { createDurableObjectDaemonCellRegistry } from './do-registry.ts'
import {
  onDaemonConnected,
  onDaemonConnectedFromEvidence,
  onDaemonDisconnected,
} from './control-plane-monitor.ts'
import {
  type ConnectedServerForSweep,
  listConnectedServersForSweep,
  claimDisconnectNotices,
  listRecentlyOfflineServersForSweep,
  type RecentlyOfflineServerForSweep,
  rotateSweepBatch,
} from './postgres-projection.ts'
import type { DaemonCell, DaemonCellLiveness, DaemonCellRegistry } from '../../contracts/cell.ts'
import { resolveCloudflareAnalyticsSqlConfig } from '../metrics/store-selection-workers.ts'
import {
  AE_LIVENESS_QUERY_TIMEOUT_MS,
  AE_LIVENESS_WINDOW_SECONDS,
  queryRecentlyActiveServerIds,
} from '../metrics/backends/cloudflare/sql-api.ts'
import { endOfflineSweep, tryBeginOfflineSweep } from './offline-sweep-lease.ts'
import { resolveBillingConfig } from '../../features/billing/config.ts'
import { createStripeClient } from '../../features/billing/client.ts'
import { runReconcile, shouldRunReconcile } from '../../features/billing/reconcile.ts'
import { runPendingStripeProjections } from '../../webhook/billing/stripe-projection.ts'
import { runIsolatedSweep, sweepErrorMessage, sweepTrace } from './offline-sweep-trace.ts'
import { sweepTierNoticesPhase, workersNotificationEmail } from './offline-sweep-email.ts'
import {
  runUpgradeMaintenanceSafely,
  sweepAuditHistorySafely,
  sweepCommandHistorySafely,
  sweepDaemonTrustSafely,
  sweepExpiredCommandDispatchSafely,
  sweepExpiredExecutionLogsSafely,
  sweepExpiredWebhookDeliveriesSafely,
  sweepPeakHistorySafely,
  sweepUpgradeHistorySafely,
} from './offline-sweep-retention.ts'

// Moved to sibling modules; re-exported so existing importers keep working.
export { runIsolatedSweep, sweepErrorMessage } from './offline-sweep-trace.ts'
export {
  runUpgradeMaintenanceSafely,
  sweepAuditHistorySafely,
  sweepCommandHistorySafely,
  sweepDaemonTrustSafely,
  sweepExpiredCommandDispatchSafely,
  sweepExpiredExecutionLogsSafely,
  sweepExpiredWebhookDeliveriesSafely,
  sweepPeakHistorySafely,
  sweepUpgradeHistorySafely,
} from './offline-sweep-retention.ts'

/**
 * Grace beyond the daemon's ~60s idle-ping cadence before declaring a server
 * stale on Workers. Self-hosted uses the longer `DAEMON_OFFLINE_SWEEP_MS`
 * (150 s) instead: the Redis cell coalesces `lastInboundAt` writes
 * (`redis/cell.ts`), so a live socket can show an inbound time that old. Here
 * the value comes from the Durable Object's own auto-response timestamp, which
 * is not coalesced, so 90 s is enough and raising it would only delay
 * disconnect notices and the HA host-loss `sweep_stale` marks.
 */
export const OFFLINE_SWEEP_STALE_MS = RUNTIME_DIFFERENCES.offlineCutoffMs.workers

/** Stay comfortably under the Workers-paid subrequest ceiling (1000/invocation). */
export const MAX_SWEEP_FANOUT = 900

/** Connected stale-check budget — remainder reserved for self-heal. */
export const CONNECTED_SWEEP_BUDGET = 700

/** Recently-offline self-heal budget — not starved by connected rows. */
export const SELF_HEAL_SWEEP_BUDGET = MAX_SWEEP_FANOUT - CONNECTED_SWEEP_BUDGET

/** Bound in-flight liveness RPCs per tick instead of bursting the whole batch at once. */
const FANOUT_CONCURRENCY = 25

/** Wall-clock budget for one cron tick, well under the 60 s cadence. */
export const OFFLINE_SWEEP_TICK_BUDGET_MS = 45_000

/**
 * Reserved slice so `demoteStale` / `healServers` always run on what was
 * already probed — a probed-but-unwritten demotion is a lost minute of
 * accuracy.
 */
export const DEMOTION_RESERVE_MS = 8_000

// Re-exported: the sweep's tests and callers have always reached for it here,
// and the definition now lives with the delivery it bounds.
export { ALERT_DELIVERY_BUDGET_MS } from '../../features/alerts/notify-demotions.ts'

/** Hard deadline per `checkLiveness` DO RPC. */
export const LIVENESS_RPC_TIMEOUT_MS = 5_000

export type SweepOnceStats = {
  probed: number
  stale: number
  healed: number
}

const EMPTY_SWEEP_STATS: SweepOnceStats = {
  probed: 0,
  stale: 0,
  healed: 0,
}

let lastScheduledTimeForTests: number | undefined

/** Test helper — last `scheduledTime` forwarded into {@link runOfflineSweep}. */
export function takeLastOfflineSweepScheduledTimeForTests(): number | undefined {
  const value = lastScheduledTimeForTests
  lastScheduledTimeForTests = undefined
  return value
}

// The predicate and the two message strings live in ./mass-disconnect.ts:
// the self-hosted Deno sweep needs them too, and it cannot import this
// Workers-typed module to get them. Re-exported so existing importers of
// this module keep working.
export {
  isMassDisconnect,
  MASS_DISCONNECT_ABSOLUTE,
  MASS_DISCONNECT_MIN_SERVERS,
  MASS_DISCONNECT_RATIO,
} from './mass-disconnect.ts'

async function withBoundedConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  let cursor = 0
  async function worker(): Promise<void> {
    if (shouldStop?.()) return
    const index = cursor++
    if (index >= items.length) return
    await fn(items[index])
    await worker()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

type SweepCandidate = {
  id: string
  postgresConnected: boolean
  connectedAt: string | null
}

/**
 * Grace bookkeeping for connected sockets whose auto-response timestamp is
 * still null — bounded in-memory state only (never DO SQLite). Per-isolate:
 * the durable `OFFLINE_SWEEP_LOCK` lease is what stops two isolates forming
 * contradictory first-null observations in the same minute.
 */
const firstNullObservedAtMs = new Map<string, number>()

/** Test helper — clears null-grace bookkeeping between cases. */
export function resetOfflineSweepNullGraceForTests(): void {
  firstNullObservedAtMs.clear()
}

/** Records or clears the first-null observation timestamp for a server. */
export function updateNullGraceBookkeeping(
  serverId: string,
  liveness: DaemonCellLiveness | null,
  nowMs: number
): void {
  if (!liveness?.connected) {
    firstNullObservedAtMs.delete(serverId)
    return
  }
  if (liveness.lastPingAtMs !== null) {
    firstNullObservedAtMs.delete(serverId)
    return
  }
  if (!firstNullObservedAtMs.has(serverId)) {
    firstNullObservedAtMs.set(serverId, nowMs)
  }
}

function pruneNullGraceBookkeeping(activeServerIds: ReadonlySet<string>): void {
  for (const serverId of firstNullObservedAtMs.keys()) {
    if (!activeServerIds.has(serverId)) {
      firstNullObservedAtMs.delete(serverId)
    }
  }
}

export function isStale(
  serverId: string,
  liveness: DaemonCellLiveness | null,
  nowMs: number,
  _connectedAt: string | null
): boolean {
  if (!liveness?.connected) return true
  if (liveness.lastPingAtMs !== null) {
    return nowMs - liveness.lastPingAtMs > OFFLINE_SWEEP_STALE_MS
  }
  const firstNullAt = firstNullObservedAtMs.get(serverId)
  if (firstNullAt === undefined) return false
  return nowMs - firstNullAt > OFFLINE_SWEEP_STALE_MS
}

function isLiveAndWarm(liveness: DaemonCellLiveness | null, nowMs: number): boolean {
  if (!liveness?.connected) return false
  if (liveness.lastPingAtMs === null) return false
  return nowMs - liveness.lastPingAtMs <= OFFLINE_SWEEP_STALE_MS
}

function mergeSweepCandidates(
  connected: ConnectedServerForSweep[],
  recentlyOffline: RecentlyOfflineServerForSweep[]
): SweepCandidate[] {
  const byId = new Map<string, SweepCandidate>()
  for (const candidate of connected) {
    byId.set(candidate.id, {
      id: candidate.id,
      postgresConnected: true,
      connectedAt: candidate.connectedAt,
    })
  }
  for (const candidate of recentlyOffline) {
    if (byId.has(candidate.id)) continue
    byId.set(candidate.id, {
      id: candidate.id,
      postgresConnected: false,
      connectedAt: candidate.connectedAt,
    })
  }
  return [...byId.values()]
}

/**
 * AE-direct self-heal is only safe when the latest host sample is strictly
 * newer than the offline transition. A sample written shortly before a clean
 * `webSocketClose` stays inside the 180s AE window and must not undo a correct
 * offline projection without `checkLiveness`.
 */
export function canDirectHealFromAeEvidence(
  offlineAt: string,
  latestSampleAtMs: number | undefined
): boolean {
  if (latestSampleAtMs === undefined) return false
  const offlineAtMs = Date.parse(offlineAt)
  if (!Number.isFinite(offlineAtMs)) return false
  return latestSampleAtMs > offlineAtMs
}

/**
 * Resolve the AE recently-active serverId → latestAtMs map for this cron tick.
 * Returns `null` when AE is unavailable or the query fails — callers must
 * fall back to check-all so offline detection is never lost.
 */
async function resolveRecentlyActiveServerIds(
  env: CloudflareBindings
): Promise<Map<string, number> | null> {
  const config = resolveCloudflareAnalyticsSqlConfig(env)
  if (!config) {
    sweepTrace('ae-unavailable')
    return null
  }
  try {
    return await queryRecentlyActiveServerIds(config, {
      sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
      signal: AbortSignal.timeout(AE_LIVENESS_QUERY_TIMEOUT_MS),
    })
  } catch (err) {
    sweepTrace('ae-query-failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export type SweepOnceDeps = {
  registry?: DaemonCellRegistry
  /** serverId → latest AE host-sample epoch ms; null = AE unavailable. */
  resolveActiveServerIds?: () => Promise<Map<string, number> | null>
  listConnected?: (db: Db) => Promise<ConnectedServerForSweep[]>
  listRecentlyOffline?: (db: Db) => Promise<RecentlyOfflineServerForSweep[]>
  onConnected?: (db: Db, serverId: string, cell: DaemonCell) => Promise<unknown>
  /** Postgres-only AE-direct self-heal — must not touch a DaemonCell. */
  onConnectedFromEvidence?: (
    db: Db,
    serverId: string,
    connectedAt?: string | null
  ) => Promise<unknown>
  onDisconnected?: (db: Db, serverId: string) => Promise<unknown>
  /**
   * Where an operator finds out. Defaults to {@link NOOP_ALERT_SENDER} — an
   * instance with no webhook configured still sweeps, it just does it
   * quietly. A sender may not reject; see alerts/alert-sender.ts for why an
   * alert must never fail the thing it reports on.
   */
  alertSender?: AlertSender
  nowMs?: number
  /** Stop claiming new probe indices once this wall-clock instant is passed. */
  deadlineMs?: number
}

async function probeCandidates(
  batch: SweepCandidate[],
  registry: DaemonCellRegistry,
  nowMs: number,
  probeDeadlineMs: number
): Promise<{ staleIds: string[]; healIds: string[]; probed: number }> {
  const staleIds: string[] = []
  const healIds: string[] = []
  let probed = 0

  await withBoundedConcurrency(
    batch,
    FANOUT_CONCURRENCY,
    async (candidate) => {
      let liveness: DaemonCellLiveness | null = null
      try {
        probed += 1
        // Half-open reaping still runs inside `/rpc/liveness` (`#reapUnhealthySockets`)
        // for the suspects we still wake; the absolute max-age backstop moves
        // daemon-side in a later phase.
        const cell = registry.getCell(candidate.id)
        const check = cell.checkLiveness
        liveness = check
          ? await raceWithTimeout(
              check.call(cell),
              LIVENESS_RPC_TIMEOUT_MS,
              `liveness RPC exceeded ${LIVENESS_RPC_TIMEOUT_MS}ms`
            )
          : null
      } catch (err) {
        sweepTrace('liveness-check-failed', {
          serverId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }

      updateNullGraceBookkeeping(candidate.id, liveness, nowMs)

      if (candidate.postgresConnected) {
        if (isStale(candidate.id, liveness, nowMs, candidate.connectedAt)) {
          staleIds.push(candidate.id)
        }
        return
      }

      if (isLiveAndWarm(liveness, nowMs)) {
        healIds.push(candidate.id)
      }
    },
    () => Date.now() >= probeDeadlineMs
  )

  return { staleIds, healIds, probed }
}

async function demoteStale(
  db: Db,
  staleIds: string[],
  onDisconnected: (db: Db, serverId: string) => Promise<unknown>,
  deadlineMs: number,
  connectedBefore = 0,
  alertSender: AlertSender = NOOP_ALERT_SENDER
): Promise<void> {
  if (staleIds.length === 0) return

  sweepTrace('stale-detected', { count: staleIds.length })
  const massDisconnect = isMassDisconnect(staleIds.length, connectedBefore)

  const demoted: string[] = []
  if (massDisconnect) {
    sweepTrace('notify-mass-disconnect', {
      staleCount: staleIds.length,
      connectedBefore,
      ratio:
        connectedBefore > 0 ? Math.round((staleIds.length / connectedBefore) * 100) / 100 : null,
    })
  }
  await withBoundedConcurrency(
    staleIds,
    FANOUT_CONCURRENCY,
    async (serverId) => {
      try {
        await onDisconnected(db, serverId)
        demoted.push(serverId)
        sweepTrace('notify-offline', { serverId })
      } catch (err) {
        sweepTrace('mark-offline-failed', {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    () => Date.now() >= deadlineMs
  )

  // Alerting happens after the demotions, never interleaved with them.
  //
  // The fan-out's `shouldStop` gates claiming the next index, so an alert
  // awaited inside a worker spends tick budget: a webhook that hangs for its
  // full timeout, times N stale hosts over FANOUT_CONCURRENCY workers, and the
  // deadline fires with hosts still marked online. That is the alerting path
  // causing the outage it exists to report. Demote first, tell afterwards,
  // and give the telling whatever budget is left rather than the demotions'.
  await notifyDemotions(
    demoted,
    massDisconnect ? { staleCount: staleIds.length, connectedBefore } : null,
    alertSender,
    Math.min(deadlineMs - Date.now(), ALERT_DELIVERY_BUDGET_MS),
    sweepTrace
  )
}

async function healServers(
  db: Db,
  healIds: string[],
  registry: DaemonCellRegistry,
  onConnected: (db: Db, serverId: string, cell: DaemonCell) => Promise<unknown>,
  deadlineMs: number
): Promise<void> {
  if (healIds.length === 0) return

  sweepTrace('self-heal-detected', { count: healIds.length })

  await withBoundedConcurrency(
    healIds,
    FANOUT_CONCURRENCY,
    async (serverId) => {
      try {
        const cell = registry.getCell(serverId)
        await onConnected(db, serverId, cell)
      } catch (err) {
        sweepTrace('self-heal-failed', {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    () => Date.now() >= deadlineMs
  )
}

/** AE-direct self-heal: Postgres-only — never resolves a cell or getSnapshot. */
async function healServersFromEvidence(
  db: Db,
  candidates: Array<{ id: string; connectedAt: string | null }>,
  onConnectedFromEvidence: (
    db: Db,
    serverId: string,
    connectedAt?: string | null
  ) => Promise<unknown>,
  deadlineMs: number
): Promise<void> {
  if (candidates.length === 0) return

  sweepTrace('self-heal-direct', { count: candidates.length })

  await withBoundedConcurrency(
    candidates,
    FANOUT_CONCURRENCY,
    async (candidate) => {
      try {
        await onConnectedFromEvidence(db, candidate.id, candidate.connectedAt)
      } catch (err) {
        sweepTrace('self-heal-failed', {
          serverId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    () => Date.now() >= deadlineMs
  )
}

type SweepResolvedDeps = Required<
  Pick<
    SweepOnceDeps,
    'registry' | 'onConnected' | 'onConnectedFromEvidence' | 'onDisconnected' | 'alertSender'
  >
>

/** Shared tick inputs for the AE-short-circuit and fallback sweep paths. */
type SweepOnceContext = {
  db: Db
  deps: SweepResolvedDeps
  connected: ConnectedServerForSweep[]
  recentlyOffline: RecentlyOfflineServerForSweep[]
  nowMs: number
  deadlineMs: number
  probeDeadlineMs: number
}

function remainingMs(deadlineMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(deadlineMs)) return Number.POSITIVE_INFINITY
  return deadlineMs - nowMs
}

/**
 * Run one awaited phase against the tick deadline. Timed-out or already-due
 * phases log `budget-exhausted` and return false so callers skip later work.
 */
async function runBoundedPhase(
  deadlineMs: number,
  phase: string,
  work: () => Promise<void>
): Promise<boolean> {
  const left = remainingMs(deadlineMs)
  if (left <= 0) {
    sweepTrace('budget-exhausted', { phase })
    return false
  }
  try {
    if (!Number.isFinite(left)) {
      await work()
      return true
    }
    await raceWithTimeout(work(), left, `offline-sweep ${phase} exceeded remaining budget`)
    return true
  } catch (err) {
    sweepTrace('budget-exhausted', {
      phase,
      error: sweepErrorMessage(err),
    })
    return false
  }
}

/** Fallback path: today's check-all behavior (AE unavailable / query failed). */
async function sweepOnceFallback(ctx: SweepOnceContext): Promise<SweepOnceStats> {
  const { db, deps, connected, recentlyOffline, nowMs, deadlineMs, probeDeadlineMs } = ctx
  const connectedBatch = rotateSweepBatch(connected, CONNECTED_SWEEP_BUDGET, nowMs)
  const selfHealBatch = rotateSweepBatch(recentlyOffline, SELF_HEAL_SWEEP_BUDGET, nowMs)
  const candidates = mergeSweepCandidates(connectedBatch, selfHealBatch)
  if (candidates.length === 0) return { ...EMPTY_SWEEP_STATS }

  const totalCandidates = connected.length + recentlyOffline.length
  const truncated = totalCandidates > candidates.length
  if (truncated) {
    sweepTrace('truncated', {
      total: totalCandidates,
      checked: candidates.length,
      connectedTotal: connected.length,
      connectedChecked: connectedBatch.length,
      selfHealTotal: recentlyOffline.length,
      selfHealChecked: selfHealBatch.length,
    })
  }

  const { staleIds, healIds, probed } = await probeCandidates(
    candidates,
    deps.registry,
    nowMs,
    probeDeadlineMs
  )

  if (
    !(await runBoundedPhase(deadlineMs, 'demote', () =>
      demoteStale(db, staleIds, deps.onDisconnected, deadlineMs, connected.length, deps.alertSender)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  pruneNullGraceBookkeeping(new Set(candidates.map((c) => c.id)))
  if (
    !(await runBoundedPhase(deadlineMs, 'heal', () =>
      healServers(db, healIds, deps.registry, deps.onConnected, deadlineMs)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  return { probed, stale: staleIds.length, healed: healIds.length }
}

/** AE-active path: skip DO wakes for hosts with a recent metrics sample. */
async function sweepOnceWithAe(
  ctx: SweepOnceContext,
  activeById: Map<string, number>
): Promise<SweepOnceStats> {
  const { db, deps, connected, recentlyOffline, nowMs, deadlineMs, probeDeadlineMs } = ctx
  const suspects = connected.filter((c) => !activeById.has(c.id))
  const suspectBatch = rotateSweepBatch(suspects, CONNECTED_SWEEP_BUDGET, nowMs)

  // Cap all self-heal work (AE-direct + probe) by SELF_HEAL_SWEEP_BUDGET
  // before partitioning — otherwise a large AE-active recently-offline set
  // bypasses the budget. AE-direct heals are Postgres-only (no DO wake);
  // probed heals still go through healServers after checkLiveness.
  const selfHealRotated = rotateSweepBatch(recentlyOffline, SELF_HEAL_SWEEP_BUDGET, nowMs)
  // Only direct-heal when AE evidence is strictly newer than the offline
  // transition — a pre-disconnect sample inside the AE window is not enough.
  const directHeal = selfHealRotated.filter((c) =>
    canDirectHealFromAeEvidence(c.offlineAt, activeById.get(c.id))
  )
  const directHealIds = new Set(directHeal.map((c) => c.id))
  const selfHealBatch = selfHealRotated.filter((c) => !directHealIds.has(c.id))

  sweepTrace('ae-liveness', {
    connected: connected.length,
    aeActive: activeById.size,
    suspectsProbed: suspectBatch.length,
    selfHealDirect: directHeal.length,
  })

  const probeBatch = mergeSweepCandidates(suspectBatch, selfHealBatch)
  const { staleIds, healIds, probed } =
    probeBatch.length > 0
      ? await probeCandidates(probeBatch, deps.registry, nowMs, probeDeadlineMs)
      : { staleIds: [] as string[], healIds: [] as string[], probed: 0 }

  if (
    !(await runBoundedPhase(deadlineMs, 'demote', () =>
      demoteStale(db, staleIds, deps.onDisconnected, deadlineMs, connected.length, deps.alertSender)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  pruneNullGraceBookkeeping(new Set(probeBatch.map((c) => c.id)))

  // AE-direct heal stays separate from probed heals — must not call
  // registry.getCell() / getSnapshot().
  if (
    !(await runBoundedPhase(deadlineMs, 'heal-direct', () =>
      healServersFromEvidence(db, directHeal, deps.onConnectedFromEvidence, deadlineMs)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  if (
    !(await runBoundedPhase(deadlineMs, 'heal', () =>
      healServers(db, healIds, deps.registry, deps.onConnected, deadlineMs)
    ))
  ) {
    return {
      probed,
      stale: staleIds.length,
      healed: directHeal.length,
    }
  }
  return {
    probed,
    stale: staleIds.length,
    healed: healIds.length + directHeal.length,
  }
}

export async function sweepOnce(
  env: CloudflareBindings,
  db: Db,
  deps: SweepOnceDeps = {}
): Promise<SweepOnceStats> {
  const nowMs = deps.nowMs ?? Date.now()
  const probeDeadlineMs =
    deps.deadlineMs === undefined ? Number.POSITIVE_INFINITY : deps.deadlineMs - DEMOTION_RESERVE_MS
  const registry = deps.registry ?? createDurableObjectDaemonCellRegistry(env, db)
  const resolveActiveServerIds =
    deps.resolveActiveServerIds ?? (() => resolveRecentlyActiveServerIds(env))
  const listConnected =
    deps.listConnected ?? ((listDb: Db) => runWithDbTimeout(listDb, listConnectedServersForSweep))
  const listRecentlyOffline =
    deps.listRecentlyOffline ??
    ((listDb: Db) => runWithDbTimeout(listDb, listRecentlyOfflineServersForSweep))
  const onConnected = deps.onConnected ?? onDaemonConnected
  const onConnectedFromEvidence = deps.onConnectedFromEvidence ?? onDaemonConnectedFromEvidence
  // Default demotion path tags ungraceful power-off / partition as sweep_stale
  // so it is distinguishable from a clean webSocketClose (`disconnect`).
  const onDisconnected =
    deps.onDisconnected ??
    ((dbArg: Db, serverId: string) =>
      onDaemonDisconnected(dbArg, serverId, undefined, 'sweep_stale'))

  const resolvedDeps: SweepResolvedDeps = {
    registry,
    onConnected,
    onConnectedFromEvidence,
    onDisconnected,
    alertSender: deps.alertSender ?? NOOP_ALERT_SENDER,
  }

  const connected = await listConnected(db)
  const recentlyOffline = await listRecentlyOffline(db)
  if (connected.length === 0 && recentlyOffline.length === 0) {
    sweepTrace('no-candidates')
    return { ...EMPTY_SWEEP_STATS }
  }

  let activeById: Map<string, number> | null
  try {
    activeById = await resolveActiveServerIds()
  } catch (err) {
    sweepTrace('ae-resolve-failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    activeById = null
  }
  const ctx: SweepOnceContext = {
    db,
    deps: resolvedDeps,
    connected,
    recentlyOffline,
    nowMs,
    deadlineMs: deps.deadlineMs ?? Number.POSITIVE_INFINITY,
    probeDeadlineMs,
  }
  if (activeById === null) {
    return await sweepOnceFallback(ctx)
  }

  return await sweepOnceWithAe(ctx, activeById)
}

type CronTlsRenewal = {
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

async function sweepOnceSafely(
  env: CloudflareBindings,
  db: Db,
  deps: SweepOnceDeps = {}
): Promise<SweepOnceStats> {
  try {
    return await sweepOnce(env, db, deps)
  } catch (err) {
    sweepTrace('sweep-failed', { error: sweepErrorMessage(err) })
    return { ...EMPTY_SWEEP_STATS }
  }
}

/**
 * P1-5: Run host-loss and return-fence early, with their own budget and retry guards.
 * Moved before optional phases to ensure they run even if earlier phases exhaust the budget.
 * Inside the tick the host-loss sweep runs first, then the return fence.
 */
async function runHostLossAndReturnFenceFirst(
  db: Db,
  queue: NonNullable<CloudflareBindings['TURBOPANEL_COMMAND_QUEUE']> | undefined,
  env: CloudflareBindings,
  jobDueNow: JobDueNow
): Promise<void> {
  if (!queue || !jobDueNow('host-loss')) return
  const commandQueue = createWorkersCommandQueue(queue)
  try {
    // Host-loss runs first, then the return fence (see runHostLossTick).
    await runHostLossTick(db, {
      commandQueue,
      registry: createDurableObjectDaemonCellRegistry(env, db),
      env: env as unknown as Record<string, string | undefined>,
    })
  } catch (err) {
    sweepTrace('host-loss-tick-failed', { error: sweepErrorMessage(err) })
  }
}

/** What the queued cron sweeps read: the tick's connections, gates and clock. */
type QueuedCronSweepContext = {
  db: Db
  queue: NonNullable<CloudflareBindings['TURBOPANEL_COMMAND_QUEUE']>
  tlsRenewal: CronTlsRenewal | null | undefined
  firewallApplyGate: FirewallApplyGate
  registry: DaemonCellRegistry
  env: CloudflareBindings
  signal?: AbortSignal
  gates?: CronGates
  scheduledTime?: number
  /** The tick's resolved cadences; the defaults when omitted. */
  cadences?: CronCadenceTable
}

async function runQueuedCronSweeps(ctx: QueuedCronSweepContext): Promise<void> {
  const { db, registry, signal, tlsRenewal } = ctx
  const jobDueNow = jobDueNowFor({
    gates: ctx.gates ?? ALL_GATES_OPEN,
    scheduledTime: ctx.scheduledTime,
    cadences: ctx.cadences ?? CRON_CADENCES,
    queue: true,
    secrets: tlsRenewal != null,
  })
  try {
    const commandQueue = createWorkersCommandQueue(ctx.queue)
    // Note: host-loss tick now runs first in runOfflineSweep (P1-5) before optional phases,
    // so it is not called here anymore.
    await runReconnectRepairSweeps(ctx, jobDueNow, commandQueue)
    await runHostingLetsEncryptStep(ctx, jobDueNow, commandQueue)
    if (tlsRenewal) await runCertificateAndIngressSweeps(ctx, jobDueNow, commandQueue, tlsRenewal)
    // Automatic network fallback: ask the servers whether the network that
    // carries server-to-server traffic still works, and mark the ones nobody
    // can reach. Only stamps `ip.repin_pending_fanout_at`; the fan-out above
    // drains it on a later tick.
    if (jobDueNow('network-probe-sweep'))
      await runIsolatedSweep(signal, 'network-probe-sweep-failed', () =>
        runNetworkProbeSweep(db, registry)
      )
  } catch (err) {
    sweepTrace('system-reconcile-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Reconnect-repair sweeps: each has its own five minute throttle or works on
 * expiry-scale dates, so they run on a staggered five minute catch-up, and
 * only while a server is connected (nothing can be sent to one that is not).
 */
async function runReconnectRepairSweeps(
  ctx: QueuedCronSweepContext,
  jobDueNow: JobDueNow,
  commandQueue: CommandQueue
): Promise<void> {
  const { db, signal, tlsRenewal, firewallApplyGate } = ctx
  // System reconcile keeps a 5 minute throttle on its own last command, so the
  // shared rule (`jobs/table.ts`) runs it every minute while the gate shows a
  // candidate and otherwise on its slot.
  if (jobDueNow('system-reconcile')) await runSystemReconcileSweep(db, commandQueue)
  // Each sweep below is isolated: a failure never aborts the others.
  // Backup policy sets after a reconnect.
  if (jobDueNow('backups-reconcile-sweep'))
    await runIsolatedSweep(signal, 'backups-reconcile-sweep-failed', () =>
      runBackupsReconcileSweep(db, commandQueue, {
        copyDeps: tlsRenewal
          ? {
              secretsConfig: tlsRenewal.secretsConfig,
              dataEncryptionSecrets: tlsRenewal.dataEncryptionSecrets,
            }
          : undefined,
      })
    )
  // Folders of deleted assets the host has not confirmed gone.
  if (jobDueNow('folder-removal-sweep'))
    await runIsolatedSweep(signal, 'folder-removal-sweep-failed', () =>
      runFolderRemovalSweep(db, commandQueue)
    )
  // Hosting Accounts of deleted projects whose folders are gone.
  if (jobDueNow('principal-removal-sweep'))
    await runIsolatedSweep(signal, 'principal-removal-sweep-failed', () =>
      runPrincipalRemovalSweep(db, commandQueue, tlsRenewal?.secretsConfig)
    )
  // A fresh folder listing from servers that have folders, every few hours, so
  // a folder removed or added by hand is noticed.
  if (jobDueNow('folder-reconcile-sweep'))
    await runIsolatedSweep(signal, 'folder-reconcile-sweep-failed', () =>
      runFolderReconcileSweep(db, commandQueue, tlsRenewal?.secretsConfig)
    )
  // Firewall previews after a reconnect. The gate is the deploy-time apply
  // key: without it an opted-in host that applied would be sent a teardown on
  // every reconnect.
  if (jobDueNow('firewall-preview-sweep'))
    await runIsolatedSweep(signal, 'firewall-preview-sweep-failed', () =>
      runFirewallPreviewSweep(db, commandQueue, { applyGate: firewallApplyGate })
    )
}

/**
 * Let's Encrypt requests waiting for DNS. With the secrets bundle a newly
 * pinned certificate goes out at once; without it the panel asks for a redeploy.
 */
async function runHostingLetsEncryptStep(
  ctx: QueuedCronSweepContext,
  jobDueNow: JobDueNow,
  commandQueue: CommandQueue
): Promise<void> {
  const { db, signal, tlsRenewal } = ctx
  if (!jobDueNow('hosting-certificate-sweep')) return
  await runIsolatedSweep(signal, 'hosting-letsencrypt-sweep-failed', () =>
    runHostingLetsEncryptSweepTick(db, {
      ...(signal ? { signal } : {}),
      ...(tlsRenewal
        ? {
            apply: {
              commandQueue,
              secretsConfig: tlsRenewal.secretsConfig,
              dataEncryptionSecrets: tlsRenewal.dataEncryptionSecrets,
            },
          }
        : {}),
    })
  )
}

/** Certificate, tunnel and ingress sweeps that need the secrets bundle. */
async function runCertificateAndIngressSweeps(
  ctx: QueuedCronSweepContext,
  jobDueNow: JobDueNow,
  commandQueue: CommandQueue,
  tlsRenewal: CronTlsRenewal
): Promise<void> {
  const { db, signal, registry, env } = ctx
  // Resumes from the durable LEAF_RENEWAL_SWEEP_LOCK cursor (advanced per
  // bounded batch; reset when the sweep completes or the cursor is invalid).
  if (jobDueNow('leaf-renewal'))
    await runIsolatedSweep(signal, 'leaf-renewal-sweep-failed', () =>
      runLeafRenewalSweepTick(db, commandQueue, {
        ...tlsRenewal,
        deliverPeerLeaf: peerLeafDelivery(commandQueue, tlsRenewal),
      })
    )
  // Tunnel tables, connectors, removals, token recheck and connector status:
  // the one list the self-hosted timer also runs (`features/tunnels/sweeps.ts`).
  // On its registry cadence, or at once while a removal, rotation or new portal needs it.
  if (jobDueNow('tunnel-sweeps'))
    await runTunnelSweeps(db, { commandQueue, ...tlsRenewal }, (label, sweep) =>
      runIsolatedSweep(signal, label, sweep)
    )
  // DNS-validated certificates: the control plane no longer orders or renews them.
  // Only challenge records it made are removed, through the DNS provider.
  if (jobDueNow('dns-certificate-cleanup'))
    await runIsolatedSweep(signal, 'dns-certificate-sweep-failed', () =>
      runDnsCertificateCleanupTick(
        buildDnsCertContext(db, { secrets: tlsRenewal.dataEncryptionSecrets })
      )
    )
  // Certificates a serving server orders at the panel's request: moves each open
  // request on, hands a finished pair to the sites, starts first orders and renewals.
  if (jobDueNow('http-certificate-issuance'))
    await runIsolatedSweep(signal, 'http-certificate-sweep-failed', () =>
      runHttpIssuanceSweepTick(db, {
        registry,
        push: { commandQueue, secretsConfig: tlsRenewal.secretsConfig },
        secrets: tlsRenewal.dataEncryptionSecrets,
        env: env as unknown as Record<string, string | undefined>,
      })
    )
  // Orphaned ProxySQL frontends: teardown needs a full
  // `managed.ingress.reconcile`, so it can only run when the cron has the
  // secrets bundle (same gate as leaf renewal).
  if (jobDueNow('managed-ingress-orphan-sweep'))
    await runIsolatedSweep(signal, 'managed-ingress-orphan-sweep-failed', () =>
      runManagedIngressOrphanSweep(db, commandQueue, tlsRenewal)
    )
  // Automatic membership repins: the presence path only stamps
  // `ip.repin_pending_fanout_at` (hello / DO must not enqueue);
  // the routing fan-out needs the same secrets bundle as leaf renewal.
  if (jobDueNow('datacenter-repin-fanout-sweep'))
    await runIsolatedSweep(signal, 'datacenter-repin-fanout-sweep-failed', () =>
      runDatacenterRepinFanoutSweep(db, commandQueue, tlsRenewal)
    )
  // An external-access change a server never confirmed is pushed again to the
  // connected servers (the self-hosted tick runs the same sweep).
  if (jobDueNow('managed-external-access-pending-sweep'))
    await runIsolatedSweep(signal, 'managed-external-access-pending-sweep-failed', () =>
      runManagedExternalAccessPendingSweep(db, commandQueue, tlsRenewal)
    )
}

function capDbTimeout(deadlineMs: number): number {
  const left = remainingMs(deadlineMs)
  if (!Number.isFinite(left)) return DB_OP_TIMEOUT_MS
  return Math.max(1, Math.min(DB_OP_TIMEOUT_MS, left))
}

function shouldRunScheduledPhase(
  scheduledTime: number | undefined,
  shouldRun: (scheduledTimeMs: number) => boolean
): boolean {
  return scheduledTime !== undefined && shouldRun(scheduledTime)
}

/**
 * Phases a tick did not run, plus the cadences in force for it
 * (`TURBOPANEL_JOB_CADENCES`) so the skipped-phase list agrees with what the
 * tick would really have scheduled.
 */
export type SkippedPhases = string[] & {
  readonly cadences: CronCadenceTable
  /** Set once the tick's gates are read: an active upgrade run makes the upgrade phase due. */
  upgradeRunActive: boolean
}

export function newSkippedPhases(cadences: CronCadenceTable = CRON_CADENCES): SkippedPhases {
  return Object.assign([] as string[], { cadences, upgradeRunActive: false })
}

/** Whether a job of the shared table (`jobs/table.ts`) runs on this tick. */
type JobDueNow = (id: JobIdOn<'workers'>) => boolean

let jobAskObserverForTests: ((id: JobIdOn<'workers'>) => void) | undefined

/** Test seam: sees every job id the cron asks the shared rule about (`null` removes it). */
export function observeJobAsksForTests(observer: ((id: JobIdOn<'workers'>) => void) | null): void {
  jobAskObserverForTests = observer ?? undefined
}

/** The shared rule for one tick: the Workers adapter's input to `jobDue`. */
function jobDueNowFor(tick: {
  gates: CronGates
  scheduledTime: number | undefined
  cadences: CronCadenceTable
  queue: boolean
  secrets: boolean
}): JobDueNow {
  const input: JobDueInput = {
    gates: tick.gates,
    cadenceDue: (job) => isDue(job, tick.scheduledTime, tick.cadences),
    queue: tick.queue,
    secrets: tick.secrets,
  }
  return (id) => {
    jobAskObserverForTests?.(id)
    return jobDue(id, input)
  }
}

/** The 'upgrade-history' phase runs for the history prune, the upgrade tick, or both. */
function upgradePhaseDue(jobDueNow: JobDueNow): boolean {
  return jobDueNow('history-prune') || jobDueNow('upgrade-tick')
}

/** The phases this tick schedules after liveness, in run order. */
export function optionalPhaseNames(
  scheduledTime: number | undefined,
  cadences: CronCadenceTable = CRON_CADENCES,
  upgradeRunActive = false
): string[] {
  const jobDueNow = jobDueNowFor({
    gates: { ...ALL_GATES_OPEN, upgradeRunActive },
    scheduledTime,
    cadences,
    queue: true,
    secrets: true,
  })
  const names = ['command-dispatch', 'webhook-deliveries', 'daemon-trust']
  if (scheduledTime !== undefined && jobDueNow('execution-log-sweep')) {
    names.push('execution-logs')
  }
  if (scheduledTime !== undefined && upgradePhaseDue(jobDueNow)) {
    names.push('upgrade-history')
  }
  if (scheduledTime !== undefined && jobDueNow('tier-notice-sweep')) {
    names.push('tier-notices')
  }
  names.push('billing-stripe-projection')
  if (
    scheduledTime !== undefined &&
    jobDueNow('billing-reconcile') &&
    shouldRunReconcile(scheduledTime)
  ) {
    names.push('billing-reconcile')
  }
  names.push('reconcile')
  return names
}

function markSkippedFrom(
  phasesSkipped: SkippedPhases,
  phase: string,
  scheduledTime: number | undefined
): void {
  const rest = optionalPhaseNames(
    scheduledTime,
    phasesSkipped.cadences,
    phasesSkipped.upgradeRunActive
  )
  const index = rest.indexOf(phase)
  phasesSkipped.push(...(index === -1 ? rest : rest.slice(index)))
}

function skipFromPhase(
  phasesSkipped: SkippedPhases,
  phase: string,
  scheduledTime: number | undefined
): void {
  sweepTrace('budget-exhausted', { phase })
  markSkippedFrom(phasesSkipped, phase, scheduledTime)
}

/**
 * Run one optional cron phase against the remaining tick deadline. On timeout
 * or a missed deadline, later phases are skipped rather than started.
 */
async function runOptionalPhase(
  deadlineMs: number,
  phase: string,
  scheduledTime: number | undefined,
  phasesSkipped: SkippedPhases,
  work: (signal: AbortSignal) => Promise<void>
): Promise<boolean> {
  const left = remainingMs(deadlineMs)
  if (left <= 0) {
    skipFromPhase(phasesSkipped, phase, scheduledTime)
    return false
  }
  // A timed-out phase keeps running in the background; the signal tells it to
  // start nothing new before the tick closes the database connection.
  const budget = new AbortController()
  try {
    if (!Number.isFinite(left)) {
      await work(budget.signal)
      return true
    }
    await raceWithTimeout(
      work(budget.signal),
      left,
      `offline-sweep ${phase} exceeded remaining budget`
    )
    return true
  } catch (err) {
    budget.abort()
    sweepTrace('budget-exhausted', {
      phase,
      error: sweepErrorMessage(err),
    })
    markSkippedFrom(phasesSkipped, phase, scheduledTime)
    return false
  }
}

/**
 * Like {@link runOptionalPhase}, but skip (and keep going) when this tick is
 * not in the phase's schedule window.
 */
async function runScheduledOptionalPhase(
  deadlineMs: number,
  phase: string,
  scheduledTime: number | undefined,
  phasesSkipped: SkippedPhases,
  shouldRun: (scheduledTimeMs: number) => boolean,
  work: () => Promise<void>
): Promise<boolean> {
  if (!shouldRunScheduledPhase(scheduledTime, shouldRun)) return true
  return runOptionalPhase(deadlineMs, phase, scheduledTime, phasesSkipped, work)
}

/**
 * The 'upgrade-history' cron phase: history prune on the `historyPrune`
 * cadence and the upgrade tick on `upgradeTick`; whichever is due runs.
 */
async function upgradePhaseWork(
  db: Db,
  env: CloudflareBindings,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  jobDueNow: JobDueNow
): Promise<void> {
  if (opts.scheduledTime === undefined) return
  if (jobDueNow('history-prune')) {
    await runWithDbTimeout(
      db,
      (database) =>
        sweepUpgradeHistorySafely(
          database,
          parseUpgradeStepRetentionDays(
            (env as { TURBOPANEL_UPGRADE_STEP_RETENTION_DAYS?: string })
              .TURBOPANEL_UPGRADE_STEP_RETENTION_DAYS
          )
        ),
      capDbTimeout(deadlineMs)
    )
    await runWithDbTimeout(db, sweepCommandHistorySafely, capDbTimeout(deadlineMs))
    await runWithDbTimeout(db, sweepAuditHistorySafely, capDbTimeout(deadlineMs))
    await runWithDbTimeout(db, sweepPeakHistorySafely, capDbTimeout(deadlineMs))
  }
  if (jobDueNow('upgrade-tick')) {
    await runUpgradeMaintenanceSafely(db, env)
  }
}

async function sweepExecutionLogsPhase(
  env: CloudflareBindings,
  opts: RunOfflineSweepOpts
): Promise<void> {
  await sweepExpiredExecutionLogsSafely(
    resolveExecutionLogStore({
      runtime: 'workers',
      r2: (env as { EXECUTION_LOGS?: R2BucketLike }).EXECUTION_LOGS,
    }),
    opts.executionLogRetentionDays ??
      parseExecutionLogRetentionDays(env.TURBOPANEL_EXECUTION_LOG_RETENTION_DAYS)
  )
}

async function runBillingOptionalPhases(
  env: CloudflareBindings,
  db: Db,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  phasesSkipped: SkippedPhases,
  jobDueNow: JobDueNow
): Promise<boolean> {
  // Billing phases: skipped wholesale when the instance has no Stripe key
  // (`resolveBillingConfig` is the switch). They run in sequence through
  // the optional-phase runner, so a failure in one skips the billing
  // phases after it for that tick (they catch up on the next one). Kept
  // that way by decision on 2026-09-08; see the v6 ledger.
  const billingConfig = resolveBillingConfig(env as unknown as Record<string, string | undefined>)
  if (!billingConfig || !jobDueNow('billing-stripe-projection')) return true

  if (
    !(await runOptionalPhase(
      deadlineMs,
      'billing-stripe-projection',
      opts.scheduledTime,
      phasesSkipped,
      async () => {
        const client = createStripeClient(billingConfig)
        await runPendingStripeProjections({
          db,
          client,
          daemonCellRegistry: createDurableObjectDaemonCellRegistry(env, db),
        })
      }
    ))
  ) {
    return false
  }

  return runScheduledOptionalPhase(
    deadlineMs,
    'billing-reconcile',
    opts.scheduledTime,
    phasesSkipped,
    (ms) => jobDueNow('billing-reconcile') && shouldRunReconcile(ms),
    async () => {
      await runReconcile({ db, nowMs: opts.nowMs })
    }
  )
}

/** Retention, webhook, trust, pin-silence and orphan-alert phases; false when the deadline cut the tick short. */
async function runMaintenanceCronPhases(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: CronTlsRenewal | null | undefined,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  phasesSkipped: SkippedPhases,
  jobDueNow: JobDueNow
): Promise<boolean> {
  const scheduledTime = opts.scheduledTime
  // Two halves: the retention delete (a cadence) and the stale-command and
  // stuck-recovery pass (only while a command, recovery or managed row is open).
  const dispatchRetention = jobDueNow('command-dispatch-sweep')
  const dispatchRecovery = jobDueNow('stale-command-sweep')
  if (
    (dispatchRetention || dispatchRecovery) &&
    !(await runOptionalPhase(deadlineMs, 'command-dispatch', scheduledTime, phasesSkipped, () =>
      runWithDbTimeout(
        db,
        () =>
          sweepExpiredCommandDispatchSafely(db, {
            retention: dispatchRetention,
            recovery: dispatchRecovery,
            commandQueue: env.TURBOPANEL_COMMAND_QUEUE
              ? createWorkersCommandQueue(env.TURBOPANEL_COMMAND_QUEUE)
              : undefined,
          }),
        capDbTimeout(deadlineMs)
      )
    ))
  ) {
    return false
  }

  if (
    jobDueNow('webhook-delivery-sweep') &&
    !(await runOptionalPhase(deadlineMs, 'webhook-deliveries', scheduledTime, phasesSkipped, () =>
      runWithDbTimeout(db, sweepExpiredWebhookDeliveriesSafely, capDbTimeout(deadlineMs))
    ))
  ) {
    return false
  }

  // The stale-key socket close stays every minute (one read, a cell is woken
  // only for a row it returns); the nonce prune rides its cadence.
  if (
    jobDueNow('stale-key-socket-close') &&
    !(await runOptionalPhase(deadlineMs, 'daemon-trust', scheduledTime, phasesSkipped, () =>
      runWithDbTimeout(
        db,
        (database) =>
          sweepDaemonTrustSafely(database, createDurableObjectDaemonCellRegistry(env, database), {
            nonces: jobDueNow('daemon-nonce-sweep'),
          }),
        capDbTimeout(deadlineMs)
      )
    ))
  ) {
    return false
  }

  // Pinned servers that are up (a TurboFabric peer still reaches them) but
  // not talking to us: staged pin silence alarms (daemon/pin-silence.ts).
  // Postgres only, no cell is woken; the sweep never throws.
  if (
    jobDueNow('pin-silence-sweep') &&
    !(await runOptionalPhase(deadlineMs, 'pin-silence', opts.scheduledTime, phasesSkipped, () =>
      runWithDbTimeout(
        db,
        async (database) => {
          await sweepPinSilence(database, tlsRenewal?.dataEncryptionSecrets, {
            email: await workersNotificationEmail(env, db, tlsRenewal),
          })
        },
        capDbTimeout(deadlineMs)
      )
    ))
  ) {
    return false
  }

  // Tell each organization about the folders that became orphans since the
  // last tick, once per orphan (see features/notifications/folder-alerts.ts).
  // The sweep itself never throws.
  if (
    jobDueNow('orphan-folder-alert-sweep') &&
    !(await runOptionalPhase(
      deadlineMs,
      'orphan-folder-alerts',
      opts.scheduledTime,
      phasesSkipped,
      async () => {
        await alertNewOrphanFolders(db, tlsRenewal?.dataEncryptionSecrets, {
          email: await workersNotificationEmail(env, db, tlsRenewal),
        })
      }
    ))
  ) {
    return false
  }
  return true
}

/** Notification retry and digest phases; false when the deadline cut the tick short. */
async function runNotificationCronPhases(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: CronTlsRenewal | null | undefined,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  phasesSkipped: SkippedPhases,
  jobDueNow: JobDueNow
): Promise<boolean> {
  // Retry notification deliveries whose backoff has elapsed (chat/webhook
  // channels; email and push have their own transports). Bounded batch, and
  // the sweep itself never throws.
  if (
    jobDueNow('notification-retry-sweep') &&
    !(await runOptionalPhase(
      deadlineMs,
      'notification-retries',
      opts.scheduledTime,
      phasesSkipped,
      async () => {
        await retryDueDeliveries(db, tlsRenewal?.dataEncryptionSecrets, {
          allowPrivateTargets: true,
          email: await workersNotificationEmail(env, db, tlsRenewal),
        })
      }
    ))
  ) {
    return false
  }

  // Send each email channel's closed digest / quiet-hours window as one
  // summary (held deliveries; see features/notifications/digest.ts).
  if (
    jobDueNow('notification-digest-sweep') &&
    !(await runOptionalPhase(
      deadlineMs,
      'notification-digests',
      opts.scheduledTime,
      phasesSkipped,
      async () => {
        await sendDueDigests(db, {
          secrets: tlsRenewal?.dataEncryptionSecrets,
          allowPrivateTargets: true,
          email: await workersNotificationEmail(env, db, tlsRenewal),
        })
      }
    ))
  ) {
    return false
  }
  return true
}

async function runOptionalCronPhases(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: CronTlsRenewal | null | undefined,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  phasesSkipped: SkippedPhases
): Promise<void> {
  const cadences = phasesSkipped.cadences
  // One statement answers "can any gated family have work?" for the whole tick.
  const gates = await loadGatesForTick(db, deadlineMs)
  phasesSkipped.upgradeRunActive = gates.upgradeRunActive
  const jobDueNow = jobDueNowFor({
    gates,
    scheduledTime: opts.scheduledTime,
    cadences,
    queue: env.TURBOPANEL_COMMAND_QUEUE != null,
    secrets: tlsRenewal != null,
  })

  if (
    !(await runMaintenanceCronPhases(
      env,
      db,
      tlsRenewal,
      opts,
      deadlineMs,
      phasesSkipped,
      jobDueNow
    ))
  )
    return
  if (
    !(await runNotificationCronPhases(
      env,
      db,
      tlsRenewal,
      opts,
      deadlineMs,
      phasesSkipped,
      jobDueNow
    ))
  )
    return

  // Inbox rows after 90 days, events and the ledger after 30, and settings of
  // people who left an organization (features/notifications/cleanup.ts). On
  // the `notificationPrune` cadence (15 minutes by default): the settings
  // pass reads the whole preference table.
  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'notification-prune',
      opts.scheduledTime,
      phasesSkipped,
      () => jobDueNow('notification-history-prune'),
      async () => {
        await pruneNotificationHistory(db)
      }
    ))
  ) {
    return
  }

  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'execution-logs',
      opts.scheduledTime,
      phasesSkipped,
      () => jobDueNow('execution-log-sweep'),
      () => sweepExecutionLogsPhase(env, opts)
    ))
  ) {
    return
  }

  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'upgrade-history',
      opts.scheduledTime,
      phasesSkipped,
      () => upgradePhaseDue(jobDueNow),
      () => upgradePhaseWork(db, env, opts, deadlineMs, jobDueNow)
    ))
  ) {
    return
  }

  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'tier-notices',
      opts.scheduledTime,
      phasesSkipped,
      () => jobDueNow('tier-notice-sweep'),
      () => sweepTierNoticesPhase(env, db, opts)
    ))
  ) {
    return
  }

  if (!(await runBillingOptionalPhases(env, db, opts, deadlineMs, phasesSkipped, jobDueNow))) {
    return
  }

  const commandQueue = env.TURBOPANEL_COMMAND_QUEUE
  if (!commandQueue) return
  await runOptionalPhase(deadlineMs, 'reconcile', opts.scheduledTime, phasesSkipped, (signal) =>
    runQueuedCronSweeps({
      db,
      queue: commandQueue,
      tlsRenewal,
      firewallApplyGate: opts.firewallApplyGate,
      registry: createDurableObjectDaemonCellRegistry(env, db),
      env,
      signal,
      gates,
      scheduledTime: opts.scheduledTime,
      cadences,
    })
  )
}

/** The tick's gates; a gate that cannot be read opens every family. */
async function loadGatesForTick(db: Db, deadlineMs: number): Promise<CronGates> {
  try {
    return await runWithDbTimeout(
      db,
      (gateDb) =>
        loadCronGates(gateDb, {
          onError: (err) => sweepTrace('gates-unreadable', { error: sweepErrorMessage(err) }),
        }),
      capDbTimeout(deadlineMs)
    )
  } catch (err) {
    sweepTrace('gates-unreadable', { error: sweepErrorMessage(err) })
    return ALL_GATES_OPEN
  }
}

export type RunOfflineSweepOpts = {
  executionLogRetentionDays?: number
  scheduledTime?: number
  nowMs?: number
  deadlineMs?: number
  /** Test seam: skip `resolveWorkersDb`. */
  db?: Db
  /** Test seam: inject `sweepOnce` deps (registry, list, AE resolver). */
  sweepOnceDeps?: SweepOnceDeps
  /** Deploy-time firewall apply key (`firewallApplyGateFromEnv`); required so a dropped gate fails the type check. */
  firewallApplyGate: FirewallApplyGate
}

/** Cron Trigger entry point (`workers.ts` `scheduled()`). */
export async function runOfflineSweep(
  env: CloudflareBindings,
  tlsRenewal: CronTlsRenewal | null | undefined,
  opts: RunOfflineSweepOpts
): Promise<void> {
  lastScheduledTimeForTests = opts.scheduledTime

  // The status-event sink is registered once by `initWorkerApp` (`workers.ts`),
  // which `scheduled()` awaits before this runs. A test that calls this directly
  // registers its own sink.

  // Fresh per-invocation Hyperdrive client (Workers cannot reuse a DB socket
  // across requests/cron invocations). Always end it — leaving postgres.js
  // pools open stacks memory until the isolate hits the 128 MB limit.
  const db = opts.db ?? resolveWorkersDb(env)
  if (!db) return

  const startedAtMs = opts.nowMs ?? Date.now()
  const deadlineMs = opts.deadlineMs ?? startedAtMs + OFFLINE_SWEEP_TICK_BUDGET_MS
  // Vars only: no database read, so the cadences add no Hyperdrive statement to a tick.
  const resolved = resolveJobCadencesFromEnv(env as unknown as Record<string, string | undefined>)
  if (resolved.warnings.length > 0) {
    sweepTrace('job-cadences-adjusted', { warnings: resolved.warnings.join('; ') })
  }
  const phasesSkipped = newSkippedPhases(resolved.table)
  // Liveness and host loss run before the gates are read. Their table rows carry
  // no gate, so the gates here are open; a row that gains a gate must move the
  // gate read ahead of them.
  const earlyJobDue = jobDueNowFor({
    gates: ALL_GATES_OPEN,
    scheduledTime: opts.scheduledTime,
    cadences: resolved.table,
    queue: env.TURBOPANEL_COMMAND_QUEUE != null,
    secrets: tlsRenewal != null,
  })
  let stats: SweepOnceStats = { ...EMPTY_SWEEP_STATS }

  try {
    let lock = null
    try {
      lock = await runWithDbTimeout(
        db,
        (leaseDb) =>
          tryBeginOfflineSweep(leaseDb, startedAtMs, {
            heldUntilMs: deadlineMs + DB_OP_TIMEOUT_MS,
          }),
        capDbTimeout(deadlineMs)
      )
    } catch (err) {
      sweepTrace('lease-acquire-failed', { error: sweepErrorMessage(err) })
      return
    }
    if (!lock) {
      sweepTrace('skipped-lease-held')
      return
    }

    try {
      const ranLiveness = await runBoundedPhase(deadlineMs, 'liveness', async () => {
        const alertSender =
          opts.sweepOnceDeps?.alertSender ??
          (await resolveAlertSender(
            db,
            tlsRenewal?.dataEncryptionSecrets,
            sweepTrace,
            undefined,
            // Resolved only if an alert is actually sent this tick.
            () => workersNotificationEmail(env, db, tlsRenewal)
          ))
        if (earlyJobDue('stale-presence')) {
          stats = await sweepOnceSafely(env, db, {
            ...opts.sweepOnceDeps,
            alertSender,
            nowMs: opts.sweepOnceDeps?.nowMs ?? startedAtMs,
            deadlineMs: opts.sweepOnceDeps?.deadlineMs ?? deadlineMs,
          })
        }
        // After the demotions and the self-heal, so a server healed this tick
        // is not announced; an ordinary disconnect past the grace is.
        if (earlyJobDue('disconnect-notice'))
          await runIsolatedSweep(undefined, 'disconnect-notice-failed', () =>
            noticeDisconnectedServers(db, {
              claim: (claimDb, claimOpts) =>
                runWithDbTimeout(claimDb, (leaseDb) => claimDisconnectNotices(leaseDb, claimOpts)),
              graceMs: OFFLINE_SWEEP_STALE_MS,
              nowMs: opts.sweepOnceDeps?.nowMs ?? startedAtMs,
              resolveSender: () => Promise.resolve(alertSender),
              awaitDelivery: true,
              budgetMs: Math.min(remainingMs(deadlineMs), ALERT_DELIVERY_BUDGET_MS),
            })
          )
      })
      if (!ranLiveness) {
        markSkippedFrom(phasesSkipped, 'command-dispatch', opts.scheduledTime)
      } else {
        // P1-5: Run host-loss tick first, before optional phases, with own budget and try block
        await runHostLossAndReturnFenceFirst(db, env.TURBOPANEL_COMMAND_QUEUE, env, earlyJobDue)
        await runOptionalCronPhases(env, db, tlsRenewal, opts, deadlineMs, phasesSkipped)
      }
    } finally {
      try {
        await runWithDbTimeout(db, (leaseDb) => endOfflineSweep(leaseDb, lock))
      } catch (err) {
        sweepTrace('lease-release-failed', { error: sweepErrorMessage(err) })
      }
    }
  } finally {
    await endDbConnection(db).catch(() => {})
    sweepTrace('tick-complete', {
      durationMs: Date.now() - startedAtMs,
      probed: stats.probed,
      stale: stats.stale,
      healed: stats.healed,
      phasesSkipped,
    })
  }
}
