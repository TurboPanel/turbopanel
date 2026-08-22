/**
 * Environment deploy **history** reads.
 *
 * `deployment` is an upsert-per-`(environment_id, server_id)` table — it holds
 * only the current desired/applied state per target and is overwritten on every
 * redeploy, so it can never answer "list the past deploys". The append-only
 * source of truth for individual attempts is the `command` table itself: every
 * `environment.deploy` command is a distinct, never-overwritten row carrying
 * `queued_at…finished_at`, `status`, actor attribution, and the non-secret
 * `context` bag (`environmentId`, `generation`, `desiredHash`, `replicaCounts`).
 *
 * Environment scoping therefore goes through `context->>'environmentId'`,
 * backed by the partial expression index `idx_command_deploy_environment_created`
 * — deliberately not a denormalized `command.environment_id` column, which
 * would duplicate state the context allowlist already carries.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { normalizeReplicaCounts } from '../commands/context.ts'
import type { ExecutionLogStore } from '../execution-logs/types.ts'
import { deploymentDurationMs } from './deployment-records.ts'
import { command, deployment, server } from './schema.ts'

/** Default page size for `GET /environments/:id/deployments`. */
export const DEPLOYMENT_HISTORY_DEFAULT_LIMIT = 20

/** Hard page cap — mirrors `listServerCommands` / the batched status route. */
export const DEPLOYMENT_HISTORY_MAX_LIMIT = 100

/** The only command type that constitutes a deploy attempt. */
const DEPLOY_COMMAND_NAME = 'environment.deploy'

/**
 * Explicit column list — never `select()` the whole row, and never join
 * `dispatch` (that is where secret-bearing payload lives).
 */
const DEPLOY_COMMAND_COLUMNS = {
  id: command.id,
  serverId: command.serverId,
  status: command.status,
  context: command.context,
  actorType: command.actorType,
  actorId: command.actorId,
  errorCode: command.errorCode,
  errorMessage: command.errorMessage,
  createdAt: command.createdAt,
  queuedAt: command.queuedAt,
  startedAt: command.startedAt,
  finishedAt: command.finishedAt,
  serverName: server.name,
} as const

type DeployCommandRow = {
  id: string
  serverId: string
  status: string
  context: unknown
  actorType: string
  actorId: string
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  serverName: string | null
}

/** One deploy attempt against one server. */
export type DeploymentHistoryEntry = {
  /** The `command` row id — this *is* the deployment id in the client API. */
  id: string
  /** Alias of {@link DeploymentHistoryEntry.id}, for call sites that fetch logs. */
  commandId: string
  /** Environment compose generation this attempt targeted. */
  generation: number | null
  /** sha256 of the compiled runtime compose sent to this server. */
  desiredHash: string | null
  /**
   * Per-service replica counts this attempt asked the host to run, captured on
   * `command.context` at enqueue time. `null` for legacy rows queued before the
   * counts were persisted.
   */
  replicaCounts: Record<string, number> | null
  serverId: string
  serverName: string | null
  /** Command lifecycle status (`queued`…`succeeded`/`failed`/`timed_out`). */
  status: string
  actorEntityType: string
  actorEntityId: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Wall-clock duration of the attempt, or `null` while still running. */
  durationMs: number | null
  errorCode: string | null
  errorMessage: string | null
  /** Whether an execution-log transcript is retained (store-side, not a column). */
  hasLog: boolean
}

export type ListDeploymentHistoryParams = {
  limit?: number
  /**
   * Keyset cursor: return only attempts older than this command id. Command ids
   * are UUIDv7, so id order matches `created_at` order.
   */
  before?: string
  /** Resolves `hasLog`; omit in runtimes with no configured store. */
  logStore?: ExecutionLogStore
}

export type DeploymentHistoryPage = {
  deployments: DeploymentHistoryEntry[]
  /** Pass back as `before` to fetch the next (older) page; `null` at the end. */
  nextCursor: string | null
}

