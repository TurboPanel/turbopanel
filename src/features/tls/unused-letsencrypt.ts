/**
 * Removing the Let's Encrypt certificate entries TurboPanel made for sites
 * once no site uses them any more.
 *
 * "Use Let's Encrypt" (the button, a compose route with `tls.mode: automatic`)
 * finds or creates one entry per hostname set in the organization's
 * certificate library, marks it `acme.createdFor: 'hosting'`, and pins the site
 * to it. When the last site pinned to such an entry goes (a project,
 * environment or site delete, a compose deploy that drops the route), the
 * entry goes with it in the same transaction, together with the stored copy of
 * the issued key it holds. An entry another site still pins stays. Only marked
 * entries are removed here: uploaded, self-signed and Organization CA entries,
 * Let's Encrypt entries a person added to the library, and entries made before
 * the marker existed (they cannot be told apart from hand-added ones) are left
 * to the stored certificate sweep's 30-day rule or to the person.
 *
 * Lock order, the same everywhere a site's certificate pin changes: the
 * environment row (or the project row, then its environment rows), then the
 * organization's Let's Encrypt lock ({@link lockOrganizationLetsEncrypt}),
 * then the site and certificate rows. A deploy's compose reconcile, the
 * "Use Let's Encrypt" button, the deletes and the sweep all follow it, so none
 * of them can wait on another in a cycle, and an entry is never deleted while
 * another transaction is about to pin it.
 *
 * A waiting DNS check lives on the site row (`hosting.pending_at`), so it
 * stops with the site; nothing else retries for the entry.
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting, tls } from '../../db/schema.ts'
import { type AuditEntry, recordAudit } from '../audit/audit-records.ts'
import { logWarn } from '../../lib/logger.ts'
import { forEachSequential } from '../../lib/sequential.ts'

/** `tls.metadata.acme.createdFor` on the entries a site's "Use Let's Encrypt" made. */
export const LETS_ENCRYPT_CREATED_FOR_SITES = 'hosting'

type LibraryRow = { source: string; status: string; metadata: unknown }

function createdForOf(metadata: unknown): unknown {
  const acme = (metadata as { acme?: unknown } | null)?.acme
  return (acme as { createdFor?: unknown } | null | undefined)?.createdFor
}

function isAutomaticLetsEncrypt(row: LibraryRow): boolean {
  return row.source === 'lets_encrypt' && row.status === 'automatic'
}

/** An automatic Let's Encrypt entry TurboPanel made for sites (it carries the marker). */
export function isSiteLetsEncrypt(row: LibraryRow): boolean {
  return (
    isAutomaticLetsEncrypt(row) && createdForOf(row.metadata) === LETS_ENCRYPT_CREATED_FOR_SITES
  )
}

/**
 * An entry the stored certificate sweep may delete once nothing pins it: one
 * made for sites, or one made before the marker existed (which keeps the
 * sweep's original 30-day rule). Entries a person added are never swept.
 */
export function isSweptLetsEncrypt(row: LibraryRow): boolean {
  if (!isAutomaticLetsEncrypt(row)) return false
  const createdFor = createdForOf(row.metadata)
  return (
    createdFor === undefined || createdFor === null || createdFor === LETS_ENCRYPT_CREATED_FOR_SITES
  )
}

const createdForColumn = sql`${tls.metadata} -> 'acme' ->> 'createdFor'`

/** {@link isSweptLetsEncrypt} as a query condition. */
export function sweptLetsEncryptCondition() {
  return and(
    eq(tls.source, 'lets_encrypt'),
    eq(tls.status, 'automatic'),
    or(
      sql`${createdForColumn} is null`,
      sql`${createdForColumn} = ${LETS_ENCRYPT_CREATED_FOR_SITES}`
    )
  )
}

/**
 * An entry made for sites that never got a certificate: no stored pair, and
 * the server never reported one in place. One whose pair was erased (Let's
 * Encrypt turned off, a revoke) had a certificate, so it is not this.
 */
export function neverIssuedSiteCondition() {
  return sql`coalesce(${createdForColumn} = ${LETS_ENCRYPT_CREATED_FOR_SITES} and ${tls.privateKeyPem} is null and ${tls.certificatePem} is null and ${tls.metadata} -> 'acme' ->> 'lastIssuedAt' is null, false)`
}

