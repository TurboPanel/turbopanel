/**
 * Writes for the `hostname` uniqueness-enforcement table (schema-child-tables,
 * Road-to-0.1.x). See the table's doc comment in `schema.ts` for why this is a
 * mirror, not a promotion, of `hosting.options.hostnames[]`.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hostname, hosting, tls } from '../../db/schema.ts'
import {
  letsEncryptNames,
  readPendingLetsEncrypt,
  withPendingLetsEncrypt,
} from '../hostings/hosting-certificate.ts'
import { readHostingWwwMode } from '../hostings/hosting-options.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { type HostingWwwMode, hostingCertificateNames } from '../../contracts/commands/hostname.ts'

/**
 * Full-replace sync of a hosting's `hostname` rows, mirroring
 * `options.hostnames[]`'s own replace-whole-array write semantics, plus every
 * name the hosting's www choice adds ({@link hostingRoutingNames}, read from
 * the row just written). Call inside the same transaction as the `hosting`
 * write it mirrors (panel create/patch, compose reconcile), after that write.
 *
 * When the names grew while the hosting is pinned to a Let's Encrypt row that
 * does not list them all, the same request the "Use Let's Encrypt" button makes
 * is queued ({@link queueLetsEncryptRecheck}), so the new names get their DNS
 * check and the card says which ones do not point here yet.
 */
export async function replaceHostingHostnames(
  db: Db,
  hostingId: string,
  routingOrganizationId: string,
  hostnames: readonly string[]
): Promise<void> {
  const [row] = await db
    .select({ tlsId: hosting.tlsId, options: hosting.options, metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  const www = readHostingWwwMode(row?.options)
  await db.delete(hostname).where(eq(hostname.hostingId, hostingId))
  await forEachSequential(hostingRoutingNames(hostnames, www), (value) =>
    db.insert(hostname).values({
      hostingId,
      routingOrganizationId,
      hostname: value,
    })
  )
  if (row) await queueLetsEncryptRecheck(db, hostingId, row, letsEncryptNames(hostnames, www))
}

/**
 * Queue a Let's Encrypt request for a hosting pinned to a Let's Encrypt row
 * whose names do not cover `names` (and with no request already waiting). The
 * sweep then checks DNS on every name, shows "www.<name> doesn't point at this
 * server yet" while it waits, and pins a row covering every name once DNS is
 * right. Returns whether a request was queued.
 */
export async function queueLetsEncryptRecheck(
  db: Db,
  hostingId: string,
  row: Readonly<{ tlsId: string | null; metadata: unknown }>,
  names: readonly string[],
  now: Date = new Date()
): Promise<boolean> {
  if (!row.tlsId || readPendingLetsEncrypt(row.metadata) !== null) return false
  const [pin] = await db
    .select({ source: tls.source, metadata: tls.metadata })
    .from(tls)
    .where(eq(tls.id, row.tlsId))
    .limit(1)
  if (pin?.source !== 'lets_encrypt') return false
  const covered = (pin.metadata as { dnsNames?: unknown } | null)?.dnsNames
  if (Array.isArray(covered) && names.every((name) => covered.includes(name))) return false
  await db
    .update(hosting)
    .set({
      metadata: withPendingLetsEncrypt(row.metadata, { requestedAt: now.toISOString(), dns: null }),
    })
    .where(eq(hosting.id, hostingId))
  return true
}

/**
 * Every name a hosting answers on, for the uniqueness table: the typed names
 * plus each name its www choice adds (served or redirect-only). A www name
 * goes on the shared routing layer exactly like a typed one, so it must be
 * just as unique: one environment's `both` may not claim a name another one
 * typed, and typing a name another hosting's www choice already adds is
 * refused too (`hostname_in_use`).
 */
export function hostingRoutingNames(
  hostnames: readonly string[],
  www: HostingWwwMode | undefined
): string[] {
  return hostingCertificateNames({ hostnames, www })
}

/** `uniq_hostname_routing_organization_id_hostname` firing — see `unique-violation.ts` for the `.cause` walk. */
export function isHostnameUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, 'uniq_hostname_routing_organization_id_hostname')
}
