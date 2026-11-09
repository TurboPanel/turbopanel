/**
 * Store a server's signed pin report and alarm when it names another key.
 *
 * The daemon signs what its pin file holds (`src/daemon/authn/pin-report.ts`);
 * only a verified report reaches here. The columns record what it said and
 * whether that key is this control plane's current or next key. A report
 * that does not match (another key, or other rotation passkeys at the live
 * key set) raises `panel.pin_mismatch` (audit `server.panel_pin.mismatch`)
 * once per reported fingerprint, not once per connect. Never throws into the
 * session: a failed write or alert is logged and the next report retries.
 *
 * Workers-safe: one database client handed in by the caller, nothing cached.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { recordAudit } from '../audit/audit-records.ts'
import { emitNotification } from '../notifications/emit.ts'
import { serverNoticeName } from './notice-name.ts'

/** A pin report whose daemon signature verified: what the server says it pinned. */
export type VerifiedPinReport = {
  pinnedBy: 'install' | 'upgrade' | 'unsafe'
  /** Pinned control plane key fingerprint; "" when nothing is pinned (`unsafe`). */
  current: string
  keyset: number
  /** Hash of the rotation passkeys the pin holds ("" for none); absent from older daemons. */
  passkeys?: string
}

/**
 * The control plane keys a server may have pinned: current, and next when
 * set. `passkeys` is the hash of the marked rotation passkeys: null with none
 * marked, undefined when it could not be read (unknown is never a mismatch).
 * `keyset` is the live key set, when known.
 */
export type ControlPlaneKids = {
  current: string
  next?: string | null
  passkeys?: string | null
  keyset?: number
}

export type PinReportDeps = {
  /** Test seams. */
  emit?: typeof emitNotification
  audit?: typeof recordAudit
  now?: () => Date
}

/** Whether a report names one of this control plane's keys. An unsafe pin names none. */
export function pinReportMatches(report: VerifiedPinReport, kids: ControlPlaneKids): boolean {
  return report.current !== '' && (report.current === kids.current || report.current === kids.next)
}

/**
 * Whether the reported rotation passkeys are this control plane's. A server
 * that has not learned them yet ("") or does not report them is not a
 * mismatch: it simply cannot follow a rotation yet. Neither is a server whose
 * key set is below the live one: it is behind (it re-reads the document once
 * a day) and will catch up.
 */
export function pinPasskeysMatch(report: VerifiedPinReport, kids: ControlPlaneKids): boolean {
  if (report.passkeys === undefined || report.passkeys === '') return true
  if (kids.passkeys === undefined) return true
  if (kids.keyset !== undefined && report.keyset < kids.keyset) return true
  return report.passkeys === (kids.passkeys ?? '')
}

/** Record the report; returns true when a mismatch alarm was raised. */
export async function recordPinReport(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  serverId: string,
  report: VerifiedPinReport,
  kids: ControlPlaneKids,
  deps: PinReportDeps = {}
): Promise<boolean> {
  try {
    const [row] = await db
      .select({
        organizationId: server.organizationId,
        name: server.name,
        hostname: server.hostname,
        fingerprint: server.trustPinFingerprint,
        matching: server.isTrustPinMatching,
      })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    if (!row) return false
    // An unsafe install pins nothing: that is shown as its own state, not a mismatch.
    const keyMatches = pinReportMatches(report, kids)
    const matching = report.pinnedBy === 'unsafe' || (keyMatches && pinPasskeysMatch(report, kids))
    // With the right key, the alarm is about the passkeys: say both sides of that.
    const passkeysContext = keyMatches
      ? { reportedPasskeys: report.passkeys ?? '', expectedPasskeys: kids.passkeys ?? '' }
      : {}
    await db
      .update(server)
      .set({
        trustPinFingerprint: report.current,
        trustPinKeyset: report.keyset,
        trustPinReportedAt: deps.now?.() ?? new Date(),
        isTrustPinMatching: matching,
        ...(report.passkeys === undefined ? {} : { trustPinPasskeys: report.passkeys }),
        // A signed report proves the server talks to this control plane: any
        // pin silence alarm for it is over.
        trustSilenceStage: null,
        trustSilenceSince: null,
        trustSilenceAliveAt: null,
      })
      .where(eq(server.id, serverId))
    const alreadyRaised = row.matching === false && row.fingerprint === report.current
    if (matching || alreadyRaised) return false
    await (deps.audit ?? recordAudit)(db, {
      organizationId: row.organizationId,
      actorUserId: null,
      action: 'server.panel_pin.mismatch',
      targetType: 'server',
      targetId: serverId,
      context: {
        reported: report.current,
        expected: kids.current,
        keyset: report.keyset,
        ...(kids.keyset === undefined ? {} : { expectedKeyset: kids.keyset }),
        ...(report.passkeys && !keyMatches ? { reportedPasskeys: report.passkeys } : {}),
        ...passkeysContext,
      },
    })
    if (row.organizationId) {
      await (deps.emit ?? emitNotification)(
        db,
        secrets,
        {
          event: 'panel.pin_mismatch',
          organizationId: row.organizationId,
          context: {
            serverName: serverNoticeName(row),
            reported: report.current,
            expected: kids.current,
            ...passkeysContext,
          },
          targetType: 'server',
          targetId: serverId,
        },
        { allowPrivateTargets: true }
      )
    }
    return true
  } catch (err) {
    compatLogWarn(
      'pin-report',
      `pin report for server ${serverId} not recorded: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
