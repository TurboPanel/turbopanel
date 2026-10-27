/**
 * Org-wide activity feed (`GET /organizations/:id/activity`): every deploy,
 * restart and stop across every project and environment of one organization,
 * newest first — queued, running, succeeded, failed, timed out, cancelled or
 * rolled back.
 *
 * Reads the `command` table only (never `dispatch`). Deploy rows are kept for
 * good (`prune.ts` never removes `environment.deploy`); restart and stop rows
 * go after the retention window like other finished commands. A command
 * carries an organization column (copied from its server at insert), and the
 * caller's server visibility narrows it further.
 *
 * `step` / `totalSteps` / `stepLabel` come from the step plan the daemon
 * reports on `command.progress` (`command-progress.ts`) and are `null` until
 * it has sent one. Not served yet, on purpose: `crashing` / `crashed` (the
 * control plane records no restart count to derive them from); `crashCount`
 * is always `null`.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, environment, project, user } from '../../db/schema.ts'
import { outcomeFromErrorCode } from '../deploy/deploy-outcome.ts'
import { readDeploymentTrigger, type DeploymentTrigger } from '../deploy/deployment-history.ts'
import { parseStoredCommandProgress } from './command-progress.ts'
import { normalizeContextReleases } from './context.ts'
import { commandIsOpen } from './open-statuses.ts'

/** `deploying` is every item still in progress (queued or being worked on). */
export const ACTIVITY_FILTERS = ['all', 'deploying', 'succeeded', 'failed'] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]

export const ACTIVITY_DEFAULT_LIMIT = 50
export const ACTIVITY_MAX_LIMIT = 100
/**
 * `total` counts at most this many rows past the end of the page, so the
 * count stays cheap however long the history grows; `totalCapped` says when
 * there are more.
 */
export const ACTIVITY_COUNT_LOOKAHEAD = 1000

/*
 * The name and status lists are written into the SQL as literals, not bound
 * parameters, so the planner can match them against the partial indexes
 * `idx_command_activity` and `idx_command_feed` (a generic plan cannot prove a
 * partial predicate from parameters it cannot see). Constants only.
 */
const ACTIVITY_COMMAND_NAMES = [
  'environment.deploy',
  'environment.lifecycle',
  'environment.stop',
] as const
const FAILED_STATUSES = ['failed', 'timed_out'] as const
const LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart'])

/** `queued`: waiting to start (in the queue, or for another build on the server). */
export type ActivityState = 'queued' | 'deploying' | 'succeeded' | 'failed' | 'cancelled'
/** How a `failed` item ended, when it was more than a plain failure. */
export type ActivityFailure = 'timed_out' | 'rolled_back' | 'needs_attention'
export type ActivityAction = 'deploy' | 'start' | 'restart' | 'stop'

export type ActivityQuery = {
  filter: ActivityFilter
  limit: number
  offset: number
  /** Only this project's environments. */
  projectId?: string
  /** Only this environment. */
  environmentId?: string
}

/** The commit a deploy put live, from the release it recorded (or the push behind it). */
export type ActivityCommit = { sha: string; message: string | null }

export type ActivityItem = {
  id: string
  projectId: string | null
  projectName: string | null
  environmentId: string | null
  environmentName: string | null
  serverId: string
  action: ActivityAction
  state: ActivityState
  /** Set only when `state` is `failed`: timed out, rolled back, or stopped on purpose. */
  failure: ActivityFailure | null
  startedAt: string
  /** When it ended; `null` while it is still in progress. */
  finishedAt: string | null
  /** Steps finished so far, plus one while a step is running; `null` without a step plan. */
  step: number | null
  /** Steps with work to do (`ready` steps are not counted); `null` without a step plan. */
  totalSteps: number | null
  /** Label of the running step, or `null` when none is running. */
  stepLabel: string | null
  durationSecs: number
  errorMessage: string | null
  /** `user` when a person asked for it, `system` when the panel did (a push, a schedule). */
  actorType: 'user' | 'system'
  /** The person's name, else their email; `null` for `system` or a removed account. */
  actorName: string | null
  /** The push that set it off, `null` for a person's deploy. */
  trigger: DeploymentTrigger | null
  commit: ActivityCommit | null
  crashCount: null
}

