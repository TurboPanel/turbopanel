/**
 * Daemon-observed ACME issuance state for one `tlsMode: 'acme'` hostname.
 * Merge-patches `tls.metadata.acme` (`lastError`, `lastIssuedAt`, `notAfter`)
 * on the matching `managed` `lets_encrypt` row only — deliberately never
 * writes `tls.status`.
 * `isReadyCandidate` (`../../lib/tls/match.ts`) treats any `managed` row as
 * deploy-ready purely from its `status` column; a visibility feature must
 * not become a second, accidental deploy gate by touching that column.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server, tls } from '../../db/schema.ts'
import { coversHostname, normalizeHostname } from '../../lib/tls/match.ts'
import type { TlsAcmeMetadata } from '../../lib/tls/types.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { redactUrlSecrets } from '../../features/upgrades/redact-url-secrets.ts'

export type AcmeIssuanceEventInput = {
  /** The server that reported the outcome — scopes the write to its organization. */
  serverId: string
  hostname: string
  ok: boolean
  errorMessage?: string
  /** Leaf expiry (ISO 8601) the daemon's probe read; sent with `ok: true`. */
  notAfter?: string
  /** When the daemon observed it (ISO 8601); stamps `lastIssuedAt`. Defaults to now. */
  at?: string
}

function isResidualMetadata(value: unknown): value is {
  dnsNames: string[]
  acme?: TlsAcmeMetadata
  [key: string]: unknown
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return Array.isArray(record.dnsNames) && record.dnsNames.every((n) => typeof n === 'string')
}

/**
 * The next `acme` metadata for one row. A good probe clears `lastError`,
 * records the served expiry, and stamps `lastIssuedAt` when this is the first
 * good sighting, a recovery from a failure, or the expiry moved (a renewal);
 * a repeat of the same good state leaves the stamp alone. A failure sets
 * `lastError` and leaves the last known expiry and stamp in place.
 */
export function applyIssuanceOutcome(
  previous: TlsAcmeMetadata | undefined,
  input: Pick<AcmeIssuanceEventInput, 'ok' | 'errorMessage' | 'notAfter' | 'at'>,
  now: () => string = () => new Date().toISOString()
): TlsAcmeMetadata {
  const next: TlsAcmeMetadata = { ...previous }
  if (!input.ok) {
    next.lastError = redactUrlSecrets(input.errorMessage ?? 'ACME issuance failed')
    return next
  }
  const recovered = previous?.lastError !== undefined
  const expiryMoved = input.notAfter !== undefined && input.notAfter !== previous?.notAfter
  delete next.lastError
  if (input.notAfter !== undefined) next.notAfter = input.notAfter
  if (recovered || expiryMoved || previous?.lastIssuedAt === undefined) {
    next.lastIssuedAt = input.at ?? now()
  }
  return next
}

/** What the caller needs to tell people a certificate just started failing. */
export type NewAcmeFailure = { organizationId: string; hostname: string; rawError?: string }

export type AcmeIssuanceEventDeps = {
  /**
   * Called at most once per event, and only when a matching row had no
   * `lastError` before and now does (an ok-to-failed transition). A hostname
   * that keeps failing is not announced again until a good probe clears it.
   * Never throws into the caller's write path.
   */
  onNewFailure?: (failure: NewAcmeFailure) => Promise<void>
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
  deps: AcmeIssuanceEventDeps = {}
): Promise<{ updated: boolean }> {
  const hostname = normalizeHostname(input.hostname)
  if (hostname.length === 0) return { updated: false }

  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, input.serverId))
    .limit(1)
  // An unassigned server (enrolled, not yet placed in an organization) has no
  // scope to write in — and no tenant rows of its own to be about.
  const organizationId = serverRow?.organizationId
  if (!organizationId) return { updated: false }

  const rows = await db
    .select({ id: tls.id, status: tls.status, metadata: tls.metadata })
    .from(tls)
    .where(and(eq(tls.source, 'lets_encrypt'), eq(tls.organizationId, organizationId)))

  let updated = false
  let newlyFailing = false
  await forEachSequential(rows, async (row) => {
    if (row.status !== 'managed') return
    if (!isResidualMetadata(row.metadata)) return
    if (!coversHostname(row.metadata.dnsNames, hostname)) return

    const nextAcme = applyIssuanceOutcome(row.metadata.acme, input)
    if (!input.ok && row.metadata.acme?.lastError === undefined) newlyFailing = true

    await db
      .update(tls)
      .set({
        metadata: { ...row.metadata, acme: nextAcme },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tls.id, row.id))
    updated = true
  })

  if (newlyFailing) await announceNewFailure(deps, organizationId, hostname, input.errorMessage)
  return { updated }
}

async function announceNewFailure(
  deps: AcmeIssuanceEventDeps,
  organizationId: string,
  hostname: string,
  rawError: string | undefined
): Promise<void> {
  if (!deps.onNewFailure) return
  try {
    await deps.onNewFailure({ organizationId, hostname, ...(rawError ? { rawError } : {}) })
  } catch {
    // The record is already written; a failed alert must not fail the event.
  }
}
