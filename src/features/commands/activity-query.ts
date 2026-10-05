/**
 * Org-wide activity feed (`GET /organizations/:id/activity`): the deploys,
 * restarts and stops that are running or recently failed across every project
 * and environment of one organization.
 *
 * Reads the `command` table only (never `dispatch`). A command carries no
 * organization column, so the organization comes from the command's server
 * (`server.organization_id`) and the caller's server visibility.
 *
 * Not served yet, on purpose: `crashing` / `crashed` (the control plane
 * records no restart count to derive them from) and `step` / `totalSteps`
 * (no per-step progress is stored). Those response fields are always `null`.
 */
import { and, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, environment, project, server } from '../../db/schema.ts'

export const ACTIVITY_FILTERS = ['all', 'deploying', 'failed'] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]

export const ACTIVITY_DEFAULT_LIMIT = 50
export const ACTIVITY_MAX_LIMIT = 100
/** A failed command stays in the feed this long; running ones stay until they end. */
export const ACTIVITY_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const ACTIVITY_COMMAND_NAMES = [
  'environment.deploy',
  'environment.lifecycle',
  'environment.stop',
] as const
const IN_PROGRESS_STATUSES = ['queued', 'dispatching', 'sent', 'acked', 'running'] as const
const FAILED_STATUSES = ['failed', 'timed_out'] as const
const LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart'])

export type ActivityState = 'deploying' | 'failed'
export type ActivityAction = 'deploy' | 'start' | 'restart' | 'stop'

export type ActivityQuery = { filter: ActivityFilter; limit: number; offset: number }

export type ActivityItem = {
  id: string
  projectId: string | null
  projectName: string | null
  environmentId: string | null
  environmentName: string | null
  serverId: string
  action: ActivityAction
  state: ActivityState
  startedAt: string
  step: null
  totalSteps: null
  durationSecs: number
  errorMessage: string | null
  crashCount: null
}

export type ActivityFeed = { items: ActivityItem[]; total: number; hasMore: boolean }

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

/** Validate the query string; `limit` above the maximum is clamped, anything malformed is a 400. */
export function parseActivityQuery(params: {
  filter?: string
  limit?: string
  offset?: string
}): ParseResult {
  const filter = params.filter === undefined || params.filter === '' ? 'all' : params.filter
  if (!(ACTIVITY_FILTERS as readonly string[]).includes(filter)) {
    return { ok: false, error: 'Invalid filter' }
  }
  const limit = parseIntParam(params.limit, ACTIVITY_DEFAULT_LIMIT, 1, ACTIVITY_MAX_LIMIT)
  if (limit === null) return { ok: false, error: 'Invalid limit' }
  const offset = parseIntParam(params.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  if (offset === null) return { ok: false, error: 'Invalid offset' }
  return { ok: true, query: { filter: filter as ActivityFilter, limit, offset } }
}

function stateCondition(filter: ActivityFilter, now: Date): SQL {
  const inProgress = inArray(command.status, [...IN_PROGRESS_STATUSES])
  const failed = and(
    inArray(command.status, [...FAILED_STATUSES]),
    gte(command.createdAt, new Date(now.getTime() - ACTIVITY_FAILED_WINDOW_MS).toISOString())
  )!
  if (filter === 'deploying') return inProgress
  if (filter === 'failed') return failed
  return sql`(${inProgress} or ${failed})`
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
  errorMessage: string | null
  createdAt: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export function shapeActivityItem(
  row: ActivityRow,
  names: Map<string, { name: string | null; projectId: string; projectName: string | null }>,
  now: Date
): ActivityItem {
  const environmentId = contextId(row.context, 'environmentId')
  const env = environmentId === null ? undefined : names.get(environmentId)
  const failed = (FAILED_STATUSES as readonly string[]).includes(row.status)
  const startedAt = row.startedAt ?? row.queuedAt ?? row.createdAt
  const end = failed && row.finishedAt !== null ? Date.parse(row.finishedAt) : now.getTime()
  return {
    id: row.id,
    projectId: env?.projectId ?? null,
    projectName: env?.projectName ?? null,
    environmentId: env === undefined ? null : environmentId,
    environmentName: env?.name ?? null,
    serverId: row.serverId,
    action: activityActionOf(row.name, row.context),
    state: failed ? 'failed' : 'deploying',
    startedAt,
    step: null,
    totalSteps: null,
    durationSecs: Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000)),
    errorMessage: failed ? row.errorMessage : null,
    crashCount: null,
  }
}

async function loadEnvironmentNames(db: Db, organizationId: string, rows: ActivityRow[]) {
  const ids = [
    ...new Set(
      rows.map((row) => contextId(row.context, 'environmentId')).filter((id) => id !== null)
    ),
  ]
  const names = new Map<
    string,
    { name: string | null; projectId: string; projectName: string | null }
  >()
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

/**
 * One page of the organization's activity, newest first. `visibleServerIds` is
 * the caller's `listVisible(server)` set; the organization is also enforced on
 * the server row, so a foreign server id can never surface a foreign command.
 */
export async function queryOrgActivityFeed(
  db: Db,
  organizationId: string,
  visibleServerIds: string[],
  { filter, limit, offset }: ActivityQuery,
  now: Date = new Date()
): Promise<ActivityFeed> {
  if (visibleServerIds.length === 0) return { items: [], total: 0, hasMore: false }

  const where = and(
    eq(server.organizationId, organizationId),
    inArray(command.serverId, visibleServerIds),
    inArray(command.name, [...ACTIVITY_COMMAND_NAMES]),
    stateCondition(filter, now)
  )
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        id: command.id,
        serverId: command.serverId,
        name: command.name,
        status: command.status,
        context: command.context,
        errorMessage: command.errorMessage,
        createdAt: command.createdAt,
        queuedAt: command.queuedAt,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
      })
      .from(command)
      .innerJoin(server, eq(server.id, command.serverId))
      .where(where)
      .orderBy(desc(command.createdAt), desc(command.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(command)
      .innerJoin(server, eq(server.id, command.serverId))
      .where(where),
  ])
  const names = await loadEnvironmentNames(db, organizationId, rows)
  const total = counted?.total ?? 0
  return {
    items: rows.map((row) => shapeActivityItem(row, names, now)),
    total,
    hasMore: offset + rows.length < total,
  }
}
