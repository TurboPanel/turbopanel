/**
 * Daemon-signed reports. On a signed session the daemon signs the two reports
 * this control plane makes trust decisions on: `command-outcome` (a fabric
 * reconcile result carries the host's TurboFabric public key, handed to other
 * servers) and `fabric-peers-report` (peer health read as liveness). A proxy
 * or tunnel that ends TLS between a pinned server and the control plane can
 * still strip the signature (and the feature from the unsigned hello), so a
 * forged or altered report is detected when it is signed, and unsigned ones
 * are refused once the server has signed: after its first verified signed
 * report `server.trust_reports_signed_at` is set, and from then on an
 * unsigned report on a signed session is refused exactly like a bad
 * signature. Before that an unsigned report is still accepted (older
 * daemons), with a warning.
 *
 * Same byte rules as the signed frames this control plane sends
 * (`frame-envelope.ts`): the frame carries `{sessionId, iat, kid}` and the
 * signature last, as `,"sig":"<base64url>"}`; the signature is the daemon
 * key's Ed25519 over
 *
 *   "tp-report\n" + type + "\n" + <the frame bytes before the marker, plus "}">
 *
 * `kid` is the daemon key id and `sessionId` the one in this socket's signed
 * hello. No `seq`: a result is idempotent by id. Twin of
 * `turbopaneld/src/instance/report-signing.ts`; the prefix is pinned in both
 * contract-drift scripts.
 *
 * Workers-safe: WebCrypto only, nothing at module load.
 */
import { REPORT_PREFIX, splitSignature } from '../../lib/panel-identity/frame-envelope.ts'
import { SIGNED_REPORTS_FEATURE } from '../../lib/version-wire.ts'
import { REQUEST_MAX_SKEW_SECONDS } from './request-signature.ts'
import { verifyDaemonSignature } from './server-key.ts'

/** The reports a daemon signs on a signed session. */
export const SIGNED_REPORT_TYPES: ReadonlySet<string> = new Set([
  'command-outcome',
  'fabric-peers-report',
])

/** The error a command gets when its result arrived with a bad signature. */
export const REPORT_SIGNATURE_INVALID = 'signature_invalid'

const LOGGABLE_ID = /^[A-Za-z0-9_-]{1,64}$/

const REPORT_ENVELOPE_FIELDS = ['sessionId', 'iat', 'kid', 'sig'] as const

export type ReportSession = {
  /** The session id in this socket's signed hello. */
  sessionId: string
  /** The server's daemon key the upgrade checked. */
  keyId: string | undefined
  publicJwk: JsonWebKey | undefined
  /** The daemon listed `signed-reports-v1` on this socket's hello. */
  daemonSignsReports: boolean
  /**
   * The server has sent a verified signed report before
   * (`server.trust_reports_signed_at`, or earlier on this socket): its
   * unsigned reports are refused.
   */
  serverSignsReports: boolean
  nowMs: number
}

/**
 * What to do with one inbound frame of a signed session.
 * - `raw`: the text to handle as usual (envelope removed from a verified
 *   report; a failed `command-outcome` in place of a refused one), or null to
 *   drop the frame.
 * - `warning`: one line to log, or null.
 * - `verdict`: `verified` (a signed report that checked out: record that the
 *   server signs), `refused`, `unsigned` (an unsigned report accepted; its
 *   warning is logged once per connection) or `other` (not a report).
 */
export type ReportIntake = {
  raw: string | null
  warning: string | null
  verdict: ReportVerdict
}

export type ReportVerdict = 'verified' | 'refused' | 'unsigned' | 'other'

/** True when a presence `hello`'s feature list says the daemon signs its reports. */
export function helloListsSignedReports(features: unknown): boolean {
  return Array.isArray(features) && features.includes(SIGNED_REPORTS_FEATURE)
}

