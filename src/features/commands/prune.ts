/**
 * Bounded retention prune for the append-only `command` table.
 *
 * Every deploy, reconcile, ping and firewall preview leaves a row forever, and
 * the per-minute reconcile sweeps read a server's history. This removes only
 * rows that nothing can still be waiting on, oldest first, one capped batch per
 * call (same shape as `features/upgrades/prune.ts`).
 *
 * A row is deleted only when ALL of these hold:
 * - it is terminal (`succeeded`, `failed`, `timed_out`, `cancelled`) and both
 *   `created_at` and `updated_at` are older than the retention window;
 * - it is not an `environment.deploy` (deploy history is read from this table);
 * - it carries no managed-destroy gate id (the gate still reads its members);
 * - no `dispatch` row and no `deployment.last_command_id` points at it;
 * - it is not the newest row for its `(server_id, name)`: the reconcile sweeps
 *   treat "a `<x>.reconcile` command exists for this server" as "this server
 *   was ever sent a set", so the latest one of each name always stays.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'

/** Terminal commands younger than this are kept. Deliberately conservative. */
export const COMMAND_RETENTION_DAYS = 180

/** Rows removed per call (the cron runs the prune every 15 minutes). */
export const COMMAND_PRUNE_BATCH_LIMIT = 500

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type PruneCommandHistoryOpts = {
  limit?: number
  now?: string
  retentionDays?: number
}

/**
 * Delete up to `limit` aged terminal commands; returns how many went.
 * Never throws for an empty table; a database error propagates to the caller
 * (the cron wrapper traces it).
 */
export async function pruneCommandHistory(
  db: Db,
  opts: PruneCommandHistoryOpts = {}
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? COMMAND_PRUNE_BATCH_LIMIT), 1), 1000)
  const days = Math.max(opts.retentionDays ?? COMMAND_RETENTION_DAYS, 30)
  const now = opts.now ?? new Date().toISOString()
  const cutoff = new Date(Date.parse(now) - days * MS_PER_DAY).toISOString()

  const deleted = await db
    .delete(command)
    .where(
      sql`${command.id} in (
        select c.id from ${command} c
        where c.status in ('succeeded', 'failed', 'timed_out', 'cancelled')
          and c.created_at < ${cutoff}::timestamptz
          and c.updated_at < ${cutoff}::timestamptz
          and c.name <> 'environment.deploy'
          and c.managed_destroy_gate_id is null
          and not exists (select 1 from dispatch d where d.command_id = c.id)
          and c.id not in (
            select last_command_id from deployment where last_command_id is not null
          )
          and exists (
            select 1 from ${command} newer
            where newer.server_id = c.server_id
              and newer.name = c.name
              and newer.created_at > c.created_at
          )
        order by c.created_at
        limit ${limit}
      )`
    )
    .returning({ id: command.id })
  return deleted.length
}
