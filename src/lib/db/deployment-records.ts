import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { deployment } from './schema.ts'

export const DEPLOYMENT_STATUSES = Object.freeze(
  ['pending', 'applying', 'applied', 'failed', 'draining'] as const,
)

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

/** Terminal outcome of the last apply attempt recorded on a `deployment` row. */
export const DEPLOYMENT_OUTCOMES = Object.freeze(
  ['applied', 'failed', 'timed_out'] as const,
)

export type DeploymentOutcome = (typeof DEPLOYMENT_OUTCOMES)[number]

type DeploymentDbRow = typeof deployment.$inferSelect

export type DeploymentTargetRecord = {
  id: string
  createdAt: string
  updatedAt: string
  metadata: unknown
  options: unknown
  environmentId: string
  serverId: string
  desiredGeneration: number
  appliedGeneration: number | null
  desiredHash: string | null
  status: DeploymentStatus
  lastCommandId: string | null
  /** When the last apply attempt reached a terminal state. */
  finishedAt: string | null
  /** Wall-clock duration of the last apply attempt, in milliseconds. */
  durationMs: number | null
  /** Terminal outcome of the last apply attempt; `null` until one finishes. */
  outcome: DeploymentOutcome | null
}

export type DeploymentTargetInput = {
  serverId: string
  desiredGeneration: number
  desiredHash?: string | null
  status?: DeploymentStatus
  lastCommandId?: string | null
  options?: unknown
}

type DeploymentTransitionParams = {
  environmentId: string
  serverId: string
  status: DeploymentStatus
  appliedGeneration?: number
  commandId?: string
  metadataPatch?: Record<string, unknown>
  finishedAt?: string
  durationMs?: number | null
  outcome?: DeploymentOutcome
}

function isDeploymentStatus(value: string): value is DeploymentStatus {
  return (DEPLOYMENT_STATUSES as readonly string[]).includes(value)
}

function isDeploymentOutcome(value: string): value is DeploymentOutcome {
  return (DEPLOYMENT_OUTCOMES as readonly string[]).includes(value)
}

export function serializeDeploymentTarget(row: DeploymentDbRow): DeploymentTargetRecord {
  const status = isDeploymentStatus(row.status) ? row.status : 'pending'
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata ?? null,
    options: row.options ?? null,
    environmentId: row.environmentId,
    serverId: row.serverId,
    desiredGeneration: row.desiredGeneration,
    appliedGeneration: row.appliedGeneration ?? null,
    desiredHash: row.desiredHash ?? null,
    status,
    lastCommandId: row.lastCommandId ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.durationMs ?? null,
    outcome:
      typeof row.outcome === 'string' && isDeploymentOutcome(row.outcome)
        ? row.outcome
        : null,
  }
}

/**
 * Wall-clock duration of one apply attempt. `startedAt` is preferred; the
 * queue wait is included only when the daemon never stamped a start.
 */
export function deploymentDurationMs(params: {
  startedAt?: string | null
  queuedAt?: string | null
  finishedAt: string
}): number | null {
  const start = params.startedAt ?? params.queuedAt ?? null
  if (!start) return null
  const startMs = Date.parse(start)
  const endMs = Date.parse(params.finishedAt)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
  return Math.max(0, endMs - startMs)
}

function sortDeploymentTargets(
  records: DeploymentTargetRecord[],
): DeploymentTargetRecord[] {
  return [...records].sort((a, b) => {
    const byServer = a.serverId.localeCompare(b.serverId)
    if (byServer !== 0) return byServer
    return a.id.localeCompare(b.id)
  })
}

/**
 * Upsert per-(environment, server) desired state. Never writes
 * `applied_generation` — a re-plan against an already-converged server keeps
 * its applied value so partial convergence stays visible.
 */