/** Per-server convergence for one generation, read from *current* state. */
export type DeploymentDetailServer = {
  serverId: string
  serverName: string | null
  status: string
  /**
   * `deployment.applied_generation` as it stands **now**. There is no
   * per-generation replica snapshot, so this reflects current convergence, not
   * a historical one: after a newer deploy this may exceed `generation`.
   */
  appliedGeneration: number | null
  /** Current desired generation for the target, or `null` if the row is gone. */
  desiredGeneration: number | null
  /** Current deployment status for the target, or `null` if the row is gone. */
  deploymentStatus: string | null
  /**
   * Per-service replica counts this host was asked to run *by this attempt* —
   * a historical value read off `command.context`, unlike the convergence
   * fields above. `null` for legacy rows queued before it was persisted.
   */
  replicaCounts: Record<string, number> | null
  /** Sum of {@link DeploymentDetailServer.replicaCounts}; `null` when absent. */
  totalReplicas: number | null
}

export type DeploymentHistoryDetail = {
  /** The anchor attempt the caller asked for. */
  id: string
  environmentId: string
  generation: number | null
  desiredHash: string | null
  /**
   * Per-service replica counts for the whole fan-out — summed across every
   * participating host, from the historical `command.context` of each attempt.
   * `{}` when no attempt in the fan-out carries counts (legacy rows).
   */
  replicaCounts: Record<string, number>
  /** Sum of {@link DeploymentHistoryDetail.replicaCounts} across all services. */
  totalReplicas: number
  /** Every attempt in the same fan-out (one per participating server). */
  commands: DeploymentHistoryEntry[]
  servers: DeploymentDetailServer[]
}

