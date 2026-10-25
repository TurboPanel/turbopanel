/**
 * The primary epoch of a managed cluster: a counter that goes up by one every
 * time the primary role moves to another member (a promote, a failover). It
 * lives in the managed row's metadata (`primaryEpoch`, absent = 0), so it
 * needs no table change, and it is bumped in the same statement that records
 * the new primary.
 *
 * A planned switchover stamps the epoch on its fence stop and on the forced
 * re-seed that follows. The re-seed is only valid while the epoch is exactly
 * one past the epoch the fence stop saw: any other primary change in between
 * (a failover, a second switchover) makes the wipe stale, on the panel before
 * it is sent and on the host before it touches the data directory.
 */

import { eq, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { managed } from '../../db/schema.ts'

/** The epoch in a managed row's metadata; anything unreadable counts as 0. */
export function readPrimaryEpoch(metadata: unknown): number {
  if (typeof metadata !== 'object' || metadata === null) return 0
  const value = (metadata as Record<string, unknown>).primaryEpoch
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * New `metadata` value for the managed row with the epoch one higher. Used
 * inside the update that records the new primary.
 */
export function bumpedPrimaryEpochMetadata(): SQL {
  return sql`jsonb_set(coalesce(${managed.metadata}, '{}'::jsonb), '{primaryEpoch}', to_jsonb(case when (${managed.metadata}->>'primaryEpoch') ~ '^[0-9]{1,9}$' then (${managed.metadata}->>'primaryEpoch')::int + 1 else 1 end))`
}

/**
 * New `metadata` value for a rewrite of the managed row's metadata: `next`
 * (which must not carry `primaryEpoch`) plus the epoch the row holds right now,
 * so a rewrite built from an earlier read can never move the epoch backwards.
 */
export function keepLivePrimaryEpoch(next: Record<string, unknown>): SQL {
  return sql`${JSON.stringify(next)}::jsonb || case when (${managed.metadata}->'primaryEpoch') is null then '{}'::jsonb else jsonb_build_object('primaryEpoch', ${managed.metadata}->'primaryEpoch') end`
}

export async function loadPrimaryEpoch(db: Db, managedId: string): Promise<number> {
  const [row] = await db
    .select({ metadata: managed.metadata })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return readPrimaryEpoch(row?.metadata)
}