export async function upsertDeploymentTargets(
  db: Db,
  params: {
    environmentId: string
    targets: readonly DeploymentTargetInput[]
  },
): Promise<void> {
  if (params.targets.length === 0) return

  const now = nowIso()
  await db
    .insert(deployment)
    .values(
      params.targets.map((target) => ({
        environmentId: params.environmentId,
        serverId: target.serverId,
        desiredGeneration: target.desiredGeneration,
        desiredHash: target.desiredHash ?? null,
        status: target.status ?? 'pending',
        lastCommandId: target.lastCommandId ?? null,
        options: target.options ?? null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [deployment.environmentId, deployment.serverId],
      set: {
        desiredGeneration: sql`excluded.desired_generation`,
        desiredHash: sql`excluded.desired_hash`,
        status: sql`excluded.status`,
        lastCommandId: sql`excluded.last_command_id`,
        options: sql`excluded.options`,
        updatedAt: now,
      },
    })
}

export async function listEnvironmentDeploymentTargets(
  db: Db,
  environmentId: string,
): Promise<DeploymentTargetRecord[]> {
  const rows = await db
    .select()
    .from(deployment)
    .where(eq(deployment.environmentId, environmentId))
    .orderBy(deployment.serverId, deployment.id)

  return sortDeploymentTargets(rows.map(serializeDeploymentTarget))
}

async function transitionDeploymentStatus(
  db: Db,
  params: DeploymentTransitionParams,
): Promise<DeploymentTargetRecord | null> {
  const now = nowIso()
  const patch: Record<string, unknown> = {
    status: params.status,
    updatedAt: now,
  }
  if (params.appliedGeneration !== undefined) {
    patch.appliedGeneration = params.appliedGeneration
  }
  if (params.commandId !== undefined) {
    patch.lastCommandId = params.commandId
  }
  if (params.finishedAt !== undefined) {
    patch.finishedAt = params.finishedAt
  }
  if (params.durationMs !== undefined) {
    patch.durationMs = params.durationMs
  }
  if (params.outcome !== undefined) {
    patch.outcome = params.outcome
  }
  if (params.metadataPatch !== undefined) {
    patch.metadata = sql`coalesce(${deployment.metadata}, '{}'::jsonb) || ${JSON.stringify(params.metadataPatch)}::jsonb`
  }

  const rows = await db
    .update(deployment)
    .set(patch)
    .where(
      and(
        eq(deployment.environmentId, params.environmentId),
        eq(deployment.serverId, params.serverId),
      ),
    )
    .returning()

  const row = rows[0]
  return row ? serializeDeploymentTarget(row) : null
}

/**
 * Record a successful apply. `finishedAt`/`durationMs` summarize *this*
 * attempt only — the row is overwritten by the next deploy. Per-attempt
 * history is read from `command` (see `deployment-history.ts`).
 */
export async function markDeploymentApplied(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    generation: number
    commandId?: string
    finishedAt?: string
    durationMs?: number | null
  },
): Promise<DeploymentTargetRecord | null> {
  const finishedAt = params.finishedAt ?? nowIso()
  return transitionDeploymentStatus(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    status: 'applied',
    appliedGeneration: params.generation,
    metadataPatch: { error: null },
    finishedAt,
    durationMs: params.durationMs ?? null,
    outcome: 'applied',
    ...(params.commandId === undefined ? {} : { commandId: params.commandId }),
  })
}

/**
 * Record a failed apply. `outcome` carries the command's actual terminal
 * status (`failed` vs `timed_out`) so history can tell a daemon rejection
 * apart from a consumer wait that expired; the `deployment.status` column
 * stays `failed` for both, since convergence state is binary.
 */
export async function markDeploymentFailed(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    error?: string
    commandId?: string
    outcome?: DeploymentOutcome
    finishedAt?: string
    durationMs?: number | null
  },
): Promise<DeploymentTargetRecord | null> {
  const metadataPatch: Record<string, unknown> = {}
  if (params.error !== undefined) {
    metadataPatch.error = params.error
  }
  const finishedAt = params.finishedAt ?? nowIso()
  return transitionDeploymentStatus(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    status: 'failed',
    finishedAt,
    durationMs: params.durationMs ?? null,
    outcome: params.outcome ?? 'failed',
    ...(Object.keys(metadataPatch).length > 0 ? { metadataPatch } : {}),
    ...(params.commandId === undefined ? {} : { commandId: params.commandId }),
  })
}

/**
 * Delete the named rows, or every `status='draining'` row for the environment
 * when `serverIds` is omitted.
 */
export async function pruneDrainedDeployments(
  db: Db,
  params: {
    environmentId: string
    serverIds?: readonly string[]
  },
): Promise<void> {
  if (params.serverIds !== undefined) {
    if (params.serverIds.length === 0) return
    await db
      .delete(deployment)
      .where(
        and(
          eq(deployment.environmentId, params.environmentId),
          inArray(deployment.serverId, [...params.serverIds]),
        ),
      )
    return
  }

  await db
    .delete(deployment)
    .where(
      and(
        eq(deployment.environmentId, params.environmentId),
        eq(deployment.status, 'draining'),
      ),
    )
}
