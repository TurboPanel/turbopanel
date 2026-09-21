/**
 * Writes for the `hostname` uniqueness-enforcement table (schema-child-tables,
 * Road-to-0.1.x). See the table's doc comment in `schema.ts` for why this is a
 * mirror, not a promotion, of `hosting.options.hostnames[]`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { hostname } from "../../db/schema.ts";
import { isUniqueViolationOn } from "../../db/unique-violation.ts";

/**
 * Full-replace sync of a hosting's `hostname` rows, mirroring
 * `options.hostnames[]`'s own replace-whole-array write semantics. Call
 * inside the same transaction as the `hosting` write it mirrors.
 */
export async function replaceHostingHostnames(
  db: Db,
  hostingId: string,
  routingOrganizationId: string,
  hostnames: readonly string[],
): Promise<void> {
  await db.delete(hostname).where(eq(hostname.hostingId, hostingId));
  for (const value of hostnames) {
    await db.insert(hostname).values({
      hostingId,
      routingOrganizationId,
      hostname: value,
    });
  }
}

/** `uniq_hostname_routing_organization_id_hostname` firing — see `unique-violation.ts` for the `.cause` walk. */
export function isHostnameUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, "uniq_hostname_routing_organization_id_hostname");
}
