/**
 * Removing site owners (principals) whose project was deleted.
 *
 * A project delete marks the principals nothing else uses
 * (`removal_requested_at`, see `features/principals/removal.ts`). They cannot
 * go in the same step: their folders are still on the servers, and the host
 * refuses to remove an account whose home still holds them. The row stays as
 * the record of the account until every server has confirmed it gone:
 *
 * 1. Nothing happens while a folder row still names the principal (the host
 *    has not confirmed its folders gone). If something else starts using it
 *    meanwhile, the mark is cleared and the principal stays.
 * 2. On each server it is placed on, once that server is connected and has no
 *    `environment.stop` still running (the stop of the delete itself), the
 *    placement turns `retiring` and the server gets a `server.principals.
 *    reconcile` naming the login in `retirePrincipals`.
 * 3. The command consumer turns the placement `absent` for each login the
 *    host reports retired. A refused or lost retire leaves it `retiring`; the
 *    sweep asks that server again after {@link RETIRE_RETRY_MINUTES}, with a
 *    warning in the log each time.
 * 4. Once no placement is left that is not `absent`, the row is deleted.
 *
 * The project delete runs it once for its own principals; the maintenance
 * tick (Deno) and the cron (Workers) run {@link runPrincipalRemovalSweep} for
 * the rest. Never throws.
 */
import { and, asc, eq, inArray, isNotNull, ne, notExists, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, folder, principal, principalPlacement, server } from '../../db/schema.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { TERMINAL_COMMAND_STATUSES } from '../../features/commands/types.ts'
import {
  countPrincipalReferences,
  isPrincipalReferenced,
  type PrincipalReferences,
} from '../../features/principals/store.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { enqueuePrincipalsReconcile, serversForPrincipal } from './reconcile.ts'

/** Principals one sweep tick looks at, at most. */
const PRINCIPAL_REMOVAL_SWEEP_CAP = 50

/** A server is asked again about a retire it has not confirmed no sooner than this. */
export const RETIRE_RETRY_MINUTES = 15

export type UnusedPrincipalDelete =
  | { status: 'missing' }
  | { status: 'has_project' }
  | { status: 'in_use'; usedBy: PrincipalReferences }
  | { status: 'deleted'; serverIds: string[]; appliedUsername: string }

/**
 * Delete a principal row that nothing uses (the organization's own delete),
 * inside the caller's transaction with the row locked: a service or login
 * attached while this checks would otherwise be cascaded away with it, and
 * two parallel deletes would both queue the retire. Returns the servers to
 * retire the account on, resolved before the delete (the reach is found
 * through the placements).
 */
export async function deleteUnusedPrincipal(
  tx: Db,
  where: Readonly<{ principalId: string; organizationId: string }>
): Promise<UnusedPrincipalDelete> {
  const [row] = await tx
    .select({ projectId: principal.projectId, appliedUsername: principal.appliedUsername })
    .from(principal)
    .where(
      and(eq(principal.id, where.principalId), eq(principal.organizationId, where.organizationId))
    )
    .limit(1)
    .for('update')
  if (!row) return { status: 'missing' }
  if (row.projectId !== null) return { status: 'has_project' }

  const usedBy = await countPrincipalReferences(tx, where.principalId)
  if (isPrincipalReferenced(usedBy)) return { status: 'in_use', usedBy }

  const serverIds = await serversForPrincipal(tx, where.principalId)
  await tx.delete(principal).where(eq(principal.id, where.principalId))
  return { status: 'deleted', serverIds, appliedUsername: row.appliedUsername }
}

/**
 * `removed`: the row is gone. `retiring`: servers were asked to remove the
 * account. `waiting`: folders, an offline server, a running stop or a recent
 * ask hold it back. `kept`: something uses it again, or it is not marked.
 */
export type PrincipalRemovalResult = 'removed' | 'retiring' | 'waiting' | 'kept'

type PlacementRow = { serverId: string; state: string; updatedAt: string; connected: boolean }

/** Servers among `serverIds` with an `environment.stop` that has not finished. */
async function serversWithRunningStop(
  tx: Pick<Db, 'select'>,
  serverIds: readonly string[]
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await tx
    .select({ serverId: command.serverId })
    .from(command)
    .where(
      and(
        inArray(command.serverId, [...serverIds]),
        eq(command.name, 'environment.stop'),
        notInArray(command.status, [...TERMINAL_COMMAND_STATUSES])
      )
    )
  return new Set(rows.map((row) => row.serverId))
}

function askedRecently(row: PlacementRow, now: number): boolean {
  if (row.state !== 'retiring') return false
  return now - Date.parse(row.updatedAt) < RETIRE_RETRY_MINUTES * 60_000
}

/** The servers to ask now: connected, no stop still running, not asked in the last minutes. */
async function serversReadyToRetire(
  tx: Pick<Db, 'select'>,
  placements: readonly PlacementRow[]
): Promise<string[]> {
  const now = Date.now()
  const candidates = placements.filter((row) => row.connected && !askedRecently(row, now))
  const stopping = await serversWithRunningStop(
    tx,
    candidates.map((row) => row.serverId)
  )
  return candidates.filter((row) => !stopping.has(row.serverId)).map((row) => row.serverId)
}

