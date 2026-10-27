/**
 * Persistence for one upgrade run. The coordinator decides; this module only
 * reads and writes. The in-memory store backs host-free tests. The drizzle
 * store is what Deno and Workers call.
 */
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server, setting, upgrade, stage, user } from '../../db/schema.ts'
import { isPostgresUniqueViolation } from '../../db/unique-violation.ts'
import { parseServerDaemonState } from '../servers/daemon-state.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  getUpgradeSettings,
  setUpgradeSettings,
  type UpgradeSettings,
} from '../settings/upgrade-settings.ts'
import {
  ensureUpgradeCheckSchedule,
  getUpgradePause,
  markUpgradeChecked,
  type UpgradePause,
} from '../settings/upgrade-control.ts'
import { getLatestAvailableBuild, setLatestAvailableBuild } from './target-resolve.ts'
import { upgradeFailureKey, type UpgradeFailureHistory } from './retry-backoff.ts'
import type { UpgradeCheckSchedule } from './schedule.ts'
import type { UpgradeTarget } from './target.ts'
import { isUpgradeRunId, stepDetail } from './decisions.ts'
import type {
  UpgradePhase,
  UpgradeSource,
  UpgradeStatus,
  UpgradeStepStatus,
  UpgradeStepUnit,
} from './vocabulary.ts'
import {
  UPGRADE_ACTIVE_STATUSES,
  UPGRADE_STEP_ACTIVE_STATUSES,
  UPGRADE_TERMINAL_STATUSES,
} from './vocabulary.ts'
import {
  activeBatchIndex,
  compareUpgradeStepRows,
  failedPlatformPhase,
  FLEET_CELL_PROBE_BUDGET,
  isTerminalStepStatus,
  PLATFORM_PHASES,
  type PlatformPhase,
  type StepSummary,
  summarizeSteps,
  UPGRADE_TICK_STEP_BUDGET,
} from './run.ts'

/** Setting row that holds the run id preflight shows before start. */
export const RESERVED_UPGRADE_RUN_KEY = 'UPGRADE_RESERVED_RUN_ID'

/** Setting row that holds the maintenance-tick step cursor for the active run. */
export const UPGRADE_TICK_CURSOR_KEY = 'UPGRADE_TICK_CURSOR'

const TERMINAL_STEP_SQL = ['done', 'skipped', 'failed', 'needs_attention'] as const

/** In-flight statuses that pin the open batch (matches `isInFlightStepStatus`). */
const BATCH_PIN_STEP_SQL = sql`('dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying')`

export type UpgradeTickCursor = {
  phase: UpgradePhase
  batchIndex: number
  afterId: string | null
}

export type UpgradeTickWindow = {
  steps: UpgradeStepRow[]
  counts: StepSummary
  phase: UpgradePhase | null
  batchIndex: number | null
  /** First platform phase with a failed / needs-attention step, else null. */
  failedPlatformPhase: PlatformPhase | null
  allTerminal: boolean
}

export type FleetProbe = {
  connected: boolean
  commit: string | null
  version: string | null
}

export type FleetPageQuery = {
  offset: number
  limit: number
  status: string
  targetCommit: string | null
}

export type FleetServerFact = {
  serverId: string
  name: string | null
  hostname: string | null
  connected: boolean
  commit: string | null
  version: string | null
  /** The daemon build's `builtAt`, when it reports one (orders same-version builds). */
  builtAt?: string | null
  features: string[]
  colocated: boolean
}

