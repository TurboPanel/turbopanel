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
 *    has not confirmed its folders gone). A service folder no service names
 *    (an `orphan` the host reported) would wait for an admin forever, so it is
 *    set to `removing` here, audited, and cleared from the host through the
 *    normal folder removal. A volume orphan may hold data and is never removed
 *    automatically: it keeps waiting for an admin, and carries a note saying
 *    it holds the account back. If something else starts using the principal
 *    meanwhile, the mark is cleared and the principal stays; folders already
 *    queued stay `removing` and are not adopted back (see the step).
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
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  ne,
  not,
  notExists,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, folder, principal, principalPlacement, server } from '../../db/schema.ts'
import { enqueueFolderRemovals } from '../../features/folders/removal.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { SecretsConfig } from '../../lib/secrets/secrets.ts'
import { TERMINAL_COMMAND_STATUSES } from '../../features/commands/types.ts'
import {
  countPrincipalReferences,
  isPrincipalReferenced,
  type PrincipalReferences,
} from '../../features/principals/store.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { principalDeleteAuditEntry } from './delete-audit.ts'
import { enqueuePrincipalsReconcile, serversForPrincipal } from './reconcile.ts'

/** Principals one sweep tick looks at, at most. */
const PRINCIPAL_REMOVAL_SWEEP_CAP = 50

/** A server is asked again about a retire it has not confirmed no sooner than this. */
export const RETIRE_RETRY_MINUTES = 15

export type UnusedPrincipalDelete =
  | { status: 'missing' }
  | { status: 'has_project' }
  | { status: 'in_use'; usedBy: PrincipalReferences }
  | { status: 'deleted'; serverIds: string[]; username: string; appliedUsername: string }

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
    .select({
      projectId: principal.projectId,
      username: principal.username,
      appliedUsername: principal.appliedUsername,
    })
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
  return {
    status: 'deleted',
    serverIds,
    username: row.username,
    appliedUsername: row.appliedUsername,
  }
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

/** What the activity log keeps about a row the sweep deleted. */
type RemovedPrincipal = {
  organizationId: string
  username: string
  appliedUsername: string
  serverIds: string[]
}

/** A service folder the host reported that no service names: safe to clear with the account. */
function isLeftoverServiceFolder(): SQL {
  return sql`(${folder.state} = 'orphan' AND ${folder.kind} = 'service' AND ${folder.serviceId} IS NULL AND ${folder.storageId} IS NULL)`
}

/** Why an orphan volume folder is flagged; shown in the folder list. */
const VOLUME_HOLDS_ACCOUNT_NOTE =
  "Keeps its project's deleted Hosting Account on the server until this folder is cleared from it."

/**
 * Orphan volume folders of principals marked for removal get a note saying why
 * the account stays (one principal, or all). Never removed automatically.
 */
async function noteBlockingVolumeFolders(
  tx: Pick<Db, 'update'>,
  principalId: string | null
): Promise<void> {
  await tx
    .update(folder)
    .set({ removalNote: VOLUME_HOLDS_ACCOUNT_NOTE })
    .where(
      and(
        principalId === null ? undefined : eq(folder.principalId, principalId),
        eq(folder.state, 'orphan'),
        eq(folder.kind, 'volume'),
        sql`${folder.removalNote} IS DISTINCT FROM ${VOLUME_HOLDS_ACCOUNT_NOTE}`,
        sql`${folder.principalId} IN (SELECT id FROM principal WHERE removal_requested_at IS NOT NULL)`
      )
    )
}

type ClearedFolder = {
  id: string
  serverId: string
  kind: string
  scope: string
  slug: string
}

type RemovalStep =
  | { result: 'kept' }
  | { result: 'waiting'; organizationId?: string; cleared?: ClearedFolder[] }
  | { result: 'removed'; removed: RemovedPrincipal }
  | { result: 'retiring'; serverIds: string[]; retried: string[]; appliedUsername: string }

/** One step for one principal, in a transaction with its row locked. */
async function removalStep(tx: Db, principalId: string): Promise<RemovalStep> {
  const [row] = await tx
    .select({
      organizationId: principal.organizationId,
      username: principal.username,
      appliedUsername: principal.appliedUsername,
    })
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
    // A service folder this step queued stays `removing`: its removal may be
    // under way on the host, so it is never adopted back. A deploy of the reused
    // account that wants the same folder name meets `directory_name_taken`
    // until the host confirms the folder gone.
    await tx
      .update(folder)
      .set({ removalNote: null })
      .where(
        and(
          eq(folder.principalId, principalId),
          eq(folder.state, 'orphan'),
          eq(folder.removalNote, VOLUME_HOLDS_ACCOUNT_NOTE)
        )
      )
    return { result: 'kept' }
  }
  // Folders still being cleared: the home must not go before them. Service
  // orphans no asset names would never clear on their own: queue them for
  // removal too. Volume orphans stay for an admin, with a note.
  if (folders > 0) {
    const cleared = await tx
      .update(folder)
      .set({ state: 'removing', removalNote: null })
      .where(and(eq(folder.principalId, principalId), isLeftoverServiceFolder()))
      .returning({
        id: folder.id,
        serverId: folder.serverId,
        kind: folder.kind,
        scope: folder.scope,
        slug: folder.slug,
      })
    await noteBlockingVolumeFolders(tx, principalId)
    return { result: 'waiting', organizationId: row.organizationId, cleared }
  }

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
    // Every placement left is `absent`: the servers it was retired on.
    const retiredOn = await tx
      .select({ serverId: principalPlacement.serverId })
      .from(principalPlacement)
      .where(eq(principalPlacement.principalId, principalId))
    await tx.delete(principal).where(eq(principal.id, principalId))
    const serverIds = retiredOn.map((entry) => entry.serverId)
    return { result: 'removed', removed: { ...row, serverIds } }
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

