/**
 * Host-free rules for the paged update history: how a step and a server read
 * in a finished or running run, the trigger a run's `source` stands for, and
 * the query parameters the history routes accept. `history-read.ts` runs the
 * SQL; the server outcome `CASE` there is built from the lists below so the
 * two cannot drift.
 */
import {
  UPGRADE_ACTIVE_STATUSES,
  UPGRADE_STATUSES,
  UPGRADE_STEP_FAILURE_STATUSES,
  UPGRADE_TERMINAL_STATUSES,
  type UpgradeSource,
  type UpgradeStatus,
  type UpgradeStepStatus,
} from './vocabulary.ts'
import type { StepSummary } from './run.ts'

/**
 * What one server's part in a run came to. Listed worst first: a server with
 * several steps (the control-plane host has a daemon and an instance step)
 * takes the first outcome any of its steps has, and the status sort uses the
 * same order (failed first).
 *
 * `already_current` is a step the run planned but never had to send: the
 * host was already on the target (`done` with zero dispatches). It is not an
 * update and is never counted as one.
 */
export const UPGRADE_SERVER_OUTCOMES = [
  'failed',
  'in_progress',
  'skipped',
  'updated',
  'already_current',
] as const

export type UpgradeServerOutcome = (typeof UPGRADE_SERVER_OUTCOMES)[number]

/** Step statuses that read as a failed server. */
export const UPGRADE_OUTCOME_FAILED_STATUSES: readonly UpgradeStepStatus[] =
  UPGRADE_STEP_FAILURE_STATUSES

/** One step's outcome. Mirrors `serverOutcomeRankSql` in `history-read.ts`. */
export function stepOutcome(step: {
  status: UpgradeStepStatus
  attempts: number
}): UpgradeServerOutcome {
  if (UPGRADE_OUTCOME_FAILED_STATUSES.includes(step.status)) return 'failed'
  if (step.status === 'skipped') return 'skipped'
  if (step.status !== 'done') return 'in_progress'
  return step.attempts > 0 ? 'updated' : 'already_current'
}

/** Position of an outcome in {@link UPGRADE_SERVER_OUTCOMES} (0 is worst). */
export function outcomeRank(outcome: UpgradeServerOutcome): number {
  return UPGRADE_SERVER_OUTCOMES.indexOf(outcome)
}

/** The outcome stored as a rank (`min` over a server's steps in SQL). */
export function outcomeFromRank(rank: number): UpgradeServerOutcome {
  return UPGRADE_SERVER_OUTCOMES[rank] ?? 'in_progress'
}

/** A server's outcome: the worst of its steps. No steps reads as in progress. */
export function serverOutcome(
  steps: readonly { status: UpgradeStepStatus; attempts: number }[]
): UpgradeServerOutcome {
  if (steps.length === 0) return 'in_progress'
  let worst = UPGRADE_SERVER_OUTCOMES.length - 1
  for (const step of steps) worst = Math.min(worst, outcomeRank(stepOutcome(step)))
  return outcomeFromRank(worst)
}

export type UpgradeRunTrigger = 'automatic' | 'manual'

/** `auto` is the maintenance tick; `manual` and `server` (one server) are a person. */
export function runTrigger(source: UpgradeSource): UpgradeRunTrigger {
  return source === 'auto' ? 'automatic' : 'manual'
}

/**
 * Servers in one run by outcome. `detail: 'steps'` is counted from the step
 * rows. `detail: 'pruned'` means retention already removed them: the totals
 * then come from the step counts the run kept (`upgrade.counts`), and
 * `updated` / `alreadyCurrent` are null because those counts cannot tell an
 * install from a host that was already current.
 */
export type UpgradeRunServerSummary = {
  detail: 'steps' | 'pruned'
  total: number
  updated: number | null
  alreadyCurrent: number | null
  skipped: number
  failed: number
  inProgress: number
}

export type OutcomeCounts = Record<UpgradeServerOutcome, number>

export function emptyOutcomeCounts(): OutcomeCounts {
  return { failed: 0, in_progress: 0, skipped: 0, updated: 0, already_current: 0 }
}

export function summaryFromOutcomes(counts: OutcomeCounts): UpgradeRunServerSummary {
  return {
    detail: 'steps',
    total:
      counts.failed + counts.in_progress + counts.skipped + counts.updated + counts.already_current,
    updated: counts.updated,
    alreadyCurrent: counts.already_current,
    skipped: counts.skipped,
    failed: counts.failed,
    inProgress: counts.in_progress,
  }
}

/** Summary for a run with no step rows left (pruned) or none ever written. */
export function summaryFromStoredCounts(counts: StepSummary | null): UpgradeRunServerSummary {
  return {
    detail: 'pruned',
    total: counts?.total ?? 0,
    updated: null,
    alreadyCurrent: null,
    skipped: counts?.skipped ?? 0,
    failed: (counts?.failed ?? 0) + (counts?.needsAttention ?? 0),
    inProgress: counts?.inProgress ?? 0,
  }
}