/** No site pins the row, as a query condition. */
export function notPinnedBySiteCondition() {
  return sql`not exists (select 1 from ${hosting} where ${hosting.tlsId} = ${tls.id})`
}

/**
 * The organization's Let's Encrypt lock, held until the transaction ends. The
 * find-or-create (`letsencrypt-store.ts`) takes it too, so a row found under it
 * is never deleted before the finder pins it.
 */
export async function lockOrganizationLetsEncrypt(tx: Db, organizationId: string): Promise<void> {
  const lockKey = 'tls-lets-encrypt:' + organizationId
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
}

/** {@link lockOrganizationLetsEncrypt} for several organizations, always in the same order. */
async function lockOrganizations(tx: Db, organizationIds: Iterable<string>): Promise<void> {
  const ordered = [...new Set(organizationIds)].sort((a, b) => a.localeCompare(b))
  await forEachSequential(ordered, (organizationId) =>
    lockOrganizationLetsEncrypt(tx, organizationId)
  )
}

/** The certificate rows these sites pin. */
export async function certificateIdsPinnedBy(
  db: Pick<Db, 'select'>,
  hostingIds: readonly string[]
): Promise<string[]> {
  if (hostingIds.length === 0) return []
  const rows = await db
    .select({ tlsId: hosting.tlsId })
    .from(hosting)
    .where(and(inArray(hosting.id, [...hostingIds]), isNotNull(hosting.tlsId)))
  return [...new Set(rows.flatMap((row) => (row.tlsId === null ? [] : [row.tlsId])))]
}

/**
 * Before sites are deleted: the certificate rows they pin, with the owning
 * organizations' Let's Encrypt locks taken, so the delete never waits on a
 * deploy while holding a site row that deploy needs. Call after the
 * environment (or project) row locks, before deleting the sites.
 */
export async function lockCertificatesPinnedBy(
  tx: Db,
  hostingIds: readonly string[]
): Promise<string[]> {
  const ids = await certificateIdsPinnedBy(tx, hostingIds)
  if (ids.length === 0) return ids
  const owners = await tx
    .select({ organizationId: tls.organizationId })
    .from(tls)
    .where(inArray(tls.id, ids))
  await lockOrganizations(
    tx,
    owners.map((row) => row.organizationId)
  )
  return ids
}

/** How many sites pin each of these rows, leaving out `exceptHostingIds`. */
async function countPinningSites(
  db: Pick<Db, 'select'>,
  tlsIds: readonly string[],
  exceptHostingIds: readonly string[] = []
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (tlsIds.length === 0) return counts
  const rows = await db
    .select({ id: hosting.id, tlsId: hosting.tlsId })
    .from(hosting)
    .where(inArray(hosting.tlsId, [...tlsIds]))
  const except = new Set(exceptHostingIds)
  for (const row of rows) {
    if (row.tlsId === null || except.has(row.id)) continue
    counts.set(row.tlsId, (counts.get(row.tlsId) ?? 0) + 1)
  }
  return counts
}

type CandidateRow = { id: string; organizationId: string; metadata: unknown }