type RemovalStep =
  | { result: 'removed' | 'waiting' | 'kept' }
  | { result: 'retiring'; serverIds: string[]; retried: string[]; appliedUsername: string }

/** One step for one principal, in a transaction with its row locked. */
async function removalStep(tx: Db, principalId: string): Promise<RemovalStep> {
  const [row] = await tx
    .select({ appliedUsername: principal.appliedUsername })
    .from(principal)
    .where(and(eq(principal.id, principalId), isNotNull(principal.removalRequestedAt)))
    .limit(1)
    .for('update')
  if (!row) return { result: 'kept' }

  const { folders, ...others } = await countPrincipalReferences(tx, principalId)
  if (isPrincipalReferenced({ ...others, folders: 0 })) {
    // In use again: it stays, and the mark goes.
    await tx
      .update(principal)
      .set({ removalRequestedAt: null })
      .where(eq(principal.id, principalId))
    return { result: 'kept' }
  }
  // Folders still being cleared: the home must not go before them.
  if (folders > 0) return { result: 'waiting' }

  const placements: PlacementRow[] = await tx
    .select({
      serverId: principalPlacement.serverId,
      state: principalPlacement.state,
      updatedAt: principalPlacement.updatedAt,
      connected: server.isConnected,
    })
    .from(principalPlacement)
    .innerJoin(server, eq(server.id, principalPlacement.serverId))
    .where(
      and(eq(principalPlacement.principalId, principalId), ne(principalPlacement.state, 'absent'))
    )
  if (placements.length === 0) {
    await tx.delete(principal).where(eq(principal.id, principalId))
    return { result: 'removed' }
  }

  const ready = await serversReadyToRetire(tx, placements)
  if (ready.length === 0) return { result: 'waiting' }
  const retried = placements
    .filter((entry) => entry.state === 'retiring' && ready.includes(entry.serverId))
    .map((entry) => entry.serverId)
  // `retiring` (and a fresh `updated_at`) before the ask: the reconcile then
  // leaves the account out of the managed set, and the retry clock starts.
  await tx
    .update(principalPlacement)
    .set({ state: 'retiring', updatedAt: sql`now()` })
    .where(
      and(
        eq(principalPlacement.principalId, principalId),
        inArray(principalPlacement.serverId, ready)
      )
    )
  return { result: 'retiring', serverIds: ready, retried, appliedUsername: row.appliedUsername }
}

/**
 * Take one requested removal one step further (see the module comment). The
 * ask goes out after the transaction commits; a server whose ask could not be
 * queued keeps its placement `retiring` and is asked again later.
 */
export async function removeRequestedPrincipal(
  db: Db,
  queue: CommandQueue | undefined,
  principalId: string
): Promise<PrincipalRemovalResult> {
  const step = await db.transaction((tx) => removalStep(tx, principalId))
  if (step.result !== 'retiring') return step.result
  for (const serverId of step.retried) {
    compatLogWarn(
      'principals',
      `server ${serverId} has not confirmed ${step.appliedUsername} removed; asking again`
    )
  }
  const outcome = await enqueuePrincipalsReconcile(
    db,
    queue,
    // No person behind the sweep: the principal is its own actor.
    { actorType: 'system', actorId: principalId },
    step.serverIds,
    { retirePrincipals: [step.appliedUsername] }
  )
  for (const serverId of outcome.failedServerIds) {
    compatLogWarn(
      'principals',
      `removal of ${step.appliedUsername} could not be sent to server ${serverId}; it is asked again in ${RETIRE_RETRY_MINUTES} minutes`
    )
  }
  return 'retiring'
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
 * Periodic pass over the principals whose removal was asked for and that no
 * folder row names any more. One still placed on an offline server, or asked
 * in the last {@link RETIRE_RETRY_MINUTES} minutes, is left out of the batch so
 * it cannot crowd out the others. Runs from the Workers cron and the Deno
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
  const offlineServers = db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.isConnected, false))
  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        isNotNull(principal.removalRequestedAt),
        notExists(
          db.select({ id: folder.id }).from(folder).where(eq(folder.principalId, principal.id))
        ),
        notExists(
          db
            .select({ id: principalPlacement.id })
            .from(principalPlacement)
            .where(
              and(
                eq(principalPlacement.principalId, principal.id),
                ne(principalPlacement.state, 'absent'),
                inArray(principalPlacement.serverId, offlineServers)
              )
            )
        ),
        notExists(
          db
            .select({ id: principalPlacement.id })
            .from(principalPlacement)
            .where(
              and(
                eq(principalPlacement.principalId, principal.id),
                eq(principalPlacement.state, 'retiring'),
                sql`${principalPlacement.updatedAt} > now() - make_interval(mins => ${RETIRE_RETRY_MINUTES})`
              )
            )
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
