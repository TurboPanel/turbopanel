import { lt, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { nonce } from '../../db/schema.ts'

/** What a used value protected. Pinned to `nonce_kind_check` by `enum-checks.test.ts`. */
export const NONCE_KINDS = ['challenge', 'request'] as const
export type NonceKind = (typeof NONCE_KINDS)[number]

/** Rows deleted per sweep pass; the sweep runs every minute. */
export const NONCE_PRUNE_LIMIT = 5_000

async function markUsed(db: Db, value: string, kind: NonceKind, expiresAt: Date): Promise<boolean> {
  const rows = await db
    .insert(nonce)
    .values({ value, kind, expiresAt: expiresAt.toISOString() })
    .onConflictDoNothing({ target: nonce.value })
    .returning({ value: nonce.value })
  return rows.length > 0
}

/**
 * Record a sign-in challenge as used. False when it was used before: the
 * caller answers as for an expired challenge. One insert per sign-in.
 */
export function markChallengeUsed(
  db: Db,
  challengeNonce: string,
  expiresAt: Date
): Promise<boolean> {
  return markUsed(db, `challenge:${challengeNonce}`, 'challenge', expiresAt)
}

/** Delete rows whose window has passed, at most {@link NONCE_PRUNE_LIMIT} per call. */
export async function pruneExpiredNonces(db: Db, now: Date = new Date()): Promise<number> {
  const expired = db
    .select({ value: nonce.value })
    .from(nonce)
    .where(lt(nonce.expiresAt, now.toISOString()))
    .limit(NONCE_PRUNE_LIMIT)
  const rows = await db
    .delete(nonce)
    .where(sql`${nonce.value} IN (${expired})`)
    .returning({ value: nonce.value })
  return rows.length
}

/**
 * Record a signed daemon request's nonce as used, kept until the request's
 * signing window has passed. False when it was used before: a replayed request.
 */
export function markRequestNonceUsed(
  db: Db,
  serverId: string,
  requestNonce: string,
  expiresAt: Date
): Promise<boolean> {
  return markUsed(db, `request:${serverId}:${requestNonce}`, 'request', expiresAt)
}