export type ActivityFeed = {
  items: ActivityItem[]
  /** Matching rows, counted up to the end of this page plus `ACTIVITY_COUNT_LOOKAHEAD`. */
  total: number
  /** `true` when there are more rows than `total` says. */
  totalCapped: boolean
  hasMore: boolean
}

type ParseResult = { ok: true; query: ActivityQuery } | { ok: false; error: string }

function parseIntParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d{1,9}$/.test(raw)) return null
  const value = Number(raw)
  return value < min ? null : Math.min(value, max)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An optional id filter: absent is fine, anything but a UUID is `null` (a 400). */
function parseIdParam(raw: string | undefined): { ok: true; id?: string } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true }
  return UUID_RE.test(raw) ? { ok: true, id: raw.toLowerCase() } : { ok: false }
}

/** Validate the query string; `limit` above the maximum is clamped, anything malformed is a 400. */
export function parseActivityQuery(params: {
  filter?: string
  limit?: string
  offset?: string
  projectId?: string
  environmentId?: string
}): ParseResult {
  const filter = params.filter === undefined || params.filter === '' ? 'all' : params.filter
  if (!(ACTIVITY_FILTERS as readonly string[]).includes(filter)) {
    return { ok: false, error: 'Invalid filter' }
  }
  const limit = parseIntParam(params.limit, ACTIVITY_DEFAULT_LIMIT, 1, ACTIVITY_MAX_LIMIT)
  if (limit === null) return { ok: false, error: 'Invalid limit' }
  const offset = parseIntParam(params.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  if (offset === null) return { ok: false, error: 'Invalid offset' }
  const projectId = parseIdParam(params.projectId)
  if (!projectId.ok) return { ok: false, error: 'Invalid projectId' }
  const environmentId = parseIdParam(params.environmentId)
  if (!environmentId.ok) return { ok: false, error: 'Invalid environmentId' }
  return {
    ok: true,
    query: {
      filter: filter as ActivityFilter,
      limit,
      offset,
      ...(projectId.id === undefined ? {} : { projectId: projectId.id }),
      ...(environmentId.id === undefined ? {} : { environmentId: environmentId.id }),
    },
  }
}

/** `'a', 'b'` from a constant list (never user input), for the index-matching predicates. */
function literalList(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value}'`).join(', '))
}

function stateCondition(filter: ActivityFilter): SQL | undefined {
  if (filter === 'deploying') return commandIsOpen()
  if (filter === 'failed') return sql`${command.status} IN (${literalList(FAILED_STATUSES)})`
  if (filter === 'succeeded') return sql`${command.status} = 'succeeded'`
  return undefined
}

/** Project and environment narrowing; the organization is enforced on the command row anyway. */
function placeCondition(query: ActivityQuery): SQL | undefined {
  if (query.environmentId !== undefined) return eq(command.environmentId, query.environmentId)
  if (query.projectId === undefined) return undefined
  return inArray(
    command.environmentId,
    sql`(select ${environment.id} from ${environment} where ${environment.projectId} = ${query.projectId})`
  )
}

export function activityActionOf(name: string, context: unknown): ActivityAction {
  if (name === 'environment.deploy') return 'deploy'
  if (name === 'environment.stop') return 'stop'
  const action = (context as { action?: unknown } | null)?.action
  return typeof action === 'string' && LIFECYCLE_ACTIONS.has(action)
    ? (action as ActivityAction)
    : 'restart'
}

