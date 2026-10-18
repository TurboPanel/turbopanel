/**
 * Asking hosts to remove the folders of deleted assets.
 *
 * Deleting a volume (or a service) flips its folder rows to `removing` and the
 * rows keep their locks until the host says the folder is gone. This module is
 * the asking: one `server.folders.remove` per server naming that server's
 * `removing` rows, sent when the delete commits and again by
 * {@link runFolderRemovalSweep} for a server that was offline or whose answer
 * said a folder stayed. The answer is read in the command consumer
 * (`applyFolderRemovalReports`).
 *
 * Every enqueue here is best-effort and never throws: it runs after the write
 * that deleted the asset, and that write has succeeded. A server that misses
 * the command (offline, queue down) keeps its rows `removing`, which shows to
 * the person as "waiting for server X", and the sweep asks again once the
 * server is connected.
 */
import { and, eq, sql } from 'drizzle-orm'
import {
  FOLDERS_REMOVE_MAX,
  type FoldersRemoveCommandPayload,
  parseFoldersRemovePayload,
} from '../../contracts/commands/schemas.ts'
import type { Db } from '../../db/connection.ts'
import { folder, principal } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import type { CommandQueue } from '../commands/queue.ts'

export const FOLDERS_REMOVE_COMMAND = 'server.folders.remove'

/** Servers one sweep tick asks at most. */
const FOLDER_REMOVAL_SWEEP_CAP = 100

/** A server is asked again about a stuck folder no sooner than this. */
export const FOLDER_REMOVAL_RETRY_MINUTES = 15

export type FolderRemovalActor = {
  actorType: string
  actorId: string
}

export type FolderRemovalOutcome = {
  /** Servers a command was queued for. */
  queuedServerIds: string[]
  /** Servers whose command could not be built or queued; their rows stay `removing`. */
  failedServerIds: string[]
}

function canEnqueue(queue: CommandQueue | undefined): queue is CommandQueue {
  return queue !== undefined && !isNoopCommandQueue(queue)
}

/**
 * The folders one server is to remove: its `removing` rows, oldest first, at
 * most one command's worth. `null` when it has none. The asset id travels when
 * the row still has it; a deleted asset's row has lost it and the host finds it
 * from its own record of the folder.
 */
export async function buildFolderRemovalPayload(
  db: Pick<Db, 'select'>,
  serverId: string
): Promise<FoldersRemoveCommandPayload | null> {
  const rows = await db
    .select({
      kind: folder.kind,
      scope: folder.scope,
      slug: folder.slug,
      serviceId: folder.serviceId,
      storageId: folder.storageId,
      owner: principal.appliedUsername,
    })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .where(and(eq(folder.serverId, serverId), eq(folder.state, 'removing')))
    .orderBy(folder.createdAt, folder.id)
    .limit(FOLDERS_REMOVE_MAX)
  if (rows.length === 0) return null
  // The same parser the command carries runs here, so a payload the host would
  // refuse is never queued; a row whose names fail the folder rules (an old
  // row from before the rules) is left `removing` and logged, not sent.
  const folders: unknown[] = []
  for (const row of rows) {
    folders.push({
      kind: row.kind,
      ...(row.kind === 'service' && row.serviceId ? { assetId: row.serviceId } : {}),
      ...(row.kind === 'volume' && row.storageId ? { assetId: row.storageId } : {}),
      folder: { owner: row.owner, scope: row.scope, slug: row.slug },
    })
  }
  const valid: unknown[] = []
  for (const entry of folders) {
    try {
      parseFoldersRemovePayload({ folders: [entry] })
      valid.push(entry)
    } catch (err) {
      compatLogWarn(
        'folders',
        `server ${serverId}: a removing folder cannot be sent: ${String(err)}`
      )
    }
  }
  return valid.length === 0 ? null : parseFoldersRemovePayload({ folders: valid })
}

