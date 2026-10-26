/**
 * Lifecycle of the Let's Encrypt certificate and key the panel stores.
 *
 * - {@link eraseStoredPairs}: the key is no longer needed (the row was revoked,
 *   or the organization turned Let's Encrypt off), so the sealed key, the
 *   chain and the issuing server are cleared in place. The row itself stays.
 * - {@link runStoredPairSweepTick}: a row TurboPanel made for sites that no
 *   site pins any more is kept for {@link STORED_PAIR_KEEP_DAYS} days when it
 *   holds an issued pair (so adding the site back finds it), then deleted,
 *   which erases the key with it. One that holds nothing (never issued) is
 *   deleted once it has been left alone for {@link EMPTY_ENTRY_GRACE_MS}.
 *   Deleting a site removes its entry at once
 *   (`features/tls/unused-letsencrypt.ts`); the sweep picks up the rest.
 *   Entries a person added to the library are never swept.
 */

import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting, tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  notPinnedBySiteCondition,
  siteLetsEncryptCondition,
} from '../../features/tls/unused-letsencrypt.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export const STORED_PAIR_KEEP_DAYS = 30
/** Rows looked at per tick; the rest wait for the next one. */
export const STORED_PAIR_SWEEP_BATCH = 50
/**
 * How long an unused entry with no issued pair stays untouched before the
 * sweep deletes it: long enough that one just made for a site is pinned first.
 */
export const EMPTY_ENTRY_GRACE_MS = 3_600_000

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
      updatedAt: tls.updatedAt,
      // Only whether a pair is stored; the sealed value is never read here.
      holdsPair: sql<boolean>`(${tls.privateKeyPem} is not null or ${tls.certificatePem} is not null)`,
    })
    .from(tls)
    .where(and(siteLetsEncryptCondition(), notPinnedBySiteCondition()))
    // Oldest first: a stamp moves `updated_at`, so the rows still waiting out
    // their keep do not hold the batch from the rest.
    .orderBy(asc(tls.updatedAt), asc(tls.id))
    .limit(STORED_PAIR_SWEEP_BATCH)

  await forEachSequential(loose, async (row) => {
    const outcome = await sweepLooseRow(db, row, now)
    if (outcome === 'stamped') result.stamped += 1
    if (outcome === 'deleted') result.deleted += 1
  })
  return result
}

type LooseRow = {
  id: string
  organizationId: string
  metadata: unknown
  updatedAt: string
  holdsPair: boolean
}

/** Whether a row nothing pins is due for deletion now, or needs its stamp first. */
function looseRowDue(row: LooseRow, now: Date): 'stamp' | 'wait' | 'delete' {
  if (row.holdsPair !== true) {
    return now.getTime() - Date.parse(row.updatedAt) >= EMPTY_ENTRY_GRACE_MS ? 'delete' : 'wait'
  }
  const metadata = (row.metadata ?? {}) as Record<string, unknown>
  const since =
    typeof metadata.unpinnedAt === 'string' ? Date.parse(metadata.unpinnedAt) : Number.NaN
  if (!Number.isFinite(since)) return 'stamp'
  return now.getTime() - since < STORED_PAIR_KEEP_DAYS * DAY_MS ? 'wait' : 'delete'
}

async function sweepLooseRow(
  db: Db,
  row: LooseRow,
  now: Date
): Promise<'stamped' | 'deleted' | 'none'> {
  const due = looseRowDue(row, now)
  if (due === 'wait') return 'none'
  if (due === 'stamp') {
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
    return stamped.length > 0 ? 'stamped' : 'none'
  }
  // Re-check inside the delete: a site may have pinned the row meanwhile.
  const gone = await db
    .delete(tls)
    .where(and(eq(tls.id, row.id), notPinnedBySiteCondition()))
    .returning({ id: tls.id })
  if (gone.length === 0) return 'none'
  await recordAudit(db, {
    organizationId: row.organizationId,
    action: 'tls.certificate.delete',
    targetType: 'tls',
    targetId: row.id,
    context: { reason: 'no hosting pins it any more' },
  })
  return 'deleted'
}