export function reportSigningInput(type: string, unsigned: string): string {
  return `${REPORT_PREFIX}${type}\n${unsigned}`
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function reportType(record: Record<string, unknown> | null): string | null {
  const type = record?.type
  return typeof type === 'string' && SIGNED_REPORT_TYPES.has(type) ? type : null
}

/** Why a signed report is refused, or null when it verifies. */
async function refusalReason(
  report: Record<string, unknown>,
  split: { unsigned: string; sig: string },
  type: string,
  ctx: ReportSession
): Promise<string | null> {
  if (!ctx.publicJwk || !ctx.keyId) return 'no daemon key'
  if (report.kid !== ctx.keyId) return 'signed by another key'
  if (report.sessionId !== ctx.sessionId) return 'for another session'
  const iat = report.iat
  if (
    typeof iat !== 'number' ||
    !Number.isInteger(iat) ||
    Math.abs(iat - Math.floor(ctx.nowMs / 1000)) > REQUEST_MAX_SKEW_SECONDS
  ) {
    return 'iat out of range'
  }
  const ok = await verifyDaemonSignature(
    ctx.publicJwk,
    reportSigningInput(type, split.unsigned),
    split.sig
  )
  return ok ? null : 'signature invalid'
}

/** The message without its envelope members, as text for the usual parser. */
function withoutEnvelope(report: Record<string, unknown>): string {
  const message = { ...report }
  for (const field of REPORT_ENVELOPE_FIELDS) delete message[field]
  return JSON.stringify(message)
}

/**
 * A refused `command-outcome` becomes a failed one for the same id, so the
 * command does not wait forever and the daemon still gets its ack (else it
 * would resend the result on every attach). A refused peer report is dropped.
 */
function refusedReplacement(
  report: Record<string, unknown>,
  type: string,
  nowMs: number
): string | null {
  if (type !== 'command-outcome' || typeof report.id !== 'string') return null
  return JSON.stringify({
    type: 'command-outcome',
    id: report.id,
    ok: false,
    error: REPORT_SIGNATURE_INVALID,
    at: new Date(nowMs).toISOString(),
  })
}

function unsignedIntake(raw: string, ctx: ReportSession): ReportIntake {
  // Classify from the parsed frame, never from the raw text: whitespace, key
  // order, duplicate keys and \u escapes all change the text but not the type
  // the validator will read (JSON.parse, last duplicate wins).
  const report = parseRecord(raw)
  const type = reportType(report)
  if (!report || !type) return { raw, warning: null, verdict: 'other' }
  // Not gated on the hello's feature list: a proxy can strip that too.
  if (ctx.serverSignsReports) {
    return {
      raw: refusedReplacement(report, type, ctx.nowMs),
      warning: `refused unsigned ${type}${loggableId(report)}: this server signs its reports`,
      verdict: 'refused',
    }
  }
  return {
    raw,
    warning: ctx.daemonSignsReports ? `unsigned ${type} from a daemon that signs reports` : null,
    verdict: 'unsigned',
  }
}

/** ` id=<id>` when the (unverified) id looks like one, else empty. */
function loggableId(report: Record<string, unknown>): string {
  return typeof report.id === 'string' && LOGGABLE_ID.test(report.id) ? ` id=${report.id}` : ''
}

/**
 * Check one inbound frame of a signed session. Frames that are not reports
 * pass as they are. An unsigned report is refused once the server has signed
 * one; before that it is still accepted (older daemons), with a warning when
 * this daemon said it signs them.
 */
export async function intakeSignedSessionReport(
  raw: string,
  ctx: ReportSession
): Promise<ReportIntake> {
  const split = splitSignature(raw)
  if (!split) return unsignedIntake(raw, ctx)
  const report = parseRecord(split.unsigned)
  const type = reportType(report)
  // Not a report by its signed part: still classify the whole frame, so a
  // marker-shaped tail inside a nested value cannot hide a report.
  if (!report || !type) return unsignedIntake(raw, ctx)
  const reason = await refusalReason(report, split, type, ctx)
  if (reason === null) return { raw: withoutEnvelope(report), warning: null, verdict: 'verified' }
  return {
    raw: refusedReplacement(report, type, ctx.nowMs),
    warning: `refused signed ${type}${loggableId(report)}: ${reason}`,
    verdict: 'refused',
  }
}
