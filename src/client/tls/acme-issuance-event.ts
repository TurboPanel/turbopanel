/**
 * Daemon-observed ACME issuance state for one `tlsMode: 'acme'` hostname.
 * Merge-patches `tls.metadata.acme.lastError` on the matching `managed`
 * `lets_encrypt` row only — deliberately never writes `tls.status`.
 * `isReadyCandidate` (`../../lib/tls/match.ts`) treats any `managed` row as
 * deploy-ready purely from its `status` column; a visibility feature must
 * not become a second, accidental deploy gate by touching that column.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { server, tls } from "../../lib/db/schema.ts";
import { coversHostname, normalizeHostname } from "../../lib/tls/match.ts";
import type { TlsAcmeMetadata } from "../../lib/tls/types.ts";

export type AcmeIssuanceEventInput = {
  /** The server that reported the outcome — scopes the write to its organization. */
  serverId: string;
  hostname: string;
  ok: boolean;
  errorMessage?: string;
};

function isResidualMetadata(
  value: unknown,
): value is {
  dnsNames: string[];
  acme?: TlsAcmeMetadata;
  [key: string]: unknown;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.dnsNames) &&
    record.dnsNames.every((n) => typeof n === "string");
}

/**
 * Records the latest issuance outcome on the reporting organization's
 * `managed` `lets_encrypt` rows whose `dnsNames` cover the hostname.
 *
 * **Scoped to the reporting server's organization.** Hostname uniqueness is
 * per organization, so two organizations can legitimately hold rows for the
 * same hostname; an unscoped query let one organization's daemon patch
 * another's row. The reporting server's `organization_id` is the scope, and
 * a server with no row (deleted mid-flight) writes nothing.
 *
 * Within that organization every matching row is updated rather than the
 * first: a hostname can be covered by more than one certificate row (an
 * older revoked-then-recreated pin, a wildcard beside an exact name), and
 * leaving the others stale is how an operator ends up reading an issuance
 * error that no longer exists. No match (the hosting since removed, or DNS
 * unpinned) is a normal, silent no-op — the daemon may still be probing a
 * hostname the control plane no longer has a row for.
 */
export async function handleAcmeIssuanceEvent(
  db: Db,
  input: AcmeIssuanceEventInput,
): Promise<{ updated: boolean }> {
  const hostname = normalizeHostname(input.hostname);
  if (hostname.length === 0) return { updated: false };

  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, input.serverId))
    .limit(1);
  // An unassigned server (enrolled, not yet placed in an organization) has no
  // scope to write in — and no tenant rows of its own to be about.
  const organizationId = serverRow?.organizationId;
  if (!organizationId) return { updated: false };

  const rows = await db
    .select({ id: tls.id, status: tls.status, metadata: tls.metadata })
    .from(tls)
    .where(
      and(
        eq(tls.source, "lets_encrypt"),
        eq(tls.organizationId, organizationId),
      ),
    );

  let updated = false;
  for (const row of rows) {
    if (row.status !== "managed") continue;
    if (!isResidualMetadata(row.metadata)) continue;
    if (!coversHostname(row.metadata.dnsNames, hostname)) continue;

    const nextAcme: TlsAcmeMetadata = { ...row.metadata.acme };
    if (input.ok) {
      delete nextAcme.lastError;
    } else {
      nextAcme.lastError = input.errorMessage ?? "ACME issuance failed";
    }

    await db
      .update(tls)
      .set({
        metadata: { ...row.metadata, acme: nextAcme },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tls.id, row.id));
    updated = true;
  }

  return { updated };
}