/** The person whose own delete removes the principal; the audit entry names them. */
export type PrincipalRemovalActor = Readonly<{ userId: string; email: string | null }>

/** After the commit: audit each service folder cleared with the account, and ask the servers to remove them. */
async function sendClearedFolders(
  db: Db,
  queue: CommandQueue | undefined,
  principalId: string,
  step: Extract<RemovalStep, { result: 'waiting' }>
): Promise<void> {
  const { organizationId, cleared } = step
  if (!organizationId || !cleared || cleared.length === 0) return
  await forEachSequential(cleared, async (entry) => {
    await recordAudit(db, {
      organizationId,
      actorUserId: null,
      actorEmail: null,
      action: 'folder.remove',
      targetType: 'organization',
      targetId: organizationId,
      context: {
        folderId: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        slug: entry.slug,
        serverId: entry.serverId,
        outcome: 'removing',
        reason: 'hosting_account_removal',
        principalId,
      },
    })
  })
  await enqueueFolderRemovals(db, queue, { actorType: 'system', actorId: principalId }, [
    ...new Set(cleared.map((entry) => entry.serverId)),
  ])
}

/**
 * Take one requested removal one step further (see the module comment). The
 * ask goes out after the transaction commits; a server whose ask could not be
 * queued keeps its placement `retiring` and is asked again later. `actor` is
 * the person when their own delete gets this far; the sweep passes none, and
 * its audit entry has a null actor.
 */
export async function removeRequestedPrincipal(
  db: Db,
  queue: CommandQueue | undefined,
  secretsConfig: SecretsConfig | undefined,
  principalId: string,
  actor: PrincipalRemovalActor | null = null
): Promise<PrincipalRemovalResult> {
  const step = await db.transaction((tx) => removalStep(tx, principalId))
  if (step.result === 'removed') {
    // After the commit, so a failed audit write never rolls the delete back.
    const { organizationId, ...account } = step.removed
    await recordAudit(
      db,
      principalDeleteAuditEntry(
        {
          organizationId,
          actorUserId: actor?.userId ?? null,
          actorEmail: actor?.email ?? null,
        },
        principalId,
        account
      )
    )
    return 'removed'
  }
  if (step.result === 'waiting') {
    await sendClearedFolders(db, queue, principalId, step)
    return 'waiting'
  }
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
    secretsConfig,
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

/**
 * Try each of these principals once (the project delete, for its own, passes
 * the person as `actor`; the sweep passes none). Never throws.
 */
export async function removeRequestedPrincipals(
  db: Db,
  queue: CommandQueue | undefined,
  secretsConfig: SecretsConfig | undefined,
  principalIds: readonly string[],
  actor: PrincipalRemovalActor | null = null
): Promise<{ removed: number }> {
  let removed = 0
  await forEachSequential(principalIds, async (principalId) => {
    try {
      const result = await removeRequestedPrincipal(db, queue, secretsConfig, principalId, actor)
      if (result === 'removed') removed += 1
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
  secretsConfig: SecretsConfig | undefined,
  params: Readonly<{ budget?: number }> = {}
): Promise<{ removed: number }> {
  if (isNoopCommandQueue(queue)) return { removed: 0 }
  const budget = Math.min(
    Math.max(1, params.budget ?? PRINCIPAL_REMOVAL_SWEEP_CAP),
    PRINCIPAL_REMOVAL_SWEEP_CAP
  )
  try {
    await noteBlockingVolumeFolders(db, null)
  } catch (err) {
    // The note is a courtesy: the removal pass below runs without it.
    compatLogWarn('principals', `noting folders that hold back an account failed: ${String(err)}`)
  }
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
        // Leftover service folders do not hold the principal back: the step
        // queues them. Anything else a folder row says (a volume orphan
        // included) is waited for.
        notExists(
          db
            .select({ id: folder.id })
            .from(folder)
            .where(and(eq(folder.principalId, principal.id), not(isLeftoverServiceFolder())))
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
    secretsConfig,
    rows.map((row) => row.id)
  )
}
