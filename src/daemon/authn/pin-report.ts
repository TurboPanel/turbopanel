/**
 * The daemon's signed pin report: in a signed session the daemon's first
 * presence `hello` carries `panelPin: { pinnedBy, current, keyset, iat, sig }`,
 * where `sig` is its Ed25519 signature over
 *
 *   "tp-panel-pin\n" + sessionId + "\n" + serverId + "\n" + keyId + "\n"
 *     + pinnedBy + "\n" + current + "\n" + keyset + "\n" + iat
 *
 * `current` is the control plane key fingerprint the server's pin file holds
 * (empty for `pinned_by=unsafe`), as the server itself states it. The
 * signature does not name the control plane's key, so a server pinned to
 * another key still produces a report that verifies here and can be alarmed
 * on. `sessionId` ties it to this socket. Twin of `turbopaneld/src/crypto/keys.ts`;
 * the prefix is pinned in the daemon's contract-drift script.
 *
 * Workers-safe: WebCrypto only, nothing at module load.
 */
import type { VerifiedPinReport } from '../../features/servers/pin-report.ts'
import { REQUEST_MAX_SKEW_SECONDS } from './request-signature.ts'
import { verifyDaemonSignature } from './server-key.ts'

export const PIN_REPORT_PREFIX = 'tp-panel-pin\n'
/**
 * A newer daemon also reports the hash of its pinned rotation passkeys
 * (`passkeys`, base64url SHA-256 of the pin's `passkeys=` line, or "" when
 * none) with its own signature `passkeysSig` over
 *
 *   "tp-panel-pin-passkeys\n" + sessionId + "\n" + serverId + "\n" + keyId
 *     + "\n" + passkeys + "\n" + iat
 *
 * A separate signature keeps the first one valid for a control plane that
 * does not know the field (expand-only).
 */
export const PIN_PASSKEYS_REPORT_PREFIX = 'tp-panel-pin-passkeys\n'

export type PinReportPinnedBy = VerifiedPinReport['pinnedBy']

const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/
const SIG = /^[A-Za-z0-9_-]{86}$/
const PINNED_BY: ReadonlySet<string> = new Set(['install', 'upgrade', 'unsafe'])

export function pinReportSigningInput(params: {
  sessionId: string
  serverId: string
  keyId: string
  pinnedBy: string
  current: string
  keyset: number
  iat: number
}): string {
  return [
    `${PIN_REPORT_PREFIX}${params.sessionId}`,
    params.serverId,
    params.keyId,
    params.pinnedBy,
    params.current,
    String(params.keyset),
    String(params.iat),
  ].join('\n')
}

export function pinPasskeysSigningInput(params: {
  sessionId: string
  serverId: string
  keyId: string
  passkeys: string
  iat: number
}): string {
  return [
    `${PIN_PASSKEYS_REPORT_PREFIX}${params.sessionId}`,
    params.serverId,
    params.keyId,
    params.passkeys,
    String(params.iat),
  ].join('\n')
}

type ReportFields = VerifiedPinReport & { iat: number; sig: string; passkeysSig?: string }

function readPasskeys(
  value: Record<string, unknown>
): { passkeys: string; passkeysSig: string } | null {
  const { passkeys, passkeysSig } = value
  if (typeof passkeys !== 'string' || typeof passkeysSig !== 'string') return null
  if (passkeys !== '' && !FINGERPRINT.test(passkeys)) return null
  return SIG.test(passkeysSig) ? { passkeys, passkeysSig } : null
}

function readReport(value: unknown): ReportFields | null {
  if (typeof value !== 'object' || value === null) return null
  const { pinnedBy, current, keyset, iat, sig } = value as Record<string, unknown>
  if (typeof pinnedBy !== 'string' || !PINNED_BY.has(pinnedBy)) return null
  if (typeof current !== 'string') return null
  if (pinnedBy === 'unsafe' ? current !== '' : !FINGERPRINT.test(current)) return null
  if (typeof keyset !== 'number' || !Number.isSafeInteger(keyset) || keyset < 0) return null
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat < 0) return null
  if (typeof sig !== 'string' || !SIG.test(sig)) return null
  const base = { pinnedBy: pinnedBy as PinReportPinnedBy, current, keyset, iat, sig }
  const extra = readPasskeys(value as Record<string, unknown>)
  return extra ? { ...base, ...extra } : base
}

/**
 * Check a hello's `panelPin` against the server's active daemon key. Null when
 * it is absent, unsigned (a daemon from before the signed report), malformed,
 * stale or signed by anything else: an unproven report changes nothing.
 */
export async function verifyPinReport(
  panelPin: unknown,
  ctx: {
    sessionId: string
    serverId: string
    keyId: string | undefined
    publicJwk: JsonWebKey | undefined
    nowMs: number
  }
): Promise<VerifiedPinReport | null> {
  const fields = readReport(panelPin)
  if (!fields || !ctx.keyId || !ctx.publicJwk) return null
  if (Math.abs(fields.iat - Math.floor(ctx.nowMs / 1000)) > REQUEST_MAX_SKEW_SECONDS) return null
  const input = pinReportSigningInput({
    sessionId: ctx.sessionId,
    serverId: ctx.serverId,
    keyId: ctx.keyId,
    pinnedBy: fields.pinnedBy,
    current: fields.current,
    keyset: fields.keyset,
    iat: fields.iat,
  })
  if (!(await verifyDaemonSignature(ctx.publicJwk, input, fields.sig))) return null
  const report: VerifiedPinReport = {
    pinnedBy: fields.pinnedBy,
    current: fields.current,
    keyset: fields.keyset,
  }
  if (fields.passkeys === undefined || fields.passkeysSig === undefined) return report
  const passkeysInput = pinPasskeysSigningInput({
    sessionId: ctx.sessionId,
    serverId: ctx.serverId,
    keyId: ctx.keyId,
    passkeys: fields.passkeys,
    iat: fields.iat,
  })
  // A bad second signature drops only the passkeys part.
  return (await verifyDaemonSignature(ctx.publicJwk, passkeysInput, fields.passkeysSig))
    ? { ...report, passkeys: fields.passkeys }
    : report
}