function sumReplicaCounts(counts: Record<string, number> | null): number | null {
  if (!counts) return null
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

function contextBag(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function contextNumber(context: Record<string, unknown>, key: string): number | null {
  const raw = context[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function contextString(context: Record<string, unknown>, key: string): string | null {
  const raw = context[key]
  return typeof raw === 'string' ? raw : null
}

function contextReplicaCounts(
  context: Record<string, unknown>,
): Record<string, number> | null {
  return normalizeReplicaCounts(context.replicaCounts) ?? null
}

function clampLimit(limit: number | undefined): number {
  return Math.min(
    Math.max(limit ?? DEPLOYMENT_HISTORY_DEFAULT_LIMIT, 1),
    DEPLOYMENT_HISTORY_MAX_LIMIT,
  )
}

/** `context->>'environmentId' = :id` — matches the partial expression index. */
function environmentContextFilter(environmentId: string) {
  return sql`${command.context} ->> 'environmentId' = ${environmentId}`
}

function serializeEntry(row: DeployCommandRow, hasLog: boolean): DeploymentHistoryEntry {
  const context = contextBag(row.context)
  return {
    id: row.id,
    commandId: row.id,
    generation: contextNumber(context, 'generation'),
    desiredHash: contextString(context, 'desiredHash'),
    replicaCounts: contextReplicaCounts(context),
    serverId: row.serverId,
    serverName: row.serverName ?? null,
    status: row.status,
    actorEntityType: row.actorType,
    actorEntityId: row.actorId,
    queuedAt: row.queuedAt ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.finishedAt
      ? deploymentDurationMs({
          startedAt: row.startedAt,
          queuedAt: row.queuedAt ?? row.createdAt,
          finishedAt: row.finishedAt,
        })
      : null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    hasLog,
  }
}

/**
 * Transcript existence is store-side, not a Postgres column — resolve it per id
 * in parallel, exactly as the batched command-status route does. Fan-out is
 * bounded by the page limit.
 */
async function resolveHasLogs(
  store: ExecutionLogStore | undefined,
  ids: readonly string[],
): Promise<boolean[]> {
  if (!store) return ids.map(() => false)
  return await Promise.all(ids.map((id) => store.exists(id).catch(() => false)))
}

/**
 * Newest-first page of deploy attempts for one environment. Authorization is
 * the caller's job — this helper does no visibility filtering.
 */
export async function listEnvironmentDeploymentHistory(
  db: Db,
  environmentId: string,
  params: ListDeploymentHistoryParams = {},
): Promise<DeploymentHistoryPage> {
  const limit = clampLimit(params.limit)

  const filters = [
    eq(command.name, DEPLOY_COMMAND_NAME),
    environmentContextFilter(environmentId),
  ]
  if (params.before) {
    filters.push(lt(command.id, params.before))
  }

  const rows = (await db
    .select(DEPLOY_COMMAND_COLUMNS)
    .from(command)
    .leftJoin(server, eq(server.id, command.serverId))
    .where(and(...filters))
    // UUIDv7 ids are time-ordered, so `id DESC` breaks `created_at` ties in the
    // same direction the keyset cursor walks.
    .orderBy(desc(command.createdAt), desc(command.id))
    // One extra row tells us whether another page exists without a count query.
    .limit(limit + 1)) as DeployCommandRow[]

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const hasLogs = await resolveHasLogs(
    params.logStore,
    page.map((row) => row.id),
  )

  const deployments = page.map((row, index) => serializeEntry(row, hasLogs[index] ?? false))
  return {
    deployments,
    nextCursor: hasMore ? (deployments.at(-1)?.id ?? null) : null,
  }
}

/**
 * One deploy attempt plus its sibling fan-out — every `environment.deploy`
 * command in the same environment sharing the anchor's `context.generation`.
 *
 * Returns `null` when the id is not an `environment.deploy` command for this
 * environment, so routes can 404 without leaking cross-environment ids.
 */
export async function getEnvironmentDeploymentDetail(
  db: Db,
  environmentId: string,
  deploymentId: string,
  params: { logStore?: ExecutionLogStore } = {},
): Promise<DeploymentHistoryDetail | null> {
  const anchorRows = (await db
    .select(DEPLOY_COMMAND_COLUMNS)
    .from(command)
    .leftJoin(server, eq(server.id, command.serverId))
    .where(
      and(
        eq(command.id, deploymentId),
        eq(command.name, DEPLOY_COMMAND_NAME),
        environmentContextFilter(environmentId),
      ),
    )
    .limit(1)) as DeployCommandRow[]

  const anchor = anchorRows[0]
  if (!anchor) return null

  const anchorContext = contextBag(anchor.context)
  const generation = contextNumber(anchorContext, 'generation')

  // Same-generation siblings are the multi-server fan-out of one deploy. With
  // no generation in context (legacy rows) the anchor stands alone.
  //
  // Deliberately unpaginated: the detail response is the authoritative list of
  // participating hosts, so a per-host transcript selector must be able to
  // enumerate all of them. The set is bounded by the environment's server
  // count for one generation, not by history depth.
  const rows =
    generation === null
      ? [anchor]
      : ((await db
          .select(DEPLOY_COMMAND_COLUMNS)
          .from(command)
          .leftJoin(server, eq(server.id, command.serverId))
          .where(
            and(
              eq(command.name, DEPLOY_COMMAND_NAME),
              environmentContextFilter(environmentId),
              sql`${command.context} ->> 'generation' = ${String(generation)}`,
            ),
          )
          .orderBy(desc(command.createdAt), desc(command.id))) as DeployCommandRow[])

  const hasLogs = await resolveHasLogs(
    params.logStore,
    rows.map((row) => row.id),
  )
  const commands = rows.map((row, index) => serializeEntry(row, hasLogs[index] ?? false))

  // Live join to current state — see DeploymentDetailServer.appliedGeneration:
  // this is *not* a historical snapshot, no per-generation one is persisted.
  const targetRows = await db
    .select({
      serverId: deployment.serverId,
      desiredGeneration: deployment.desiredGeneration,
      appliedGeneration: deployment.appliedGeneration,
      status: deployment.status,
    })
    .from(deployment)
    .where(eq(deployment.environmentId, environmentId))

  const targetsByServer = new Map(targetRows.map((row) => [row.serverId, row]))
  const servers: DeploymentDetailServer[] = commands.map((entry) => {
    const target = targetsByServer.get(entry.serverId)
    return {
      serverId: entry.serverId,
      serverName: entry.serverName,
      status: entry.status,
      appliedGeneration: target?.appliedGeneration ?? null,
      desiredGeneration: target?.desiredGeneration ?? null,
      deploymentStatus: target?.status ?? null,
      replicaCounts: entry.replicaCounts,
      totalReplicas: sumReplicaCounts(entry.replicaCounts),
    }
  })

  // Fan-out total: services are keyed per compose service, and a spanning
  // service appears on each host it landed on, so counts add across hosts.
  const replicaCounts: Record<string, number> = {}
  for (const entry of commands) {
    for (const [service, count] of Object.entries(entry.replicaCounts ?? {})) {
      replicaCounts[service] = (replicaCounts[service] ?? 0) + count
    }
  }

  return {
    id: anchor.id,
    environmentId,
    generation,
    desiredHash: contextString(anchorContext, 'desiredHash'),
    replicaCounts,
    totalReplicas: sumReplicaCounts(replicaCounts) ?? 0,
    commands,
    servers,
  }
}
