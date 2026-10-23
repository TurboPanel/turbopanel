/**
 * Lifecycle of the Let's Encrypt certificate and key the panel stores.
 *
 * - {@link eraseStoredPairs}: the key is no longer needed (the row was revoked,
 *   or the organization turned Let's Encrypt off), so the sealed key, the
 *   chain and the issuing server are cleared in place. The row itself stays.
 * - {@link runStoredPairSweepTick}: a managed row that no hosting pins any
 *   more is kept for {@link STORED_PAIR_KEEP_DAYS} days (so adding the site
 *   back finds it), then deleted, which erases the key with it.
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting, tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export const STORED_PAIR_KEEP_DAYS = 30
/** Rows looked at per tick; the rest wait for the next one. */
export const STORED_PAIR_SWEEP_BATCH = 50

const DAY_MS = 86_400_000

/** Clear the stored pair on the organization's Let's Encrypt rows (all, or only `ids`). */
export async function eraseStoredPairs(
  db: Db,
  organizationId: string,
  options: { ids?: string[]; now?: () => Date } = {}
): Promise<string[]> {
  if (options.ids?.length === 0) return []
  const now = (options.now ?? (() => new Date()))()
  const scope = and(
    eq(tls.organizationId, organizationId),
    eq(tls.source, 'lets_encrypt'),
    or(isNotNull(tls.privateKeyPem), isNotNull(tls.certificatePem)),
    ...(options.ids ? [inArray(tls.id, options.ids)] : [])
  )
  const erased = await db
    .update(tls)
    .set({
      privateKeyPem: null,
      certificatePem: null,
      issuedByServerId: null,
      // Back to the managed row's placeholders: no stored pair, so no stored
      // expiry or fingerprint either.
      notAfter: new Date(0).toISOString(),
      fingerprintSha256: null,
      metadata: sql`jsonb_set(coalesce(${tls.metadata}, '{}'::jsonb), '{acme}', (coalesce(${tls.metadata} -> 'acme', '{}'::jsonb) - 'storedNames' - 'issuedByServerId'))`,
      updatedAt: now.toISOString(),
    })
    .where(scope)
    .returning({ id: tls.id })
  await forEachSequential(erased, (row) =>
    recordAudit(db, {
      organizationId,
      action: 'tls.certificate.key_erase',
      targetType: 'tls',
      targetId: row.id,
    })
  )
  return erased.map((row) => row.id)
}

export type StoredPairSweepResult = {
  stamped: number
  cleared: number
  deleted: number
}

export async function runStoredPairSweepTick(
  db: Db,
  deps: { now?: () => Date } = {}
): Promise<StoredPairSweepResult> {
  const now = (deps.now ?? (() => new Date()))()
  const result: StoredPairSweepResult = { stamped: 0, cleared: 0, deleted: 0 }
  const pinned = sql`exists (select 1 from ${hosting} where ${hosting.tlsId} = ${tls.id})`

  // A row some hosting pins again is no longer on the way out.
  const back = await db
    .update(tls)
    .set({ metadata: sql`${tls.metadata} - 'unpinnedAt'` })
    .where(and(eq(tls.source, 'lets_encrypt'), sql`${tls.metadata} ? 'unpinnedAt'`, pinned))
    .returning({ id: tls.id })
  result.cleared = back.length

  const loose = await db
    .select({
      id: tls.id,
      organizationId: tls.organizationId,
      metadata: tls.metadata,
    })
    .from(tls)
    .where(and(eq(tls.source, 'lets_encrypt'), eq(tls.status, 'automatic'), sql`not ${pinned}`))
    .limit(STORED_PAIR_SWEEP_BATCH)

  await forEachSequential(loose, async (row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const since =
      typeof metadata.unpinnedAt === 'string' ? Date.parse(metadata.unpinnedAt) : Number.NaN
    if (!Number.isFinite(since)) {
      // One statement that adds only the stamp to whatever the metadata holds
      // now, so a change made since the read above is not lost.
      const stamped = await db
        .update(tls)
        .set({
          metadata: sql`coalesce(${tls.metadata}, '{}'::jsonb) || jsonb_build_object('unpinnedAt', ${now.toISOString()}::text)`,
        })
        .where(
          and(eq(tls.id, row.id), sql`not (coalesce(${tls.metadata}, '{}'::jsonb) ? 'unpinnedAt')`)
        )
        .returning({ id: tls.id })
      result.stamped += stamped.length
      return
    }
    if (now.getTime() - since < STORED_PAIR_KEEP_DAYS * DAY_MS) return
    // Re-check inside the delete: a hosting may have pinned the row meanwhile.
    const gone = await db
      .delete(tls)
      .where(and(eq(tls.id, row.id), sql`not ${pinned}`))
      .returning({ id: tls.id })
    if (gone.length === 0) return
    result.deleted += 1
    await recordAudit(db, {
      organizationId: row.organizationId,
      action: 'tls.certificate.delete',
      targetType: 'tls',
      targetId: row.id,
      context: { reason: 'no hosting pins it any more' },
    })
  })
  return result
}