async function enqueueOne(
  db: Db,
  queue: CommandQueue,
  actor: FolderRemovalActor | null,
  serverId: string
): Promise<'queued' | 'nothing' | 'failed'> {
  const payload = await buildFolderRemovalPayload(db, serverId)
  if (payload === null) return 'nothing'
  const record = await createCommandRecord(db, {
    serverId,
    // With no person behind the request the server itself is the actor, as in the sweep.
    actorType: actor?.actorType ?? 'system',
    actorId: actor?.actorId ?? serverId,
    type: FOLDERS_REMOVE_COMMAND,
    payload,
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: FOLDERS_REMOVE_COMMAND,
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await queue.enqueue(envelope)
    return 'queued'
  } catch {
    // The row exists but nothing will pick it up; leaving it `queued` would
    // show a command that is permanently pending.
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Failed to enqueue folder removal',
    })
    return 'failed'
  }
}

/** Ask each server to remove its `removing` folders (each server once). Never throws. */
export async function enqueueFolderRemovals(
  db: Db,
  queue: CommandQueue | undefined,
  actor: FolderRemovalActor | null,
  serverIds: readonly string[]
): Promise<FolderRemovalOutcome> {
  const unique = [...new Set(serverIds)]
  const queued: string[] = []
  const failed: string[] = []
  if (!canEnqueue(queue)) {
    return { queuedServerIds: queued, failedServerIds: unique }
  }
  await forEachSequential(unique, async (serverId) => {
    try {
      const result = await enqueueOne(db, queue, actor, serverId)
      if (result === 'queued') queued.push(serverId)
      else if (result === 'failed') failed.push(serverId)
    } catch (err) {
      compatLogWarn('folders', `folder removal for server ${serverId} failed: ${String(err)}`)
      failed.push(serverId)
    }
  })
  return { queuedServerIds: queued, failedServerIds: failed }
}

/**
 * Periodic push: every connected server with a `removing` folder is asked, unless
 * it was asked in the last {@link FOLDER_REMOVAL_RETRY_MINUTES} minutes or since
 * it last (re)connected, whichever is later. This is what clears the rows of a
 * server that was offline when its volume was deleted, and retries a folder the
 * host said it could not remove.
 *
 * Runs from the Workers cron and the Deno maintenance timer, never from hello
 * or a Durable Object handler (those must not enqueue).
 */
export async function runFolderRemovalSweep(
  db: Db,
  queue: CommandQueue,
  params: Readonly<{ budget?: number }> = {}
): Promise<{ enqueued: number }> {
  if (!canEnqueue(queue)) return { enqueued: 0 }
  const budget = Math.min(
    Math.max(1, params.budget ?? FOLDER_REMOVAL_SWEEP_CAP),
    FOLDER_REMOVAL_SWEEP_CAP
  )
  const candidates = await db.execute<{ server_id: string }>(sql`
    SELECT DISTINCT srv.id AS server_id
    FROM server srv
    WHERE srv.is_connected = true
      AND EXISTS (
        SELECT 1 FROM folder f WHERE f.server_id = srv.id AND f.state = 'removing'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM command cmd
        WHERE cmd.server_id = srv.id
          AND cmd.name = ${FOLDERS_REMOVE_COMMAND}
          AND cmd.created_at >= GREATEST(
            COALESCE(srv.status_changed_at, '-infinity'::timestamptz),
            now() - make_interval(mins => ${FOLDER_REMOVAL_RETRY_MINUTES})
          )
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `)
  let enqueued = 0
  await forEachSequential(candidates, async (row) => {
    const result = await enqueueFolderRemovals(
      db,
      queue,
      {
        actorType: 'system',
        actorId: row.server_id,
      },
      [row.server_id]
    )
    enqueued += result.queuedServerIds.length
  })
  return { enqueued }
}

/**
 * After a delete commits: tell the servers whose folder rows it flipped to
 * `removing`. Called by the routes that delete a service, a volume or a volume
 * copy; a delete that reaches folders some other way (a project delete) is
 * picked up by {@link runFolderRemovalSweep}. Never throws.
 */
export async function sendFolderRemovalsAfterDelete(
  db: Db,
  queue: CommandQueue | undefined,
  userId: string | undefined,
  serverIds: readonly string[]
): Promise<void> {
  if (serverIds.length === 0) return
  await enqueueFolderRemovals(
    db,
    queue,
    {
      actorType: 'user',
      actorId: userId ?? 'unknown',
    },
    serverIds
  )
}
