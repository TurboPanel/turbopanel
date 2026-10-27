/**
 * Lifecycle of the Let's Encrypt certificate and key the panel stores.
 *
 * - {@link eraseStoredPairs}: the key is no longer needed (the row was revoked,
 *   or the organization turned Let's Encrypt off), so the sealed key, the
 *   chain and the issuing server are cleared in place. The row itself stays.
 * - {@link runStoredPairSweepTick}: an automatic Let's Encrypt row no site pins
 *   any more is stamped, kept for {@link STORED_PAIR_KEEP_DAYS} days (so adding
 *   the site back finds it), then deleted, which erases the key with it. An
 *   entry made for sites that never got a certificate holds nothing worth
 *   keeping, so it goes once it has been left alone for
 *   {@link EMPTY_ENTRY_GRACE_MS}. Entries a person added to the library are
 *   never swept; entries made before the `createdFor` marker keep the 30 days.
 *   Deleting a site removes its entry at once
 *   (`features/tls/unused-letsencrypt.ts`); the sweep picks up the rest, and
 *   deletes through the same locked path.
 */

import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting, tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  neverIssuedSiteCondition,
  notPinnedBySiteCondition,
  removeUnusedSiteCertificates,
  sweptLetsEncryptCondition,
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

  const emptyCutoff = new Date(now.getTime() - EMPTY_ENTRY_GRACE_MS).toISOString()
  const keepCutoff = new Date(now.getTime() - STORED_PAIR_KEEP_DAYS * DAY_MS).toISOString()
  const neverIssued = neverIssuedSiteCondition()
  const stamped = sql`coalesce(${tls.metadata}, '{}'::jsonb) ? 'unpinnedAt'`
  // Only the rows something is due for: an empty entry past its grace, a row
  // still to be stamped, or one whose keep ran out.
  const due = or(
    and(neverIssued, sql`${tls.updatedAt} < ${emptyCutoff}::timestamptz`),
    and(sql`not ${neverIssued}`, sql`not ${stamped}`),
    and(
      sql`not ${neverIssued}`,
      stamped,
      sql`(${tls.metadata} ->> 'unpinnedAt')::timestamptz < ${keepCutoff}::timestamptz`
    )
  )
  const loose = await db
    .select({
      id: tls.id,
      empty: sql<boolean>`${neverIssued}`,
      stamped: sql<boolean>`${stamped}`,
    })
    .from(tls)
    .where(and(sweptLetsEncryptCondition(), notPinnedBySiteCondition(), due))
    .orderBy(asc(tls.updatedAt), asc(tls.id))
    .limit(STORED_PAIR_SWEEP_BATCH)

  const toStamp = loose.filter((row) => row.empty !== true && row.stamped !== true)
  await forEachSequential(toStamp, async (row) => {
    // One statement that adds only the stamp to whatever the metadata holds
    // now, so a change made since the read above is not lost.
    const done = await db
      .update(tls)
      .set({
        metadata: sql`coalesce(${tls.metadata}, '{}'::jsonb) || jsonb_build_object('unpinnedAt', ${now.toISOString()}::text)`,
      })
      .where(and(eq(tls.id, row.id), sql`not ${stamped}`))
      .returning({ id: tls.id })
    result.stamped += done.length
  })

  // The locked path: organization lock, row locks, then the pin check, so a
  // deploy or the button reusing one of these rows keeps it.
  const toDelete = loose.filter((row) => row.empty === true || row.stamped === true)
  if (toDelete.length > 0) {
    const removed = await db.transaction((tx) =>
      removeUnusedSiteCertificates(
        tx,
        toDelete.map((row) => row.id),
        { reason: 'no hosting pins it any more', scope: 'swept' }
      )
    )
    result.deleted = removed.length
  }
  return result
}