function contextId(context: unknown, key: string): string | null {
  const value = (context as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : null
}

type ActivityRow = {
  id: string
  serverId: string
  name: string
  status: string
  context: unknown
  metadata?: unknown
  progress?: unknown
  actorType?: string
  actorId?: string
  /** `command.environment_id`; older rows only carry it in `context`. */
  environmentId?: string | null
  errorCode?: string | null
  errorMessage: string | null
  createdAt: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

type EnvironmentNames = Map<
  string,
  { name: string | null; projectId: string; projectName: string | null }
>

/**
 * "Step N of M" from a stored step plan: M counts every step that has work
 * to do (`ready` ones were already on the server), N the steps done plus the
 * one running. Nulls when the daemon has not reported a plan.
 */
export function activityStepsOf(progress: unknown): {
  step: number | null
  totalSteps: number | null
  stepLabel: string | null
} {
  const plan = parseStoredCommandProgress(progress)
  if (plan === null) return { step: null, totalSteps: null, stepLabel: null }
  const running = plan.steps.find((step) => step.state === 'running')
  const done = plan.steps.filter((step) => step.state === 'done').length
  return {
    step: done + (running ? 1 : 0),
    totalSteps: plan.steps.filter((step) => step.state !== 'ready').length,
    stepLabel: running?.label ?? null,
  }
}

/**
 * Waiting rather than working: not yet handed to the server, or handed over
 * and told by the server that it is waiting for another build to finish.
 */
export function isActivityQueued(status: string, progress: unknown): boolean {
  if (status === 'queued' || status === 'dispatching') return true
  return parseStoredCommandProgress(progress)?.runningSince === null
}

/** The command status as the feed names it, plus how a failure ended. */
export function activityStateOf(row: Pick<ActivityRow, 'status' | 'progress' | 'errorCode'>): {
  state: ActivityState
  failure: ActivityFailure | null
} {
  if (row.status === 'succeeded') return { state: 'succeeded', failure: null }
  if (row.status === 'cancelled') return { state: 'cancelled', failure: null }
  if (row.status === 'timed_out') return { state: 'failed', failure: 'timed_out' }
  if (row.status === 'failed') {
    return { state: 'failed', failure: outcomeFromErrorCode(row.errorCode) }
  }
  return {
    state: isActivityQueued(row.status, row.progress) ? 'queued' : 'deploying',
    failure: null,
  }
}

/** The first commit the deploy recorded a release for, else the pushed SHA. */
export function activityCommitOf(
  context: unknown,
  trigger: DeploymentTrigger | null
): ActivityCommit | null {
  const release = normalizeContextReleases(
    (context as Record<string, unknown> | null)?.releases
  )?.[0]
  if (release) return { sha: release.commitSha, message: release.commitMessage ?? null }
  return trigger?.commitSha ? { sha: trigger.commitSha, message: null } : null
}

function environmentIdOf(row: ActivityRow): string | null {
  return row.environmentId ?? contextId(row.context, 'environmentId')
}

function durationSecsOf(startedAt: string, finishedAt: string | null, now: Date): number {
  const end = finishedAt === null ? now.getTime() : Date.parse(finishedAt)
  return Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000))
}

export function shapeActivityItem(
  row: ActivityRow,
  names: EnvironmentNames,
  now: Date,
  actors: Map<string, string> = new Map()
): ActivityItem {
  const environmentId = environmentIdOf(row)
  const env = environmentId === null ? undefined : names.get(environmentId)
  const { state, failure } = activityStateOf(row)
  const finished = state !== 'queued' && state !== 'deploying'
  const startedAt = row.startedAt ?? row.queuedAt ?? row.createdAt
  const finishedAt = finished ? row.finishedAt : null
  const actorType = row.actorType === 'user' ? 'user' : 'system'
  const trigger = readDeploymentTrigger({ actorType, metadata: row.metadata })
  return {
    id: row.id,
    projectId: env?.projectId ?? null,
    projectName: env?.projectName ?? null,
    environmentId: env === undefined ? null : environmentId,
    environmentName: env?.name ?? null,
    serverId: row.serverId,
    action: activityActionOf(row.name, row.context),
    state,
    failure,
    startedAt,
    finishedAt,
    ...activityStepsOf(row.progress),
    durationSecs: durationSecsOf(startedAt, finishedAt, now),
    errorMessage: state === 'failed' ? row.errorMessage : null,
    actorType,
    actorName: actorType === 'user' && row.actorId ? (actors.get(row.actorId) ?? null) : null,
    trigger,
    commit: activityCommitOf(row.context, trigger),
    crashCount: null,
  }
}