export type UpgradeRunRow = {
  id: string
  createdAt: string
  source: UpgradeSource
  channel: string
  status: UpgradeStatus
  phase: UpgradePhase | null
  startedBy: string | null
  startedByEmail: string | null
  target: UpgradeTarget
  batchPolicy: UpgradeSettings['batch']
  counts: StepSummary | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export type UpgradeStepRow = {
  id: string
  upgradeId: string
  serverId: string
  unit: UpgradeStepUnit
  phase: UpgradePhase
  batchIndex: number
  status: UpgradeStepStatus
  requestId: string | null
  attempts: number
  nextAttemptAt: string | null
  fromVersion: string | null
  toVersion: string | null
  fromCommit: string | null
  toCommit: string | null
  lastStageAt: string | null
  errorCode: string | null
  errorMessage: string | null
  detail: unknown
}

/** The commits a run would install, per unit, for the failure-history read. */
export type UpgradeFailureTargets = {
  daemonCommit: string | null
  instanceCommit: string | null
}

/** What a paused run writes on each step it never started. */
export type UpgradePausedSkip = {
  errorCode: string
  errorMessage: string
  at: string
}

export type UpgradeStore = {
  settings(): Promise<UpgradeSettings>
  saveSettings(settings: UpgradeSettings): Promise<void>
  /** The pause in force (Admin > Updates), or null. One row. */
  pause(): Promise<UpgradePause | null>
  /** The hourly check slot, created with a random minute on first use. One row. */
  checkSchedule(now: string): Promise<UpgradeCheckSchedule>
  /** Record that the hourly check ran. */
  markChecked(schedule: UpgradeCheckSchedule, at: string): Promise<void>
  /**
   * Settle every step of `upgradeId` that was never sent (`attempts` 0,
   * `pending` / `waiting`) as `skipped` — what a pause does to a run. Steps
   * already sent keep going. Returns how many were settled.
   */
  skipUndispatchedSteps(upgradeId: string, skip: UpgradePausedSkip): Promise<number>
  /**
   * Earlier failed steps (`failed`, `rolled_back`, `needs_attention`) per
   * server and unit at these target commits, keyed by
   * `upgradeFailureKey(serverId, unit)`. Only servers with failures appear.
   */
  failureHistory(targets: UpgradeFailureTargets): Promise<Map<string, UpgradeFailureHistory>>
  latestBuild(): Promise<UpgradeTarget | null>
  saveLatestBuild(target: UpgradeTarget): Promise<void>
  activeRun(): Promise<UpgradeRunRow | null>
  runById(id: string): Promise<UpgradeRunRow | null>
  insertRun(run: UpgradeRunRow, steps: readonly UpgradeStepRow[]): Promise<'created' | 'active'>
  saveRun(run: UpgradeRunRow): Promise<void>
  stepsFor(upgradeId: string): Promise<UpgradeStepRow[]>
  /**
   * One page of non-terminal steps in the open phase and batch, plus
   * fleet-wide status totals from a grouped count. `limit` is clamped to
   * {@link UPGRADE_TICK_STEP_BUDGET}.
   */
  tickWindow(
    upgradeId: string,
    cursor: UpgradeTickCursor | null,
    limit: number
  ): Promise<UpgradeTickWindow>
  countSteps(upgradeId: string): Promise<StepSummary>
  readTickCursor(runId: string): Promise<UpgradeTickCursor | null>
  writeTickCursor(runId: string, cursor: UpgradeTickCursor | null): Promise<void>
  /** True when some server's daemon commit is not `commit`. One row, not the fleet. */
  /**
   * A connected daemon not on `commit` and not built after `builtAt` (when
   * both build times are known) — a host already ahead of the target never
   * reopens a run.
   */
  anyDaemonBehind(commit: string | null, builtAt?: string | null): Promise<boolean>
  /** Facts for an already-bounded id list. Does not read the rest of the fleet. */
  factsFor(ids: readonly string[], colocatedServerId: string | null): Promise<FleetServerFact[]>
  /**
   * Write a step. When `expectedStatus` is given, the write only applies if
   * the row's status in the store still matches it (returns `false`
   * otherwise) — guards a tick's read-decide-write against a concurrent
   * hello/progress report that already moved the row past the state the tick
   * read.
   */
  saveStep(step: UpgradeStepRow, expectedStatus?: UpgradeStepStatus): Promise<boolean>
  history(offset: number, limit: number): Promise<{ runs: UpgradeRunRow[]; total: number }>
  fleetFacts(colocatedServerId: string | null): Promise<FleetServerFact[]>
  /** One SQL page. Does not wake daemon cells. */
  pageFleet(
    query: FleetPageQuery,
    colocatedServerId: string | null
  ): Promise<{ total: number; facts: FleetServerFact[] }>
  /**
   * Live cell read for a bounded id list (co-located host or the servers
   * this tick may dispatch). Fleet-wide status does not call this.
   */
  probeCandidates(ids: readonly string[]): Promise<Map<string, FleetProbe>>
  reservedRunId(): Promise<string | null>
  reserveRunId(id: string): Promise<void>
  clearReservedRunId(): Promise<void>
}

export class UpgradeActiveConflict extends Error {
  constructor() {
    super('upgrade_active')
    this.name = 'UpgradeActiveConflict'
  }
}

function asTarget(value: unknown): UpgradeTarget {
  if (typeof value === 'object' && value !== null && 'daemon' in value) {
    return value as UpgradeTarget
  }
  return { daemon: null, instance: null, ui: null }
}

function asBatch(value: unknown): UpgradeSettings['batch'] {
  if (typeof value === 'object' && value !== null && 'mode' in value && 'value' in value) {
    const batch = value as UpgradeSettings['batch']
    if (batch.mode === 'percent' || batch.mode === 'count') return batch
  }
  return { mode: 'percent', value: 100 }
}

function asCounts(value: unknown): StepSummary | null {
  if (typeof value !== 'object' || value === null || !('total' in value)) {
    return null
  }
  return value as StepSummary
}

function asPhase(value: string | null): UpgradePhase | null {
  if (value === 'colocated_daemon' || value === 'control_plane' || value === 'fleet') {
    return value
  }
  return null
}

export type UpgradeDbRow = {
  id: string
  createdAt: string
  source: string
  channel: string
  status: string
  phase: string | null
  startedBy: string | null
  target: unknown
  batchPolicy: unknown
  counts: unknown
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  startedByEmail?: string | null
}

/** The run columns every run read selects (join `user` on `startedBy` for the email). */
export const UPGRADE_RUN_COLUMNS = {
  id: upgrade.id,
  createdAt: upgrade.createdAt,
  source: upgrade.source,
  channel: upgrade.channel,
  status: upgrade.status,
  phase: upgrade.phase,
  startedBy: upgrade.startedBy,
  target: upgrade.target,
  batchPolicy: upgrade.batchPolicy,
  counts: upgrade.counts,
  error: upgrade.error,
  startedAt: upgrade.startedAt,
  finishedAt: upgrade.finishedAt,
  startedByEmail: user.email,
}

export function toRun(row: UpgradeDbRow): UpgradeRunRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    source: row.source as UpgradeSource,
    channel: row.channel,
    status: row.status as UpgradeStatus,
    phase: asPhase(row.phase),
    startedBy: row.startedBy,
    startedByEmail: row.startedByEmail ?? null,
    target: asTarget(row.target),
    batchPolicy: asBatch(row.batchPolicy),
    counts: asCounts(row.counts),
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

type StepDbRow = {
  id: string
  upgradeId: string
  serverId: string
  unit: string
  phase: string
  batchIndex: number
  status: string
  requestId: string | null
  attempts: number
  nextAttemptAt: string | null
  fromVersion: string | null
  toVersion: string | null
  fromCommit: string | null
  toCommit: string | null
  statusChangedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  detail: unknown
}

function asStepPhase(value: string): UpgradePhase {
  return value === 'colocated_daemon' || value === 'control_plane' ? value : 'fleet'
}

function toStep(row: StepDbRow): UpgradeStepRow {
  return {
    id: row.id,
    upgradeId: row.upgradeId,
    serverId: row.serverId,
    unit: row.unit === 'instance' ? 'instance' : 'daemon',
    phase: asStepPhase(row.phase),
    batchIndex: row.batchIndex,
    status: row.status as UpgradeStepStatus,
    requestId: row.requestId,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    fromCommit: row.fromCommit,
    toCommit: row.toCommit,
    lastStageAt: row.statusChangedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    detail: row.detail,
  }
}

function stepInsert(step: UpgradeStepRow) {
  return {
    id: step.id,
    upgradeId: step.upgradeId,
    serverId: step.serverId,
    unit: step.unit,
    phase: step.phase,
    batchIndex: step.batchIndex,
    status: step.status,
    requestId: step.requestId,
    attempts: step.attempts,
    nextAttemptAt: step.nextAttemptAt,
    fromVersion: step.fromVersion,
    toVersion: step.toVersion,
    fromCommit: step.fromCommit,
    toCommit: step.toCommit,
    statusChangedAt: step.lastStageAt,
    errorCode: step.errorCode,
    errorMessage: step.errorMessage,
    detail: stepDetail(step.detail),
    // A step planned already settled (on target, skipped) finishes when it is written.
    finishedAt: isTerminalStepStatus(step.status) ? step.lastStageAt : null,
  }
}

export function createMemoryUpgradeStore(input?: {
  facts?: FleetServerFact[]
  settings?: UpgradeSettings
  latest?: UpgradeTarget | null
  pause?: UpgradePause | null
  checkMinute?: number
}): UpgradeStore & {
  facts: FleetServerFact[]
  setPause(pause: UpgradePause | null): void
} {
  const facts = input?.facts ?? []
  let settings = input?.settings ?? { batch: { mode: 'percent' as const, value: 100 } }
  let latest = input?.latest ?? null
  let pause = input?.pause ?? null
  let schedule: UpgradeCheckSchedule | null = null
  let reservedRunId: string | null = null
  let tickCursor: { runId: string; cursor: UpgradeTickCursor } | null = null
  const runs = new Map<string, UpgradeRunRow>()
  const steps = new Map<string, UpgradeStepRow>()

  return {
    facts,
    setPause: (next) => {
      pause = next ? structuredClone(next) : null
    },
    settings: () => Promise.resolve(structuredClone(settings)),
    saveSettings: (next) => {
      settings = structuredClone(next)
      return Promise.resolve()
    },
    pause: () => Promise.resolve(pause ? structuredClone(pause) : null),
    checkSchedule: (now) => {
      schedule ??= { minute: input?.checkMinute ?? 0, createdAt: now, lastCheckAt: null }
      return Promise.resolve(structuredClone(schedule))
    },
    markChecked: (current, at) => {
      schedule = { ...current, lastCheckAt: at }
      return Promise.resolve()
    },
    skipUndispatchedSteps: (upgradeId, skip) => {
      let settled = 0
      for (const step of steps.values()) {
        if (step.upgradeId !== upgradeId || !isUndispatchedStep(step)) continue
        step.status = 'skipped'
        step.errorCode = skip.errorCode
        step.errorMessage = skip.errorMessage
        step.lastStageAt = skip.at
        settled++
      }
      return Promise.resolve(settled)
    },
    failureHistory: (targets) =>
      Promise.resolve(memoryFailureHistory([...steps.values()], targets)),
    latestBuild: () => Promise.resolve(latest ? structuredClone(latest) : null),
    saveLatestBuild: (target) => {
      latest = structuredClone(target)
      return Promise.resolve()
    },
    activeRun: () => {
      for (const run of runs.values()) {
        if (run.status === 'pending' || run.status === 'running') {
          return Promise.resolve(structuredClone(run))
        }
      }
      return Promise.resolve(null)
    },
    runById: (id) => Promise.resolve(structuredClone(runs.get(id) ?? null)),
    insertRun: (run, runSteps) => {
      for (const existing of runs.values()) {
        if (existing.status === 'pending' || existing.status === 'running') {
          return Promise.resolve('active')
        }
      }
      runs.set(run.id, structuredClone(run))
      for (const step of runSteps) steps.set(step.id, structuredClone(step))
      return Promise.resolve('created')
    },
    saveRun: (run) => {
      runs.set(run.id, structuredClone(run))
      return Promise.resolve()
    },
    stepsFor: (upgradeId) =>
      Promise.resolve(
        [...steps.values()]
          .filter((step) => step.upgradeId === upgradeId)
          .sort(compareUpgradeStepRows)
          .map((step) => structuredClone(step))
      ),
    tickWindow: (upgradeId, cursor, limit) =>
      Promise.resolve(memoryTickWindow(steps, facts, upgradeId, cursor, limit)),
    countSteps: (upgradeId) =>
      Promise.resolve(
        summarizeSteps([...steps.values()].filter((step) => step.upgradeId === upgradeId))
      ),
    readTickCursor: (runId) =>
      Promise.resolve(tickCursor?.runId === runId ? structuredClone(tickCursor.cursor) : null),
    writeTickCursor: (runId, cursor) => {
      tickCursor = cursor ? { runId, cursor: structuredClone(cursor) } : null
      return Promise.resolve()
    },
    anyDaemonBehind: (commit, builtAt) => {
      if (!commit) return Promise.resolve(false)
      return Promise.resolve(
        facts.some(
          (fact) => fact.connected && fact.commit !== commit && !builtAfter(fact.builtAt, builtAt)
        )
      )
    },
    factsFor: (ids, colocatedServerId) => {
      const wanted = new Set(ids.slice(0, UPGRADE_TICK_STEP_BUDGET + 1))
      return Promise.resolve(
        facts
          .filter((fact) => wanted.has(fact.serverId))
          .map((fact) => markColocated(fact, colocatedServerId))
      )
    },
    saveStep: (step, expectedStatus) => {
      if (expectedStatus !== undefined && steps.get(step.id)?.status !== expectedStatus) {
        return Promise.resolve(false)
      }
      steps.set(step.id, structuredClone(step))
      return Promise.resolve(true)
    },
    history: (offset, limit) => {
      const terminal = [...runs.values()]
        .filter((run) => (UPGRADE_TERMINAL_STATUSES as readonly string[]).includes(run.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return Promise.resolve({
        total: terminal.length,
        runs: terminal.slice(offset, offset + limit).map((run) => structuredClone(run)),
      })
    },
    fleetFacts: (colocatedServerId) =>
      Promise.resolve(facts.map((fact) => markColocated(fact, colocatedServerId))),
    pageFleet: (query, colocatedServerId) => {
      const rows = facts.filter((fact) => memoryFleetStatus(fact, query.status, query.targetCommit))
      const limit = clampPageLimit(query.limit)
      // `|| 0` first: NaN must land on 0, as `offset > 0 ? offset : 0` had it (Math.max(NaN, 0) is NaN).
      const offset = Math.max(query.offset || 0, 0)
      return Promise.resolve({
        total: rows.length,
        facts: rows
          .slice(offset, offset + limit)
          .map((fact) => markColocated(fact, colocatedServerId)),
      })
    },
    probeCandidates: () => Promise.resolve(new Map()),
    reservedRunId: () => Promise.resolve(reservedRunId),
    reserveRunId: (id) => {
      reservedRunId = id
      return Promise.resolve()
    },
    clearReservedRunId: () => {
      reservedRunId = null
      return Promise.resolve()
    },
  }
}

export function createDrizzleUpgradeStore(
  db: Db,
  registry: DaemonCellRegistry | null,
  defaultBatch?: UpgradeSettings['batch']
): UpgradeStore {
  return {
    settings: () => getUpgradeSettings(db, defaultBatch),
    saveSettings: (settings) => setUpgradeSettings(db, settings),
    pause: () => getUpgradePause(db),
    checkSchedule: (now) => ensureUpgradeCheckSchedule(db, now),
    markChecked: (schedule, at) => markUpgradeChecked(db, schedule, at),
    skipUndispatchedSteps: (upgradeId, skip) => skipUndispatchedStepRows(db, upgradeId, skip),
    failureHistory: (targets) => loadFailureHistory(db, targets),
    latestBuild: () => getLatestAvailableBuild(db),
    saveLatestBuild: (target) => setLatestAvailableBuild(db, target),
    activeRun: async () => {
      const rows = await db
        .select()
        .from(upgrade)
        .where(inArray(upgrade.status, [...UPGRADE_ACTIVE_STATUSES]))
        .limit(1)
      const row = rows[0]
      return row ? toRun(row) : null
    },
    runById: async (id) => {
      const rows = await db
        .select(UPGRADE_RUN_COLUMNS)
        .from(upgrade)
        .leftJoin(user, eq(user.id, upgrade.startedBy))
        .where(eq(upgrade.id, id))
        .limit(1)
      const row = rows[0]
      return row ? toRun(row) : null
    },
    insertRun: async (run, runSteps) => {
      try {
        await db.transaction(async (tx) => {
          const active = await tx
            .select({ id: upgrade.id })
            .from(upgrade)
            .where(inArray(upgrade.status, [...UPGRADE_ACTIVE_STATUSES]))
            .limit(1)
          if (active.length > 0) throw new UpgradeActiveConflict()
          await tx.insert(upgrade).values({
            id: run.id,
            source: run.source,
            channel: run.channel,
            status: run.status,
            phase: run.phase,
            startedBy: run.startedBy,
            target: run.target,
            batchPolicy: run.batchPolicy,
            counts: run.counts,
            error: run.error,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          })
          if (runSteps.length > 0) {
            await tx.insert(stage).values(runSteps.map(stepInsert))
          }
        })
        return 'created'
      } catch (err) {
        if (err instanceof UpgradeActiveConflict) return 'active'
        if (isPostgresUniqueViolation(err)) return 'active'
        throw err
      }
    },
    saveRun: async (run) => {
      await db
        .update(upgrade)
        .set({
          status: run.status,
          phase: run.phase,
          target: run.target,
          counts: run.counts,
          error: run.error,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        })
        .where(eq(upgrade.id, run.id))
    },
    stepsFor: async (upgradeId) => {
      const rows = await db
        .select()
        .from(stage)
        .where(eq(stage.upgradeId, upgradeId))
        .orderBy(
          sql`case ${stage.phase} when 'colocated_daemon' then 0 when 'control_plane' then 1 else 2 end`,
          asc(stage.batchIndex),
          asc(stage.id)
        )
      return rows.map(toStep)
    },
    tickWindow: (upgradeId, cursor, limit) => loadTickWindow(db, upgradeId, cursor, limit),
    countSteps: (upgradeId) => countUpgradeSteps(db, upgradeId),
    readTickCursor: (runId) => readTickCursor(db, runId),
    writeTickCursor: (runId, cursor) => writeTickCursor(db, runId, cursor),
    anyDaemonBehind: (commit, builtAt) => anyDaemonBehind(db, commit, builtAt),
    factsFor: (ids, colocatedServerId) => loadFactsFor(db, ids, colocatedServerId),
    saveStep: async (step, expectedStatus) => {
      const rows = await db
        .update(stage)
        .set({
          status: step.status,
          requestId: step.requestId,
          attempts: step.attempts,
          nextAttemptAt: step.nextAttemptAt,
          statusChangedAt: step.lastStageAt,
          errorCode: step.errorCode,
          errorMessage: step.errorMessage,
          detail: stepDetail(step.detail),
          ...stepTimesUpdate(step),
        })
        .where(
          expectedStatus !== undefined
            ? and(eq(stage.id, step.id), eq(stage.status, expectedStatus))
            : eq(stage.id, step.id)
        )
        .returning({ id: stage.id })
      return rows.length > 0
    },
    history: async (offset, limit) => {
      const where = inArray(upgrade.status, [...UPGRADE_TERMINAL_STATUSES])
      const [rows, counted] = await Promise.all([
        db
          .select(UPGRADE_RUN_COLUMNS)
          .from(upgrade)
          .leftJoin(user, eq(user.id, upgrade.startedBy))
          .where(where)
          .orderBy(desc(upgrade.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(upgrade)
          .where(where),
      ])
      return {
        runs: rows.map(toRun),
        total: counted[0]?.total ?? 0,
      }
    },
    fleetFacts: (colocatedServerId) => loadFleetFacts(db, colocatedServerId),
    pageFleet: (query, colocatedServerId) => pageFleetFacts(db, query, colocatedServerId),
    probeCandidates: (ids) => probeFleetCandidates(db, registry, ids),
    reservedRunId: () => readReservedRunId(db),
    reserveRunId: (id) => writeReservedRunId(db, id),
    clearReservedRunId: () => clearReservedRunId(db),
  }
}

/** Statuses a never-sent step can be in (a pause settles these). */
const UNDISPATCHED_STATUSES: readonly UpgradeStepStatus[] = ['pending', 'waiting']

/** A step that was never sent to its host: a pause may settle it. */
export function isUndispatchedStep(step: { status: UpgradeStepStatus; attempts: number }): boolean {
  return step.attempts === 0 && UNDISPATCHED_STATUSES.includes(step.status)
}

/** One statement; the status and attempts guard makes it safe beside a concurrent report. */
async function skipUndispatchedStepRows(
  db: Db,
  upgradeId: string,
  skip: UpgradePausedSkip
): Promise<number> {
  const rows = await db
    .update(stage)
    .set({
      status: 'skipped',
      errorCode: skip.errorCode,
      errorMessage: skip.errorMessage,
      statusChangedAt: skip.at,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(stage.upgradeId, upgradeId),
        eq(stage.attempts, 0),
        inArray(stage.status, [...UNDISPATCHED_STATUSES])
      )
    )
    .returning({ id: stage.id })
  return rows.length
}

const FAILURE_STATUSES: readonly UpgradeStepStatus[] = ['failed', 'rolled_back', 'needs_attention']

function failureUnitTargets(targets: UpgradeFailureTargets): { unit: string; commit: string }[] {
  const out: { unit: string; commit: string }[] = []
  if (targets.daemonCommit) out.push({ unit: 'daemon', commit: targets.daemonCommit })
  if (targets.instanceCommit) out.push({ unit: 'instance', commit: targets.instanceCommit })
  return out
}

function memoryFailureHistory(
  rows: readonly UpgradeStepRow[],
  targets: UpgradeFailureTargets
): Map<string, UpgradeFailureHistory> {
  const wanted = failureUnitTargets(targets)
  const out = new Map<string, UpgradeFailureHistory>()
  for (const step of rows) {
    if (!FAILURE_STATUSES.includes(step.status)) continue
    if (!wanted.some((want) => want.unit === step.unit && want.commit === step.toCommit)) continue
    const key = upgradeFailureKey(step.serverId, step.unit)
    const prior = out.get(key)
    const at = step.lastStageAt
    const later = !prior?.lastFailedAt || (at !== null && at > prior.lastFailedAt)
    out.set(key, {
      failures: (prior?.failures ?? 0) + 1,
      lastFailedAt: later ? at : prior.lastFailedAt,
    })
  }
  return out
}

/**
 * One grouped read over failed steps at the target commits. It runs only when
 * an automatic run is being planned (at most once an hour), and its result
 * holds only servers that failed.
 */
async function loadFailureHistory(
  db: Db,
  targets: UpgradeFailureTargets
): Promise<Map<string, UpgradeFailureHistory>> {
  const wanted = failureUnitTargets(targets)
  const out = new Map<string, UpgradeFailureHistory>()
  if (wanted.length === 0) return out
  const rows = await db
    .select({
      serverId: stage.serverId,
      unit: stage.unit,
      failures: sql<number>`count(*)::int`,
      // ISO text from the database, so no driver date format is parsed here.
      lastFailedAt: sql<
        string | null
      >`to_char(max(coalesce(${stage.finishedAt}, ${stage.statusChangedAt}, ${stage.createdAt})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(stage)
    .where(
      and(
        inArray(stage.status, [...FAILURE_STATUSES]),
        sql`(${sql.join(
          wanted.map(
            (want) => sql`(${stage.unit} = ${want.unit} and ${stage.toCommit} = ${want.commit})`
          ),
          sql` or `
        )})`
      )
    )
    .groupBy(stage.serverId, stage.unit)
  for (const row of rows) {
    out.set(upgradeFailureKey(row.serverId, row.unit), {
      failures: Number(row.failures),
      lastFailedAt: row.lastFailedAt,
    })
  }
  return out
}

/**
 * `started_at` is the first dispatch (kept across retries); `finished_at` is
 * the first save in a terminal status, cleared when a retry reopens the step.
 * Database time, so every step of every run reads on one clock.
 */
function stepTimesUpdate(step: UpgradeStepRow) {
  return {
    ...(step.attempts > 0 ? { startedAt: sql`coalesce(${stage.startedAt}, now())` } : {}),
    finishedAt: isTerminalStepStatus(step.status)
      ? sql`coalesce(${stage.finishedAt}, now())`
      : null,
  }
}

function clampPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return 50
  return Math.min(limit, 100)
}

function markColocated(fact: FleetServerFact, colocatedServerId: string | null): FleetServerFact {
  return {
    ...fact,
    colocated: fact.serverId === colocatedServerId || fact.colocated,
  }
}

/** Coarse page filter. Live step status is applied by the coordinator on the page. */
function memoryFleetStatus(
  fact: FleetServerFact,
  status: string,
  targetCommit: string | null
): boolean {
  if (!status) return true
  const onTarget = Boolean(targetCommit) && fact.commit === targetCommit
  if (status === 'done') return onTarget
  if (status === 'active') return !onTarget
  if (status === 'needs_attention') return false
  return true
}

function factFromServerRow(
  row: {
    id: string
    name: string | null
    hostname: string | null
    isConnected: boolean
    daemon: unknown
  },
  colocatedServerId: string | null
): FleetServerFact {
  const parsed = parseServerDaemonState(row.daemon)
  return {
    serverId: row.id,
    name: row.name ?? null,
    hostname: row.hostname ?? null,
    connected: row.isConnected === true,
    commit: parsed?.projection?.daemonBuild?.commit ?? null,
    version: parsed?.projection?.daemonBuild?.version ?? null,
    builtAt: parsed?.projection?.daemonBuild?.builtAt ?? null,
    features: parsed?.projection?.features ?? [],
    colocated: row.id === colocatedServerId,
  }
}

const FLEET_ROW = {
  id: server.id,
  name: server.name,
  hostname: server.hostname,
  isConnected: server.isConnected,
  daemon: server.daemon,
}

function fleetStatusWhere(status: string, targetCommit: string | null) {
  const commit = sql`${server.daemonCommit}`
  if (!status) return sql`true`
  if (status === 'done') {
    if (!targetCommit) return sql`false`
    return sql`${commit} = ${targetCommit}`
  }
  if (status === 'needs_attention') {
    return sql`exists (
      select 1 from stage step
      inner join upgrade run on run.id = step.upgrade_id
      where step.server_id = ${server.id}
        and run.status in ('pending', 'running')
        and step.status in ('needs_attention', 'failed')
    )`
  }
  if (status === 'active') {
    const active = sql.join(
      UPGRADE_STEP_ACTIVE_STATUSES.map((item) => sql`${item}`),
      sql`, `
    )
    const behind = targetCommit ? sql`${commit} is distinct from ${targetCommit}` : sql`true`
    return sql`(
      exists (
        select 1 from stage step
        inner join upgrade run on run.id = step.upgrade_id
        where step.server_id = ${server.id}
          and run.status in ('pending', 'running')
          and step.status in (${active})
      )
      or (${behind})
    )`
  }
  return sql`exists (
    select 1 from stage step
    inner join upgrade run on run.id = step.upgrade_id
    where step.server_id = ${server.id}
      and run.status in ('pending', 'running')
      and step.status = ${status}
  )`
}

async function loadFleetFacts(
  db: Db,
  colocatedServerId: string | null
): Promise<FleetServerFact[]> {
  const rows = await db.select(FLEET_ROW).from(server)
  return rows.map((row) => factFromServerRow(row, colocatedServerId))
}

async function pageFleetFacts(
  db: Db,
  query: FleetPageQuery,
  colocatedServerId: string | null
): Promise<{ total: number; facts: FleetServerFact[] }> {
  const where = fleetStatusWhere(query.status, query.targetCommit)
  const limit = clampPageLimit(query.limit)
  // `|| 0` first: NaN must land on 0, as `offset > 0 ? offset : 0` had it (Math.max(NaN, 0) is NaN).
  const offset = Math.max(query.offset || 0, 0)
  const [rows, counted] = await Promise.all([
    db
      .select(FLEET_ROW)
      .from(server)
      .where(where)
      .orderBy(asc(server.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(server)
      .where(where),
  ])
  return {
    total: counted[0]?.total ?? 0,
    facts: rows.map((row) => factFromServerRow(row, colocatedServerId)),
  }
}

async function probeFleetCandidates(
  _db: Db,
  registry: DaemonCellRegistry | null,
  ids: readonly string[]
): Promise<Map<string, FleetProbe>> {
  const bounded = ids.slice(0, FLEET_CELL_PROBE_BUDGET)
  if (!registry || bounded.length === 0) return new Map()
  const snapshots = await registry.getSnapshots([...bounded])
  const probes = new Map<string, FleetProbe>()
  for (const [id, snap] of snapshots) {
    probes.set(id, {
      connected: snap.connected === true,
      commit: snap.daemonBuild?.commit ?? null,
      version: snap.daemonBuild?.version ?? null,
    })
  }
  return probes
}

async function readReservedRunId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, RESERVED_UPGRADE_RUN_KEY))
    .limit(1)
  const value = rows[0]?.value
  if (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id?: unknown }).id === 'string' &&
    isUpgradeRunId((value as { id: string }).id)
  ) {
    return (value as { id: string }).id
  }
  return null
}

async function writeReservedRunId(db: Db, id: string): Promise<void> {
  if (!isUpgradeRunId(id)) return
  await db
    .insert(setting)
    .values({ key: RESERVED_UPGRADE_RUN_KEY, value: { id } })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value: { id }, updatedAt: new Date().toISOString() },
    })
}

async function clearReservedRunId(db: Db): Promise<void> {
  await db.delete(setting).where(eq(setting.key, RESERVED_UPGRADE_RUN_KEY))
}

function clampTickLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return UPGRADE_TICK_STEP_BUDGET
  return Math.min(limit, UPGRADE_TICK_STEP_BUDGET)
}

function emptySummary(): StepSummary {
  return {
    total: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    needsAttention: 0,
    inProgress: 0,
  }
}

function summaryFromStatusCounts(rows: readonly { status: string; total: number }[]): StepSummary {
  const summary = emptySummary()
  for (const row of rows) {
    summary.total += row.total
    if (row.status === 'done') summary.done += row.total
    else if (row.status === 'skipped') summary.skipped += row.total
    else if (row.status === 'failed') summary.failed += row.total
    else if (row.status === 'needs_attention') {
      summary.needsAttention += row.total
    } else summary.inProgress += row.total
  }
  return summary
}

function asPlatformPhase(value: string | undefined): PlatformPhase | null {
  if (value === 'colocated_daemon' || value === 'control_plane') return value
  return null
}

function asTickPhase(value: string): UpgradePhase {
  if (value === 'colocated_daemon' || value === 'control_plane') return value
  return 'fleet'
}

function memoryTickWindow(
  steps: Map<string, UpgradeStepRow>,
  facts: readonly FleetServerFact[],
  upgradeId: string,
  cursor: UpgradeTickCursor | null,
  limit: number
): UpgradeTickWindow {
  const cap = clampTickLimit(limit)
  const rows = [...steps.values()].filter((step) => step.upgradeId === upgradeId)
  const counts = summarizeSteps(rows)
  const failedPhase = failedPlatformPhase(rows)
  const open = rows
    .filter((step) => !isTerminalStepStatus(step.status))
    .sort(compareUpgradeStepRows)
  const first = open[0]
  if (!first) {
    return {
      steps: [],
      counts,
      phase: null,
      batchIndex: null,
      failedPlatformPhase: failedPhase,
      allTerminal: true,
    }
  }
  const phase = first.phase
  const batchIndex =
    activeBatchIndex(
      open
        .filter((step) => step.phase === phase)
        .map((step) => ({
          batchIndex: step.batchIndex,
          status: step.status,
          connected:
            step.phase === 'fleet'
              ? facts.some((fact) => fact.serverId === step.serverId && fact.connected)
              : true,
        }))
    ) ?? lowestOpenBatch(open, phase, first.batchIndex)
  const afterId = cursorAfterId(cursor, phase, batchIndex)
  return {
    steps: memoryTickPage(open, phase, batchIndex, afterId, cap),
    counts,
    phase,
    batchIndex,
    failedPlatformPhase: failedPhase,
    allTerminal: false,
  }
}

/** The lowest batch still open in `phase`, starting from the head step's. */
function lowestOpenBatch(
  open: readonly UpgradeStepRow[],
  phase: UpgradePhase,
  headBatchIndex: number
): number {
  let batchIndex = headBatchIndex
  for (const step of open) {
    if (step.phase !== phase) continue
    if (step.batchIndex < batchIndex) batchIndex = step.batchIndex
  }
  return batchIndex
}

/**
 * Where the last tick stopped: the cursor's `afterId`, but only while it
 * still names this phase and batch. Any other cursor is stale and ignored.
 */
function cursorAfterId(
  cursor: UpgradeTickCursor | null,
  phase: UpgradePhase,
  batchIndex: number
): string | null {
  return cursor?.phase === phase && cursor.batchIndex === batchIndex ? cursor.afterId : null
}

/** Up to `cap` open steps of one phase and batch, in order, after `afterId`. */
function memoryTickPage(
  open: readonly UpgradeStepRow[],
  phase: UpgradePhase,
  batchIndex: number,
  afterId: string | null,
  cap: number
): UpgradeStepRow[] {
  const page: UpgradeStepRow[] = []
  for (const step of open) {
    if (page.length >= cap) break
    if (step.phase !== phase || step.batchIndex !== batchIndex) continue
    if (afterId && step.id.localeCompare(afterId) <= 0) continue
    page.push(structuredClone(step))
  }
  return page
}

async function countUpgradeSteps(db: Db, upgradeId: string): Promise<StepSummary> {
  const rows = await db
    .select({
      status: stage.status,
      total: sql<number>`count(*)::int`,
    })
    .from(stage)
    .where(eq(stage.upgradeId, upgradeId))
    .groupBy(stage.status)
  return summaryFromStatusCounts(rows)
}

async function loadTickWindow(
  db: Db,
  upgradeId: string,
  cursor: UpgradeTickCursor | null,
  limit: number
): Promise<UpgradeTickWindow> {
  const cap = clampTickLimit(limit)
  const [counts, failedPlatform, head] = await Promise.all([
    countUpgradeSteps(db, upgradeId),
    db
      .select({
        phase: sql<string>`${stage.phase}`,
      })
      .from(stage)
      .where(
        and(
          eq(stage.upgradeId, upgradeId),
          inArray(sql`${stage.phase}`, [...PLATFORM_PHASES]),
          inArray(stage.status, ['failed', 'needs_attention'])
        )
      )
      .orderBy(sql`case ${stage.phase} when 'colocated_daemon' then 0 else 1 end`)
      .limit(1),
    db
      .select({
        phase: sql<string>`${stage.phase}`,
        batchIndex: stage.batchIndex,
      })
      .from(stage)
      .leftJoin(server, eq(server.id, stage.serverId))
      .where(and(eq(stage.upgradeId, upgradeId), notInArray(stage.status, [...TERMINAL_STEP_SQL])))
      .orderBy(
        sql`case ${stage.phase} when 'colocated_daemon' then 0 when 'control_plane' then 1 else 2 end`,
        sql`case
          when ${stage.phase} <> 'fleet' then 0
          when exists (
            select 1 from stage pinned
            where pinned.upgrade_id = ${stage.upgradeId}
              and pinned.phase = ${stage.phase}
              and pinned.status in ${BATCH_PIN_STEP_SQL}
          ) then case when ${stage.status} in ${BATCH_PIN_STEP_SQL} then 0 else 1 end
          else case when coalesce(${server.isConnected}, false) then 0 else 1 end
        end`,
        asc(stage.batchIndex),
        asc(stage.id)
      )
      .limit(1),
  ])
  const failedPhase = asPlatformPhase(failedPlatform[0]?.phase)
  const opened = head[0]
  if (!opened) {
    return {
      steps: [],
      counts,
      phase: null,
      batchIndex: null,
      failedPlatformPhase: failedPhase,
      allTerminal: true,
    }
  }
  const phase = asTickPhase(opened.phase)
  const batchIndex = opened.batchIndex
  const afterId = cursorAfterId(cursor, phase, batchIndex)
  const filters = [
    eq(stage.upgradeId, upgradeId),
    sql`${stage.phase} = ${phase}`,
    eq(stage.batchIndex, batchIndex),
    notInArray(stage.status, [...TERMINAL_STEP_SQL]),
  ]
  if (afterId) filters.push(sql`${stage.id}::text > ${afterId}`)
  const rows = await db
    .select()
    .from(stage)
    .where(and(...filters))
    .orderBy(asc(stage.id))
    .limit(cap)
  return {
    steps: rows.map(toStep),
    counts,
    phase,
    batchIndex,
    failedPlatformPhase: failedPhase,
    allTerminal: false,
  }
}

function parseTickCursor(value: unknown, runId: string): UpgradeTickCursor | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as {
    runId?: unknown
    phase?: unknown
    batchIndex?: unknown
    afterId?: unknown
  }
  if (row.runId !== runId) return null
  if (row.phase !== 'colocated_daemon' && row.phase !== 'control_plane' && row.phase !== 'fleet') {
    return null
  }
  if (typeof row.batchIndex !== 'number' || !Number.isInteger(row.batchIndex)) {
    return null
  }
  const afterId = typeof row.afterId === 'string' && row.afterId.length > 0 ? row.afterId : null
  return { phase: row.phase, batchIndex: row.batchIndex, afterId }
}

async function readTickCursor(db: Db, runId: string): Promise<UpgradeTickCursor | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, UPGRADE_TICK_CURSOR_KEY))
    .limit(1)
  return parseTickCursor(rows[0]?.value, runId)
}

async function writeTickCursor(
  db: Db,
  runId: string,
  cursor: UpgradeTickCursor | null
): Promise<void> {
  if (!cursor) {
    await db.delete(setting).where(eq(setting.key, UPGRADE_TICK_CURSOR_KEY))
    return
  }
  const value = {
    runId,
    phase: cursor.phase,
    batchIndex: cursor.batchIndex,
    afterId: cursor.afterId,
  }
  await db
    .insert(setting)
    .values({ key: UPGRADE_TICK_CURSOR_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
}

/**
 * A connected daemon off `commit`. An offline host is left out: auto-start
 * would otherwise open a run for it on every tick, each one waiting out the
 * offline deadline. It is picked up by the first run after it reconnects.
 */
async function anyDaemonBehind(
  db: Db,
  commit: string | null,
  builtAt?: string | null
): Promise<boolean> {
  if (!commit) return false
  const target = normalizedBuiltAt(builtAt)
  // A host whose build time is known and later than the target's is ahead,
  // not behind; an unknown build time counts as behind.
  const notAhead =
    target === null
      ? undefined
      : sql`not coalesce(${server.daemonBuiltAt} > ${new Date(target).toISOString()}::timestamptz, false)`
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(
      and(
        eq(server.isConnected, true),
        sql`${server.daemonCommit} is distinct from ${commit}`,
        notAhead
      )
    )
    .limit(1)
  return rows.length > 0
}

/** An ISO build time as epoch ms, or null when absent or unparsable. */
function normalizedBuiltAt(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? '')
  return Number.isFinite(ms) ? ms : null
}

/** True when the installed build is known to be newer than the target build. */
export function builtAfter(
  installed: string | null | undefined,
  target: string | number | null | undefined
): boolean {
  const have = normalizedBuiltAt(installed)
  const want = typeof target === 'number' ? target : normalizedBuiltAt(target)
  return have !== null && want !== null && have > want
}

async function loadFactsFor(
  db: Db,
  ids: readonly string[],
  colocatedServerId: string | null
): Promise<FleetServerFact[]> {
  const unique: string[] = []
  for (const id of ids) {
    if (unique.length >= UPGRADE_TICK_STEP_BUDGET + 1) break
    if (id.length === 0 || unique.includes(id)) continue
    unique.push(id)
  }
  if (unique.length === 0) return []
  const rows = await db.select(FLEET_ROW).from(server).where(inArray(server.id, unique))
  return rows.map((row) => factFromServerRow(row, colocatedServerId))
}
