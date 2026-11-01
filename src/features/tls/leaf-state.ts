/**
 * Writes to the attention columns of `leaf` (`state`, `attempts`,
 * `last_error` and friends) that follow a deploy: a successful deploy makes
 * the leaf healthy again, a failed one keeps its reason. The row itself is
 * written by `leaf-tracking.ts`.
 */
import { and, eq, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { leaf } from '../../db/schema.ts'
import { parsePendingTlsLeafTracking, type UpsertTlsLeafTrackingParams } from './leaf-tracking.ts'
import { clipLeafText } from './leaf-vocabulary.ts'

/** The `leaf` row a pending deploy refers to: ingress and peer per server, engine per replica. */
function leafTarget(pending: UpsertTlsLeafTrackingParams): SQL | undefined {
  if (pending.kind === 'ingress' || pending.kind === 'peer') {
    return and(eq(leaf.kind, pending.kind), eq(leaf.serverId, pending.serverId))
  }
  if (!pending.replicaId) return undefined
  return and(eq(leaf.kind, 'engine'), eq(leaf.replicaId, pending.replicaId))
}

/**
 * A deployed leaf is healthy: drop any stale mark, the retry count and the
 * last failure. Called right after the row was upserted, so a leaf marked stale
 * (nothing used it, or its server was gone) comes back as soon as a later
 * deploy needs it again.
 */
export async function clearLeafAttentionAfterDeploy(db: Db, metadata: unknown): Promise<boolean> {
  const pending = parsePendingTlsLeafTracking(metadata)
  const target = pending ? leafTarget(pending) : undefined
  if (!target) return false
  await db
    .update(leaf)
    .set({
      state: 'active',
      staleAt: null,
      staleReason: null,
      staleCause: null,
      attempts: 0,
      attemptedAt: null,
      lastError: null,
    })
    .where(target)
  return true
}

/**
 * Remember why the renewal of a leaf failed: the failed command's pending leaf
 * names the row, and an owner reads the reason on the Organization CA card.
 * A leaf that was never deployed has no row yet, so nothing is written.
 */
export async function recordPendingTlsLeafFailure(
  db: Db,
  metadata: unknown,
  message: string
): Promise<boolean> {
  const pending = parsePendingTlsLeafTracking(metadata)
  const target = pending ? leafTarget(pending) : undefined
  if (!target) return false
  const lastError = clipLeafText(message.length > 0 ? message : 'The renewal did not finish.')
  await db.update(leaf).set({ lastError }).where(target)
  return true
}
