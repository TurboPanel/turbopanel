/**
 * Finish the host cleanup of a force-deleted or failed-created managed
 * database on a host that was offline (or lost the command) when the delete
 * ran.
 *
 * A command for a host that is not connected fails at once, so the 7-day
 * expiry on the force-delete destroy only bounds how long a retry may still
 * happen. This sweep is the retry: on the shared maintenance tick, a flagged
 * destroy that ended `failed` or `timed_out`, whose host is connected again
 * and which has not expired, is queued once more. The host side is keyed by
 * the cluster's id (compose project, state folder, data volume), so a database
 * created again with the same name has a different id and is never touched.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, managed, server } from '../../db/schema.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import { commandIsOpen } from '../commands/open-statuses.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'

/** Command metadata flag set on the destroy commands this sweep may retry. */
export const MANAGED_DESTROY_REDRIVE_FLAG = 'redriveWhenOnline'
const REDRIVE_ATTEMPTS_KEY = 'redriveAttempts'
const REDRIVE_DONE_KEY = 'redriveQueuedAs'

/** Tries per member host; a host that keeps failing is left for the operator. */
export const MANAGED_DESTROY_REDRIVE_MAX_ATTEMPTS = 10
/** Rows looked at per tick. */
export const MANAGED_DESTROY_REDRIVE_SWEEP_CAP = 25

type Candidate = {
  id: string
  serverId: string
  context: unknown
  metadata: unknown
  expiresAt: string | null
  createdAt: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function contextString(context: unknown, key: string): string | undefined {
  const value = asRecord(context)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function listCandidates(db: Db, limit: number): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: command.id,
      serverId: command.serverId,
      context: command.context,
      metadata: command.metadata,
      expiresAt: command.expiresAt,
      createdAt: command.createdAt,
    })
    .from(command)
    .innerJoin(server, eq(server.id, command.serverId))
    .where(
      and(
        eq(command.name, 'managed.destroy'),
        inArray(command.status, ['failed', 'timed_out']),
        sql`${command.metadata}->>${MANAGED_DESTROY_REDRIVE_FLAG} = 'true'`,
        sql`${command.metadata}->>${REDRIVE_DONE_KEY} is null`,
        sql`${command.expiresAt} > now()`,
        eq(server.isConnected, true)
      )
    )
    .orderBy(command.createdAt)
    .limit(limit)
  return rows.map((row) => ({
    ...row,
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  }))
}

/** True when the cluster row still exists (this is not a cleanup of a deleted one). */
async function clusterStillExists(db: Db, managedId: string): Promise<boolean> {
  const rows = await db
    .select({ id: managed.id })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return rows.length > 0
}

/** A newer destroy for the same cluster on the same host is open or already done. */
async function newerDestroyExists(db: Db, row: Candidate, managedId: string): Promise<boolean> {
  const rows = await db
    .select({ id: command.id })
    .from(command)
    .where(
      and(
        eq(command.name, 'managed.destroy'),
        eq(command.serverId, row.serverId),
        sql`${command.context}->>'managedId' = ${managedId}`,
        sql`${command.id} <> ${row.id}`,
        sql`${command.createdAt} > ${row.createdAt}::timestamptz`,
        sql`(${commandIsOpen()} or ${command.status} = 'succeeded')`
      )
    )
    .limit(1)
  return rows.length > 0
}

async function redriveOne(db: Db, commandQueue: CommandQueue, row: Candidate): Promise<boolean> {
  const managedId = contextString(row.context, 'managedId')
  const meta = asRecord(row.metadata) ?? {}
  const attempts = typeof meta[REDRIVE_ATTEMPTS_KEY] === 'number' ? meta[REDRIVE_ATTEMPTS_KEY] : 0
  if (!managedId || !row.expiresAt) return false
  if (attempts >= MANAGED_DESTROY_REDRIVE_MAX_ATTEMPTS) return false
  if ((await clusterStillExists(db, managedId)) || (await newerDestroyExists(db, row, managedId))) {
    return false
  }

  const memberId = contextString(row.context, 'memberId')
  const environmentId = contextString(row.context, 'environmentId')
  // Rebuilt from the command's context: the stored payload of a failed command
  // is only kept for about a day. The cluster row is gone, so the volumes
  // always go with it and nothing is deleted afterwards.
  const payload = {
    managedId,
    removeVolumes: true,
    ...(memberId ? { memberId } : {}),
    ...(environmentId ? { environmentId } : {}),
  }
  const record = await createCommandRecord(db, {
    serverId: row.serverId,
    actorType: 'system',
    actorId: row.serverId,
    type: 'managed.destroy',
    payload,
    // Same deadline as the original: a retry never extends the 7 days.
    expiresAt: row.expiresAt,
    metadata: {
      [MANAGED_DESTROY_REDRIVE_FLAG]: true,
      [REDRIVE_ATTEMPTS_KEY]: attempts + 1,
      redriveOf: row.id,
    },
  })
  // Claim the old row before queueing, so a failed claim cannot double-queue.
  await db
    .update(command)
    .set({ metadata: { ...meta, [REDRIVE_DONE_KEY]: record.id } })
    .where(eq(command.id, row.id))

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: row.serverId,
    type: 'managed.destroy',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return false
  }
  compatLogInfo(
    'managed',
    `managed.destroy redrive managedId=${managedId} serverId=${row.serverId} attempt=${attempts + 1}`
  )
  return true
}

/**
 * One tick. Returns how many destroys were queued again. Never throws: a row
 * that cannot be retried now is looked at again on the next tick.
 */
export async function runManagedDestroyRedriveSweep(
  db: Db,
  commandQueue: CommandQueue
): Promise<number> {
  let queued = 0
  const rows = await listCandidates(db, MANAGED_DESTROY_REDRIVE_SWEEP_CAP)
  await forEachSequential(rows, async (row) => {
    try {
      if (await redriveOne(db, commandQueue, row)) queued += 1
    } catch (error) {
      compatLogWarn(
        'managed',
        `managed.destroy redrive failed for command ${row.id}: ${String(error)}`
      )
    }
  })
  return queued
}
