/**
 * Daemon-observed ACME issuance state for one `tlsMode: 'acme'` hostname.
 * Merge-patches `tls.metadata.acme.lastError` on the matching `managed`
 * `lets_encrypt` row only — deliberately never writes `tls.status`.
 * `isReadyCandidate` (`../../lib/tls/match.ts`) treats any `managed` row as
 * deploy-ready purely from its `status` column; a visibility feature must
 * not become a second, accidental deploy gate by touching that column.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { tls } from '../../lib/db/schema.ts'
import { coversHostname, normalizeHostname } from '../../lib/tls/match.ts'
import type { TlsAcmeMetadata } from '../../lib/tls/types.ts'

export type AcmeIssuanceEventInput = {
  hostname: string
  ok: boolean
  errorMessage?: string
}

function isResidualMetadata(
  value: unknown,
): value is { dnsNames: string[]; acme?: TlsAcmeMetadata; [key: string]: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return Array.isArray(record.dnsNames) &&
    record.dnsNames.every((n) => typeof n === 'string')
}

/**
 * Finds the `managed` `lets_encrypt` row (if any) whose `dnsNames` cover the
 * reported hostname and records the latest issuance outcome on it. At most
 * one row is updated — the first match, per `resolveTlsForHosting`'s own
 * single-pin model. No match (the hosting since removed, or DNS unpinned)
 * is a normal, silent no-op — the daemon may still be probing a hostname the
 * control plane no longer has a row for.
 */
export async function handleAcmeIssuanceEvent(
  db: Db,
  input: AcmeIssuanceEventInput,
): Promise<{ updated: boolean }> {
  const hostname = normalizeHostname(input.hostname)
  if (hostname.length === 0) return { updated: false }

  const rows = await db
    .select({ id: tls.id, status: tls.status, metadata: tls.metadata })
    .from(tls)
    .where(eq(tls.source, 'lets_encrypt'))

  for (const row of rows) {
    if (row.status !== 'managed') continue
    if (!isResidualMetadata(row.metadata)) continue
    if (!coversHostname(row.metadata.dnsNames, hostname)) continue

    const nextAcme: TlsAcmeMetadata = { ...row.metadata.acme }
    if (input.ok) {
      delete nextAcme.lastError
    } else {
      nextAcme.lastError = input.errorMessage ?? 'ACME issuance failed'
    }

    await db
      .update(tls)
      .set({
        metadata: { ...row.metadata, acme: nextAcme },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tls.id, row.id))
    return { updated: true }
  }

  return { updated: false }
}