function namesOf(metadata: unknown): string[] {
  const dnsNames = (metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(dnsNames)
    ? dnsNames.filter((name): name is string => typeof name === 'string')
    : []
}

/** Who removed the entries, for the audit trail; absent for the sweep. */
export type CertificateRemovalActor = { userId: string; email?: string | null }

export type CertificateRemoval = {
  /** Why, in a few plain words, for the audit trail. */
  reason: string
  actor?: CertificateRemovalActor
  /** `site` (the default): marked entries only. `swept`: also entries made before the marker. */
  scope?: 'site' | 'swept'
}

/**
 * The audit rows for removed entries. In a savepoint, so a failed audit write
 * rolls back only itself and never undoes the delete it belongs to.
 */
async function recordRemovals(
  tx: Db,
  removed: readonly CandidateRow[],
  removal: CertificateRemoval
): Promise<void> {
  if (removed.length === 0) return
  const entries: AuditEntry[] = removed.map((row) => ({
    organizationId: row.organizationId,
    actorUserId: removal.actor?.userId ?? null,
    actorEmail: removal.actor?.email ?? null,
    action: 'tls.certificate.delete',
    targetType: 'tls',
    targetId: row.id,
    context: { reason: removal.reason, names: namesOf(row.metadata) },
  }))
  try {
    await tx.transaction(async (savepoint) => {
      await forEachSequential(entries, (entry) => recordAudit(savepoint, entry))
    })
  } catch (err) {
    logWarn(
      'audit',
      `failed to record tls.certificate.delete: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** The rows among `ids` the removal may delete, read with their organization. */
async function loadCandidates(
  db: Pick<Db, 'select'>,
  ids: readonly string[],
  scope: 'site' | 'swept',
  lock = false
): Promise<CandidateRow[]> {
  const query = db
    .select({
      id: tls.id,
      organizationId: tls.organizationId,
      source: tls.source,
      status: tls.status,
      metadata: tls.metadata,
    })
    .from(tls)
    .where(inArray(tls.id, [...ids]))
  const rows = lock ? await query.for('update') : await query
  const accept = scope === 'swept' ? isSweptLetsEncrypt : isSiteLetsEncrypt
  return rows.filter(accept)
}

/**
 * Remove the entries among `candidateIds` that no site pins any more (only
 * the ones {@link CertificateRemoval.scope} allows). Run inside the
 * transaction that removed or re-pinned the sites, after that write. Takes the
 * organization lock, then the row locks, then checks the pins, so a pin
 * written meanwhile either is seen here or waits for this transaction.
 * Returns the removed ids.
 */
export async function removeUnusedSiteCertificates(
  tx: Db,
  candidateIds: readonly string[],
  removal: CertificateRemoval
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const scope = removal.scope ?? 'site'
  const first = await loadCandidates(tx, [...new Set(candidateIds)], scope)
  if (first.length === 0) return []
  await lockOrganizations(
    tx,
    first.map((row) => row.organizationId)
  )
  // Read again under the row locks: the first read only told us which locks to take.
  const candidates = await loadCandidates(
    tx,
    first.map((row) => row.id),
    scope,
    true
  )
  const pinned = await countPinningSites(
    tx,
    candidates.map((row) => row.id)
  )
  const unused = candidates.filter((row) => !pinned.has(row.id))
  if (unused.length === 0) return []
  const removed = await tx
    .delete(tls)
    .where(
      inArray(
        tls.id,
        unused.map((row) => row.id)
      )
    )
    .returning({ id: tls.id })
  const removedIds = new Set(removed.map((row) => row.id))
  await recordRemovals(
    tx,
    unused.filter((row) => removedIds.has(row.id)),
    removal
  )
  return [...removedIds]
}

/** One entry in a delete plan: removed with the sites, or kept for the sites that still use it. */
export type SiteCertificateFate = {
  id: string
  names: string[]
  action: 'remove' | 'keep'
  /** For `keep`: how many other sites still use it. */
  otherSites?: number
}

/**
 * What a delete of these sites does to the Let's Encrypt entries TurboPanel
 * made for them: each is removed, or kept while another site still uses it.
 * Reads only.
 */
export async function planSiteCertificates(
  db: Pick<Db, 'select'>,
  hostingIds: readonly string[]
): Promise<SiteCertificateFate[]> {
  const pinnedIds = await certificateIdsPinnedBy(db, hostingIds)
  if (pinnedIds.length === 0) return []
  const rows = await loadCandidates(db, pinnedIds, 'site')
  const otherSites = await countPinningSites(
    db,
    rows.map((row) => row.id),
    hostingIds
  )
  return rows
    .map((row): SiteCertificateFate => {
      const names = namesOf(row.metadata)
      const count = otherSites.get(row.id) ?? 0
      return count > 0
        ? { id: row.id, names, action: 'keep', otherSites: count }
        : { id: row.id, names, action: 'remove' }
    })
    .sort((a, b) => (a.names[0] ?? '').localeCompare(b.names[0] ?? '') || a.id.localeCompare(b.id))
}
