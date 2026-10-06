/**
 * Writes for the `hostname` uniqueness-enforcement table (schema-child-tables,
 * Road-to-0.1.x). See the table's doc comment in `schema.ts` for why this is a
 * mirror, not a promotion, of `hosting.options.hostnames[]`.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hostname } from '../../db/schema.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { type HostingWwwMode, hostingCertificateNames } from '../../contracts/commands/hostname.ts'

/**
 * Full-replace sync of a hosting's `hostname` rows, mirroring
 * `options.hostnames[]`'s own replace-whole-array write semantics. Call
 * inside the same transaction as the `hosting` write it mirrors.
 */
export async function replaceHostingHostnames(
  db: Db,
  hostingId: string,
  routingOrganizationId: string,
  hostnames: readonly string[]
): Promise<void> {
  await db.delete(hostname).where(eq(hostname.hostingId, hostingId))
  await forEachSequential(hostnames, (value) =>
    db.insert(hostname).values({
      hostingId,
      routingOrganizationId,
      hostname: value,
    })
  )
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
