/**
 * Removing site owners (principals) whose project was deleted.
 *
 * A project delete marks the principals nothing else uses
 * (`removal_requested_at`, see `features/principals/removal.ts`). They cannot
 * go in the same step: their folders are still on the servers, and the host
 * refuses to remove an account whose home still holds them. This module
 * finishes the job the way the organization's own principal delete does
 * ({@link deleteUnusedPrincipal}, then {@link retireDeletedPrincipal}), once
 *
 * - no folder row names the principal (every host confirmed its folders gone),
 * - nothing else started using it meanwhile (if something did, the mark is
 *   cleared and the principal stays), and
 * - every server it is on is connected (a retire sent to an offline server
 *   fails at once, and after the row is gone nothing would ever ask again).
 *
 * The project delete runs it once for its own principals; the maintenance
 * tick (Deno) and the cron (Workers) run {@link runPrincipalRemovalSweep} for
 * the rest. Never throws.
 */
import { and, asc, eq, inArray, isNotNull, notExists } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { folder, principal, server } from '../../db/schema.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  countPrincipalReferences,
  isPrincipalReferenced,
  type PrincipalReferences,
} from '../../features/principals/store.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { retireDeletedPrincipal, serversForPrincipal } from './reconcile.ts'

/** Principals one sweep tick removes at most. */
const PRINCIPAL_REMOVAL_SWEEP_CAP = 50

export type UnusedPrincipalDelete =
  | { status: 'missing' }
  | { status: 'has_project' }
  | { status: 'in_use'; usedBy: PrincipalReferences }
  | { status: 'waiting'; offlineServerIds: string[] }
  | { status: 'deleted'; serverIds: string[]; appliedUsername: string }

/**
 * Delete a principal row that nothing uses, inside the caller's transaction
 * with the row locked: a service or login attached while this checks would
 * otherwise be cascaded away with it, and two parallel deletes would both
 * queue the retire. Returns the servers to retire the account on, resolved
 * before the delete (the reach is found through the placements). With
 * `requireConnected`, a principal on a server that is not connected stays.
 */
export async function deleteUnusedPrincipal(
  tx: Db,
  where: Readonly<{
    principalId: string
    organizationId?: string
    /** Only a principal whose removal was asked for (the sweep). */
    removalRequested?: boolean
    requireConnected?: boolean
  }>
): Promise<UnusedPrincipalDelete> {
  const [row] = await tx
    .select({
      projectId: principal.projectId,
      appliedUsername: principal.appliedUsername,
    })
    .from(principal)
    .where(
      and(
        eq(principal.id, where.principalId),
        where.organizationId ? eq(principal.organizationId, where.organizationId) : undefined,
        where.removalRequested ? isNotNull(principal.removalRequestedAt) : undefined
      )
    )
    .limit(1)
    .for('update')
  if (!row) return { status: 'missing' }
  if (row.projectId !== null) return { status: 'has_project' }

  const usedBy = await countPrincipalReferences(tx, where.principalId)
  if (isPrincipalReferenced(usedBy)) return { status: 'in_use', usedBy }

  const serverIds = await serversForPrincipal(tx, where.principalId)
  if (where.requireConnected && serverIds.length > 0) {
    const connected = await tx
      .select({ id: server.id })
      .from(server)
      .where(and(inArray(server.id, serverIds), eq(server.isConnected, true)))
    const online = new Set(connected.map((entry) => entry.id))
    const offlineServerIds = serverIds.filter((id) => !online.has(id))
    if (offlineServerIds.length > 0) return { status: 'waiting', offlineServerIds }
  }
  await tx.delete(principal).where(eq(principal.id, where.principalId))
  return { status: 'deleted', serverIds, appliedUsername: row.appliedUsername }
}

export type PrincipalRemovalResult = 'removed' | 'waiting' | 'kept'

/**
 * Finish one requested removal now if it can be finished: delete the row and
 * retire the account on its servers. A principal still named by a folder, or
 * on a server that is offline, waits for the next tick; one that something
 * else uses again keeps its row and loses the mark.
 */
export async function removeRequestedPrincipal(
  db: Db,
  queue: CommandQueue | undefined,
  principalId: string
): Promise<PrincipalRemovalResult> {
  const outcome = await db.transaction(async (tx) => {
    const result = await deleteUnusedPrincipal(tx, {
      principalId,
      removalRequested: true,
      requireConnected: true,
    })
    if (result.status === 'in_use') {
      const { folders, ...others } = result.usedBy
      // Folders still being cleared are what the removal waits for. Anything
      // else means the principal is in use again: it stays, and the mark goes.
      if (folders > 0 && !isPrincipalReferenced({ ...others, folders: 0 })) {
        return { status: 'waiting' as const, offlineServerIds: [] }
      }
      await tx
        .update(principal)
        .set({ removalRequestedAt: null })
        .where(eq(principal.id, principalId))
    }
    return result
  })
  if (outcome.status === 'waiting') return 'waiting'
  if (outcome.status !== 'deleted') return 'kept'
  await retireDeletedPrincipal(
    db,
    queue,
    // No person behind the sweep: the principal is its own actor.
    { actorType: 'system', actorId: principalId },
    { serverIds: outcome.serverIds, appliedUsername: outcome.appliedUsername }
  )
  return 'removed'
}

/** Try each of these principals once (the project delete, for its own). Never throws. */
export async function removeRequestedPrincipals(
  db: Db,
  queue: CommandQueue | undefined,
  principalIds: readonly string[]
): Promise<{ removed: number }> {
  let removed = 0
  await forEachSequential(principalIds, async (principalId) => {
    try {
      if ((await removeRequestedPrincipal(db, queue, principalId)) === 'removed') removed += 1
    } catch (err) {
      compatLogWarn('principals', `removal of principal ${principalId} failed: ${String(err)}`)
    }
  })
  return { removed }
}

/**
 * Periodic pass: every principal whose removal was asked for and that no
 * folder row names any more. Runs from the Workers cron and the Deno
 * maintenance timer, never from hello or a Durable Object handler (those must
 * not enqueue).
 */
export async function runPrincipalRemovalSweep(
  db: Db,
  queue: CommandQueue,
  params: Readonly<{ budget?: number }> = {}
): Promise<{ removed: number }> {
  if (isNoopCommandQueue(queue)) return { removed: 0 }
  const budget = Math.min(
    Math.max(1, params.budget ?? PRINCIPAL_REMOVAL_SWEEP_CAP),
    PRINCIPAL_REMOVAL_SWEEP_CAP
  )
  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        isNotNull(principal.removalRequestedAt),
        notExists(
          db.select({ id: folder.id }).from(folder).where(eq(folder.principalId, principal.id))
        )
      )
    )
    .orderBy(asc(principal.removalRequestedAt), asc(principal.id))
    .limit(budget)
  return await removeRequestedPrincipals(
    db,
    queue,
    rows.map((row) => row.id)
  )
}