export const HISTORY_PAGE_DEFAULT = 50
export const HISTORY_PAGE_MAX = 100
/** Longest free-text search the server list accepts. */
export const HISTORY_SEARCH_MAX = 200

export type HistoryPage = { offset: number; limit: number }

export function parsePage(
  offsetRaw: string | undefined,
  limitRaw: string | undefined
): HistoryPage {
  const offset = Number.parseInt(offsetRaw ?? '0', 10)
  const limit = Number.parseInt(limitRaw ?? String(HISTORY_PAGE_DEFAULT), 10)
  return {
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    limit:
      Number.isInteger(limit) && limit > 0
        ? Math.min(limit, HISTORY_PAGE_MAX)
        : HISTORY_PAGE_DEFAULT,
  }
}

export type HistoryQuery = HistoryPage & {
  statuses: readonly UpgradeStatus[]
  sources: readonly UpgradeSource[] | null
}

export type InvalidFilter = { error: 'invalid_filter'; field: string }

type Params = Record<string, string | undefined>

/** The trimmed parameter, or null when it is absent or blank. */
function given(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Run statuses for `?status=`. Omitted keeps the old answer (finished runs
 * only); `any` is every run, `active` the pending or running one.
 */
function parseRunStatuses(raw: string | undefined): readonly UpgradeStatus[] | null {
  const value = given(raw)
  if (value === null) return UPGRADE_TERMINAL_STATUSES
  if (value === 'any') return UPGRADE_STATUSES
  if (value === 'active') return UPGRADE_ACTIVE_STATUSES
  return (UPGRADE_STATUSES as readonly string[]).includes(value) ? [value as UpgradeStatus] : null
}

function parseTrigger(raw: string | undefined): readonly UpgradeSource[] | null | 'invalid' {
  const value = given(raw)
  if (value === null) return null
  if (value === 'automatic') return ['auto']
  if (value === 'manual') return ['manual', 'server']
  return 'invalid'
}

export function parseHistoryQuery(params: Params): HistoryQuery | InvalidFilter {
  const statuses = parseRunStatuses(params.status)
  if (!statuses) return { error: 'invalid_filter', field: 'status' }
  const sources = parseTrigger(params.trigger)
  if (sources === 'invalid') return { error: 'invalid_filter', field: 'trigger' }
  return { ...parsePage(params.offset, params.limit), statuses, sources }
}

export const RUN_SERVER_SORTS = [
  'status',
  'organization',
  'server',
  'started',
  'finished',
  'duration',
  'attempts',
] as const

export type RunServerSort = (typeof RUN_SERVER_SORTS)[number]

export type RunServersQuery = HistoryPage & {
  sort: RunServerSort
  dir: 'asc' | 'desc'
  outcome: UpgradeServerOutcome | null
  organizationId: string | null
  serverId: string | null
  search: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T
): T | null {
  const value = given(raw)
  if (value === null) return fallback
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function optionalOutcome(raw: string | undefined): UpgradeServerOutcome | null | 'invalid' {
  const value = given(raw)
  if (value === null) return null
  return (UPGRADE_SERVER_OUTCOMES as readonly string[]).includes(value)
    ? (value as UpgradeServerOutcome)
    : 'invalid'
}

function optionalUuid(raw: string | undefined): string | null | 'invalid' {
  const value = given(raw)
  if (value === null) return null
  return isUuid(value) ? value.toLowerCase() : 'invalid'
}

function optionalSearch(raw: string | undefined): string | null {
  return given(raw)?.slice(0, HISTORY_SEARCH_MAX) ?? null
}

export function parseRunServersQuery(params: Params): RunServersQuery | InvalidFilter {
  const sort = oneOf(params.sort, RUN_SERVER_SORTS, 'status')
  if (!sort) return { error: 'invalid_filter', field: 'sort' }
  const dir = oneOf(params.dir, ['asc', 'desc'] as const, 'asc')
  if (!dir) return { error: 'invalid_filter', field: 'dir' }
  const outcome = optionalOutcome(params.status)
  if (outcome === 'invalid') return { error: 'invalid_filter', field: 'status' }
  const organizationId = optionalUuid(params.organizationId)
  if (organizationId === 'invalid') return { error: 'invalid_filter', field: 'organizationId' }
  const serverId = optionalUuid(params.serverId)
  if (serverId === 'invalid') return { error: 'invalid_filter', field: 'serverId' }
  return {
    ...parsePage(params.offset, params.limit),
    sort,
    dir,
    outcome,
    organizationId,
    serverId,
    search: optionalSearch(params.q),
  }
}

/** `%`, `_` and `\` matched literally inside an `ILIKE` pattern. */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/** A timestamp as ISO-8601 UTC, or null when absent or unreadable. */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** Whole milliseconds between two timestamps, or null when either is missing or order is reversed. */
export function durationMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}
