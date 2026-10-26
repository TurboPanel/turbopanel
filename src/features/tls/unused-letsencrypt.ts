/**
 * Removing the Let's Encrypt certificate entries TurboPanel made for sites
 * once no site uses them any more.
 *
 * "Use Let's Encrypt" (the button, a compose route with `tls.mode: automatic`)
 * finds or creates one entry per hostname set in the organization's
 * certificate library and pins the site to it. When the last site pinned to
 * such an entry goes (a project, environment or site delete, a compose deploy
 * that drops the route), the entry goes with it in the same transaction,
 * together with the stored copy of the issued key it holds. An entry another
 * site still pins stays. Uploaded, self-signed and Organization CA entries,
 * and Let's Encrypt entries a person added to the library by hand, are never
 * removed here.
 *
 * A waiting DNS check lives on the site row (`hosting.pending_at`), so it
 * stops with the site; nothing else retries for the entry.
 */

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { audit, hosting, tls } from '../../db/schema.ts'
import { logWarn } from '../../lib/logger.ts'
import { forEachSequential } from '../../lib/sequential.ts'

/** `tls.metadata.acme.createdFor` on the entries a site's "Use Let's Encrypt" made. */
export const LETS_ENCRYPT_CREATED_FOR_SITES = 'hosting'

type LibraryRow = {
  source: string
  status: string
  name: string | null
  metadata: unknown
}

function createdForOf(metadata: unknown): unknown {
  const acme = (metadata as { acme?: unknown } | null)?.acme
  return (acme as { createdFor?: unknown } | null | undefined)?.createdFor
}

/**
 * Whether this module may remove the row: an automatic Let's Encrypt entry
 * TurboPanel made for sites. Entries made before the `createdFor` marker are
 * recognised by having no name (the panel never names the ones it makes).
 */
export function isSiteLetsEncrypt(row: LibraryRow): boolean {
  if (row.source !== 'lets_encrypt' || row.status !== 'automatic') return false
  const createdFor = createdForOf(row.metadata)
  if (createdFor === undefined || createdFor === null) return row.name === null
  return createdFor === LETS_ENCRYPT_CREATED_FOR_SITES
}

/** {@link isSiteLetsEncrypt} as a query condition, for the sweep. */
export function siteLetsEncryptCondition() {
  const createdFor = sql`${tls.metadata} -> 'acme' ->> 'createdFor'`
  return and(
    eq(tls.source, 'lets_encrypt'),
    eq(tls.status, 'automatic'),
    or(
      sql`${createdFor} = ${LETS_ENCRYPT_CREATED_FOR_SITES}`,
      and(isNull(tls.name), sql`${createdFor} is null`)
    )
  )
}

/** No site pins the row, as a query condition, for the sweep. */
export function notPinnedBySiteCondition() {
  return sql`not exists (select 1 from ${hosting} where ${hosting.tlsId} = ${tls.id})`
}

/** The certificate rows these sites pin, read before the sites go. */
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

/** The same per-organization lock the find-or-create takes (`letsencrypt-store.ts`). */
async function lockOrganizationLetsEncrypt(tx: Db, organizationId: string): Promise<void> {
  const lockKey = 'tls-lets-encrypt:' + organizationId
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
}

/**
 * The audit rows for removed entries. In a savepoint, so a failed audit write
 * is logged and never undoes the delete it belongs to.
 */
async function recordRemovals(
  tx: Db,
  removed: ReadonlyArray<{ id: string; organizationId: string }>,
  reason: string
): Promise<void> {
  if (removed.length === 0) return
  try {
    await tx.transaction(async (savepoint) => {
      await forEachSequential(removed, (row) =>
        savepoint.insert(audit).values({
          organizationId: row.organizationId,
          action: 'tls.certificate.delete',
          targetType: 'tls',
          targetId: row.id,
          context: { reason },
        })
      )
    })
  } catch (err) {
    logWarn(
      'audit',
      `failed to record tls.certificate.delete: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** The rows among `ids` this module may remove, read with their organization. */
async function loadSiteRows(
  db: Pick<Db, 'select'>,
  ids: readonly string[]
): Promise<Array<{ id: string; organizationId: string; metadata: unknown }>> {
  const rows = await db
    .select({
      id: tls.id,
      organizationId: tls.organizationId,
      source: tls.source,
      status: tls.status,
      name: tls.name,
      metadata: tls.metadata,
    })
    .from(tls)
    .where(inArray(tls.id, [...ids]))
  return rows.filter(isSiteLetsEncrypt)
}

/**
 * Remove the entries among `candidateIds` that TurboPanel made for sites and
 * that no site pins any more. Run inside the transaction that removed or
 * re-pinned the sites, after that write. Returns the removed ids.
 */
export async function removeUnusedSiteCertificates(
  tx: Db,
  candidateIds: readonly string[],
  reason: string
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const candidates = await loadSiteRows(tx, [...new Set(candidateIds)])
  if (candidates.length === 0) return []
  const organizationIds = [...new Set(candidates.map((row) => row.organizationId))].sort((a, b) =>
    a.localeCompare(b)
  )
  // A deploy finding the entry under this lock cannot pin it after it is gone.
  await forEachSequential(organizationIds, (organizationId) =>
    lockOrganizationLetsEncrypt(tx, organizationId)
  )
  // Row locks before the pin check: a pin written meanwhile waits for this
  // transaction, and one already written is seen by the check below.
  const ids = candidates.map((row) => row.id)
  await tx.select({ id: tls.id }).from(tls).where(inArray(tls.id, ids)).for('update')
  const pinned = await countPinningSites(tx, ids)
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
    .returning({ id: tls.id, organizationId: tls.organizationId })
  await recordRemovals(tx, removed, reason)
  return removed.map((row) => row.id)
}

/** One entry in a delete plan: removed with the sites, or kept for the sites that still use it. */
export type SiteCertificateFate = {
  id: string
  names: string[]
  action: 'remove' | 'keep'
  /** For `keep`: how many other sites still use it. */
  otherSites?: number
}

function namesOf(metadata: unknown): string[] {
  const dnsNames = (metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(dnsNames)
    ? dnsNames.filter((name): name is string => typeof name === 'string')
    : []
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
  const rows = await loadSiteRows(db, pinnedIds)
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