async function loadEnvironmentNames(
  db: Db,
  organizationId: string,
  rows: ActivityRow[]
): Promise<EnvironmentNames> {
  const ids = [...new Set(rows.map(environmentIdOf).filter((id) => id !== null))]
  const names: EnvironmentNames = new Map()
  if (ids.length === 0) return names
  const found = await db
    .select({
      id: environment.id,
      name: environment.name,
      projectId: environment.projectId,
      projectName: project.name,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(and(inArray(environment.id, ids), eq(project.organizationId, organizationId)))
  for (const row of found) names.set(row.id, row)
  return names
}

/** Who asked: the person's name, else their email. Only ids from this page's rows are read. */
async function loadActorNames(db: Db, rows: ActivityRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.filter((row) => row.actorType === 'user').map((row) => row.actorId!)),
  ]
  const names = new Map<string, string>()
  if (ids.length === 0) return names
  const found = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, ids))
  for (const row of found) names.set(row.id, row.name?.trim() || row.email)
  return names
}

/**
 * One page of the organization's activity, newest first. `visibleServerIds` is
 * the caller's `listVisible(server)` set; the organization is also enforced on
 * the command row (`command.organization_id`, copied from the server), so a
 * foreign server id can never surface a foreign command.
 *
 * Walks `idx_command_activity` (organization, newest first, these three
 * command names) and stops after the page; the count stops
 * `ACTIVITY_COUNT_LOOKAHEAD` rows past it.
 */
export async function queryOrgActivityFeed(
  db: Db,
  organizationId: string,
  visibleServerIds: string[],
  query: ActivityQuery,
  now: Date = new Date()
): Promise<ActivityFeed> {
  if (visibleServerIds.length === 0) {
    return { items: [], total: 0, totalCapped: false, hasMore: false }
  }
  const { limit, offset } = query
  const where = and(
    eq(command.organizationId, organizationId),
    inArray(command.serverId, visibleServerIds),
    sql`${command.name} IN (${literalList(ACTIVITY_COMMAND_NAMES)})`,
    stateCondition(query.filter),
    placeCondition(query)
  )
  const countCap = offset + limit + ACTIVITY_COUNT_LOOKAHEAD
  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: command.id,
        serverId: command.serverId,
        name: command.name,
        status: command.status,
        context: command.context,
        metadata: command.metadata,
        progress: command.progress,
        actorType: command.actorType,
        actorId: command.actorId,
        environmentId: command.environmentId,
        errorCode: command.errorCode,
        errorMessage: command.errorMessage,
        createdAt: command.createdAt,
        queuedAt: command.queuedAt,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
      })
      .from(command)
      .where(where)
      .orderBy(desc(command.createdAt), desc(command.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(
      db
        .select({ one: sql`1`.as('one') })
        .from(command)
        .where(where)
        .limit(countCap + 1)
        .as('capped')
    ),
  ])
  const [names, actors] = await Promise.all([
    loadEnvironmentNames(db, organizationId, rows),
    loadActorNames(db, rows),
  ])
  const counted = countRow?.total ?? 0
  const totalCapped = counted > countCap
  const total = Math.min(counted, countCap)
  return {
    items: rows.map((row) => shapeActivityItem(row, names, now, actors)),
    total,
    totalCapped,
    hasMore: totalCapped || offset + rows.length < total,
  }
}
