/**
 * Per-name certificate storage rules: how a pin in the organization's TLS
 * library maps to the choice a served name shows, and the writes that keep
 * `hostname.certificate` / `hostname.tls_id` in step with the whole-site pin
 * (`hosting.tls_id`) that the older flows (Let's Encrypt, origin certificates,
 * the PATCH `tlsId` field) still write.
 *
 * A NULL `hostname.certificate` reads as "use `hosting.tls_id`".
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hostname, hosting, tls } from '../../db/schema.ts'
import type { HostnameCertificate } from './name-certificate-vocabulary.ts'

/** The choice a pinned library row stands for (`null` pin: self-signed). */
export function certificateForPinSource(source: string | null | undefined): HostnameCertificate {
  if (source === undefined || source === null) return 'self_signed'
  if (source === 'provider_origin') return 'cloudflare_origin'
  if (source === 'lets_encrypt') return 'letsencrypt_http'
  return 'library'
}

/** One name's stored choice. */
export type NameCertificate = {
  hostname: string
  certificate: HostnameCertificate
  tlsId: string | null
}

/**
 * Give every served name of a hosting the same pin. The older flows pin the
 * whole site, so they call this right after writing `hosting.tls_id`; a name
 * that was chosen differently on purpose is overwritten, because the caller
 * just asked for the whole site to use this certificate.
 */
export async function pinHostingNames(
  db: Db,
  hostingId: string,
  tlsId: string | null
): Promise<void> {
  const source = tlsId === null ? null : await pinSource(db, tlsId)
  // A pin that no longer exists reads as no pin.
  const pin = tlsId !== null && source !== null ? tlsId : null
  await db
    .update(hostname)
    .set({ tlsId: pin, certificate: certificateForPinSource(source) })
    .where(eq(hostname.hostingId, hostingId))
}

/** Move every name pinned to one library row onto its replacement (a renewed origin certificate). */
export async function repinNames(db: Db, fromTlsId: string, toTlsId: string): Promise<void> {
  await db.update(hostname).set({ tlsId: toTlsId }).where(eq(hostname.tlsId, fromTlsId))
}

async function pinSource(db: Db, tlsId: string): Promise<string | null> {
  const [row] = await db.select({ source: tls.source }).from(tls).where(eq(tls.id, tlsId)).limit(1)
  return row?.source ?? null
}

/**
 * Every served name of the given hostings with its stored choice. A name with
 * no stored choice follows the site pin, read from `hosting.tls_id`.
 */
export async function loadNameCertificates(
  db: Db,
  hostingIds: readonly string[]
): Promise<Map<string, NameCertificate[]>> {
  const out = new Map<string, NameCertificate[]>()
  if (hostingIds.length === 0) return out
  const rows = await db
    .select({
      hostingId: hostname.hostingId,
      hostname: hostname.hostname,
      certificate: hostname.certificate,
      tlsId: hostname.tlsId,
      sitePin: hosting.tlsId,
      pinSource: tls.source,
    })
    .from(hostname)
    .innerJoin(hosting, eq(hosting.id, hostname.hostingId))
    .leftJoin(tls, eq(tls.id, hosting.tlsId))
    .where(inArray(hostname.hostingId, [...hostingIds]))
  for (const row of rows) {
    const list = out.get(row.hostingId) ?? []
    list.push(
      row.certificate === null
        ? {
            hostname: row.hostname,
            certificate: certificateForPinSource(row.pinSource),
            tlsId: row.sitePin,
          }
        : {
            hostname: row.hostname,
            certificate: row.certificate as HostnameCertificate,
            tlsId: row.tlsId,
          }
    )
    out.set(row.hostingId, list)
  }
  return out
}

/** Hostings that have at least one name pinned to this library row. */
export async function hostingsPinningName(db: Db, tlsId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: hostname.hostingId })
    .from(hostname)
    .where(eq(hostname.tlsId, tlsId))
  return rows.map((r) => r.id)
}

/**
 * After per-name choices were saved: when every name now uses the same pin,
 * keep `hosting.tls_id` equal to it (the whole-site pin the older flows read);
 * names that differ leave it as it was. Returns nothing; no write when the
 * names disagree or the value is already right.
 */
export async function syncHostingPin(db: Db, hostingId: string): Promise<void> {
  const names = (await loadNameCertificates(db, [hostingId])).get(hostingId) ?? []
  if (names.length === 0) return
  const pins = new Set(names.map((n) => n.tlsId))
  if (pins.size !== 1) return
  const [only] = [...pins]
  await db
    .update(hosting)
    .set({ tlsId: only ?? null, updatedAt: sql`${hosting.updatedAt}` })
    .where(and(eq(hosting.id, hostingId), sql`${hosting.tlsId} IS DISTINCT FROM ${only ?? null}`))
}
