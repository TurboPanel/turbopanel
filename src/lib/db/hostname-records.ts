/**
 * Writes for the `hostname` uniqueness-enforcement table (schema-child-tables,
 * Road-to-0.1.x). See the table's doc comment in `schema.ts` for why this is a
 * mirror, not a promotion, of `hosting.options.hostnames[]`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { hostname } from "./schema.ts";

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

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code: unknown }).code === "23505";
}

/**
 * `postgres.js`/drizzle nest the real Postgres error under `.cause`, not the
 * top-level `.message` — checked directly against a real duplicate insert
 * before relying on this. A sibling `ip`-address uniqueness detector
 * (`ip-create-validation.ts`'s `isIpAddressUniqueViolation`) predates this
 * table and checks only the top-level message; a known, separately-tracked,
 * unrelated bug this does not repeat and does not fix.
 */
export function isHostnameUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error && err.cause instanceof Error
    ? err.cause
    : null;
  const withCode = cause ?? err;
  if (!isPostgresUniqueViolation(withCode)) return false;
  const message = cause instanceof Error
    ? cause.message
    : err instanceof Error
    ? err.message
    : String(err);
  return message.includes("uniq_hostname_routing_organization_id_hostname");
}
