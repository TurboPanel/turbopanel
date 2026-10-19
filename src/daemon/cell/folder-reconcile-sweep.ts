/**
 * Keep the folder table honest between events.
 *
 * A host lists the asset folders it has on disk in the answer to every
 * `server.principals.reconcile`, and the panel compares that list with its
 * rows: a folder it expects but the host lacks becomes `missing`, one the host
 * has that no row names becomes an `orphan`. That only happens when something
 * triggers a reconcile, so a folder removed or added by hand on a server would
 * go unnoticed for weeks. This sweep asks each connected server that has
 * folder rows for a fresh reconcile when its last one is older than
 * {@link FOLDER_RECONCILE_INTERVAL_HOURS}.
 *
 * Runs from the Workers cron and the Deno maintenance timer, never from hello
 * or a Durable Object handler (those must not enqueue). It is a full-state
 * reconcile, the same command a key change sends, so a repeat changes nothing.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { enqueuePrincipalsReconcile } from '../../client/principals/reconcile.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'

/** A server is asked no sooner than this after its last principals reconcile. */
export const FOLDER_RECONCILE_INTERVAL_HOURS = 6

/** Servers one sweep tick asks at most. */
const FOLDER_RECONCILE_SWEEP_CAP = 25

export async function runFolderReconcileSweep(
  db: Db,
  queue: CommandQueue,
  params: Readonly<{ budget?: number }> = {}
): Promise<{ enqueued: number }> {
  if (isNoopCommandQueue(queue)) return { enqueued: 0 }
  const budget = Math.min(
    Math.max(1, params.budget ?? FOLDER_RECONCILE_SWEEP_CAP),
    FOLDER_RECONCILE_SWEEP_CAP
  )
  const candidates = await db.execute<{ server_id: string }>(sql`
    SELECT srv.id AS server_id
    FROM server srv
    WHERE srv.is_connected = true
      AND EXISTS (SELECT 1 FROM folder f WHERE f.server_id = srv.id)
      AND NOT EXISTS (
        SELECT 1
        FROM command cmd
        WHERE cmd.server_id = srv.id
          AND cmd.name = 'server.principals.reconcile'
          AND cmd.status <> 'failed'
          AND cmd.created_at >= GREATEST(
            COALESCE(srv.status_changed_at, '-infinity'::timestamptz),
            now() - make_interval(hours => ${FOLDER_RECONCILE_INTERVAL_HOURS})
          )
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `)
  let enqueued = 0
  await forEachSequential(candidates, async (row) => {
    const result = await enqueuePrincipalsReconcile(
      db,
      queue,
      { actorType: 'system', actorId: row.server_id },
      [row.server_id]
    )
    enqueued += result.queuedServerIds.length
  })
  return { enqueued }
}
