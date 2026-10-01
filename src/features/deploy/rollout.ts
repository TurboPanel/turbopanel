/**
 * Rolling deploys across servers: batches of `update_config.parallelism`.
 *
 * A deploy fans out one `environment.deploy` command per server. With a
 * parallelism of N the control plane records every command up front but only
 * delivers the first N. Each later batch is delivered when the whole batch
 * before it has been applied; the first failed server stops the rollout, the
 * servers not yet started are flagged and their commands cancelled.
 *
 * State lives in rows that already exist: a waiting target is a `deployment`
 * row with status `pending` and `options.rollout = { batch, batches }`, and its
 * command stays `queued` and undelivered. Advancing claims a batch with one
 * conditional update (`pending` to `applying`), so two servers finishing at the
 * same moment cannot deliver the same batch twice.
 *
 * Pure parts ({@link rolloutOptions}, {@link readRolloutOptions},
 * {@link nextRolloutStep}) are separate from the database parts so the
 * decisions are tested without a database.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, deployment } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { transitionCommand } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { nowIso } from '../commands/ids.ts'
import { markDeploymentFailed } from './deployment-records.ts'

/** Same budget `createDeployCommand` gives a command at creation. */
const COMMAND_BUDGET_MS = 600_000

export type RolloutOptions = {
  /** 0-based position of the batch this server belongs to. */
  batch: number
  /** How many batches the rollout has. */
  batches: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `deployment.options.rollout` value for one target. */
export function rolloutOptions(batch: number, batches: number): RolloutOptions {
  return { batch, batches }
}

/** Defensive reader for `deployment.options`; `null` when the target is not part of a rollout. */
export function readRolloutOptions(options: unknown): RolloutOptions | null {
  if (!isRecord(options) || !isRecord(options.rollout)) return null
  const { batch, batches } = options.rollout
  if (!Number.isInteger(batch) || !Number.isInteger(batches)) return null
  if ((batch as number) < 0 || (batches as number) < 1) return null
  return { batch: batch as number, batches: batches as number }
}

export type RolloutTarget = {
  serverId: string
  status: string
  batch: number
}

export type RolloutStep =
  | { action: 'wait' }
  | { action: 'done' }
  | { action: 'halted' }
  | { action: 'start'; batch: number }

/**
 * What a rollout does next, given the state of every target of one generation.
 * A failed target halts it; a batch with any server still applying is waited
 * on; otherwise the lowest batch that has not started is the next to deliver.
 */
export function nextRolloutStep(targets: readonly RolloutTarget[]): RolloutStep {
  if (targets.some((target) => target.status === 'failed')) return { action: 'halted' }
  if (targets.some((target) => target.status === 'applying')) return { action: 'wait' }
  const waiting = targets.filter((target) => target.status === 'pending')
  if (waiting.length === 0) return { action: 'done' }
  return { action: 'start', batch: Math.min(...waiting.map((target) => target.batch)) }
}

type GenerationTarget = RolloutTarget & {
  id: string
  lastCommandId: string | null
}

async function loadGenerationTargets(
  db: Db,
  params: { environmentId: string; generation: number }
): Promise<GenerationTarget[]> {
  const rows = await db
    .select({
      id: deployment.id,
      serverId: deployment.serverId,
      status: deployment.status,
      options: deployment.options,
      lastCommandId: deployment.lastCommandId,
    })
    .from(deployment)
    .where(
      and(
        eq(deployment.environmentId, params.environmentId),
        eq(deployment.desiredGeneration, params.generation)
      )
    )
  const targets: GenerationTarget[] = []
  for (const row of rows) {
    const rollout = readRolloutOptions(row.options)
    if (rollout === null) continue
    targets.push({
      id: row.id,
      serverId: row.serverId,
      status: row.status,
      batch: rollout.batch,
      lastCommandId: row.lastCommandId,
    })
  }
  return targets
}

export type RolloutDeps = {
  enqueue: (envelope: CommandEnvelope) => Promise<void>
}

type ClaimedTarget = { serverId: string; commandId: string }

/** `pending` to `applying` for one batch; only the caller that wins the update gets rows back. */
async function claimBatch(
  db: Db,
  params: { environmentId: string; generation: number; ids: readonly string[] }
): Promise<ClaimedTarget[]> {
  const rows = await db
    .update(deployment)
    .set({ status: 'applying', updatedAt: nowIso() })
    .where(
      and(
        eq(deployment.environmentId, params.environmentId),
        eq(deployment.desiredGeneration, params.generation),
        eq(deployment.status, 'pending'),
        inArray(deployment.id, [...params.ids])
      )
    )
    .returning({ serverId: deployment.serverId, lastCommandId: deployment.lastCommandId })
  return rows.flatMap((row) =>
    row.lastCommandId === null ? [] : [{ serverId: row.serverId, commandId: row.lastCommandId }]
  )
}

/** A waiting command starts its clock when it is delivered, not when it was recorded. */
async function refreshCommandClock(db: Db, commandId: string): Promise<string> {
  const queuedAt = nowIso()
  await db
    .update(command)
    .set({
      queuedAt,
      updatedAt: queuedAt,
      expiresAt: new Date(Date.now() + COMMAND_BUDGET_MS).toISOString(),
    })
    .where(eq(command.id, commandId))
  return queuedAt
}

async function deliverClaimed(
  db: Db,
  deps: RolloutDeps,
  params: { environmentId: string; claimed: ClaimedTarget }
): Promise<boolean> {
  const { claimed } = params
  const queuedAt = await refreshCommandClock(db, claimed.commandId)
  try {
    await deps.enqueue({
      commandId: claimed.commandId,
      serverId: claimed.serverId,
      type: 'environment.deploy',
      attempt: 1,
      queuedAt,
    })
    return true
  } catch {
    const error = 'Command queue unavailable'
    await transitionCommand(db, claimed.commandId, { status: 'failed', error })
    await markDeploymentFailed(db, {
      environmentId: params.environmentId,
      serverId: claimed.serverId,
      error,
      commandId: claimed.commandId,
    })
    return false
  }
}

/**
 * Called when a deploy command of a rollout finishes successfully. Delivers
 * the next batch once the current one is fully applied. Returns the servers
 * whose commands were delivered (empty when there is nothing to start).
 */
export async function advanceRollout(
  db: Db,
  deps: RolloutDeps,
  params: { environmentId: string; generation: number }
): Promise<string[]> {
  const targets = await loadGenerationTargets(db, params)
  const step = nextRolloutStep(targets)
  if (step.action !== 'start') return []
  const ids = targets
    .filter((target) => target.status === 'pending' && target.batch === step.batch)
    .map((target) => target.id)
  const claimed = await claimBatch(db, { ...params, ids })
  const delivered: string[] = []
  const failures: string[] = []
  await forEachSequential(claimed, async (row) => {
    const ok = await deliverClaimed(db, deps, { environmentId: params.environmentId, claimed: row })
    if (ok) delivered.push(row.serverId)
    else failures.push(row.serverId)
  })
  if (failures.length > 0) {
    await haltRollout(db, {
      ...params,
      reason: 'a server in the previous batch could not be reached',
    })
  }
  return delivered
}

/**
 * Stop a rollout: every target of this generation that has not started is
 * marked failed ("not started") and its undelivered command cancelled.
 * Servers already applying are left to finish. Returns the servers flagged.
 */
export async function haltRollout(
  db: Db,
  params: { environmentId: string; generation: number; reason: string }
): Promise<string[]> {
  const error = `rollout stopped: ${params.reason}; this server was not started`
  const finishedAt = nowIso()
  const rows = await db
    .update(deployment)
    .set({
      status: 'failed',
      outcome: 'failed',
      updatedAt: finishedAt,
      finishedAt,
      metadata: sql`coalesce(${deployment.metadata}, '{}'::jsonb) || ${JSON.stringify({
        error,
        rollout: 'not_started',
      })}::jsonb`,
    })
    .where(
      and(
        eq(deployment.environmentId, params.environmentId),
        eq(deployment.desiredGeneration, params.generation),
        eq(deployment.status, 'pending'),
        sql`${deployment.options} -> 'rollout' is not null`
      )
    )
    .returning({ serverId: deployment.serverId, lastCommandId: deployment.lastCommandId })
  await forEachSequential(rows, async (row) => {
    if (row.lastCommandId === null) return
    await transitionCommand(db, row.lastCommandId, { status: 'cancelled', error })
  })
  return rows.map((row) => row.serverId)
}
