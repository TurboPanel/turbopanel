import { isPanelFingerprint } from '../../lib/panel-identity/fingerprint.ts'
import type { PanelIdentity } from '../../lib/panel-identity/identity.ts'

/** How far a v2 proof's `iat` may be from this clock, in seconds. */
export const DAEMON_PROOF_MAX_SKEW_S = 300

export const PANEL_FINGERPRINT_MISMATCH_ERROR = 'Panel fingerprint mismatch'
export const SIGNED_PROOF_REQUIRED_ERROR = 'Signed proof required'
export const PROOF_CLOCK_SKEW_ERROR = 'Proof clock skew'

/**
 * Which sign-in proof a daemon sent. No `payloadVersion` is v1 (every older
 * daemon); v2 also names the control plane's key fingerprint and `iat`.
 */
export type ProofVersion = { version: 1 } | { version: 2; panelFingerprint: string; iat: number }

type Refusal = { ok: false; status: 400 | 403; error: string }

/** Read the optional v2 members of an enroll or session body. */
export function parseProofVersion(
  body: Record<string, unknown>
): { ok: true; value: ProofVersion } | Refusal {
  const version = body.payloadVersion
  if (version === undefined || version === 1) return { ok: true, value: { version: 1 } }
  if (version !== 2) return { ok: false, status: 400, error: 'Unsupported payloadVersion' }
  const { panelFingerprint, iat } = body
  if (typeof panelFingerprint !== 'string' || !isPanelFingerprint(panelFingerprint)) {
    return { ok: false, status: 400, error: 'Invalid panelFingerprint' }
  }
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat < 0) {
    return { ok: false, status: 400, error: 'Invalid iat' }
  }
  return { ok: true, value: { version: 2, panelFingerprint, iat } }
}

/**
 * Whether this control plane takes the proof. A v2 proof must name this
 * control plane's current or next key and be fresh. A v1 proof is refused
 * only for a server that has already used a signed session (`trustLevel` 1 or
 * more): until the version floor moves, older daemons keep signing in.
 */
export function checkProofVersion(
  proof: ProofVersion,
  ctx: { identity: PanelIdentity | null; trustLevel: number; nowMs: number }
): { ok: true } | Refusal {
  if (proof.version === 1) {
    return ctx.trustLevel >= 1
      ? { ok: false, status: 403, error: SIGNED_PROOF_REQUIRED_ERROR }
      : { ok: true }
  }
  const known = ctx.identity ? [ctx.identity.current.kid, ctx.identity.next?.kid] : []
  if (!known.includes(proof.panelFingerprint)) {
    return { ok: false, status: 403, error: PANEL_FINGERPRINT_MISMATCH_ERROR }
  }
  if (Math.abs(proof.iat - Math.floor(ctx.nowMs / 1000)) > DAEMON_PROOF_MAX_SKEW_S) {
    return { ok: false, status: 400, error: PROOF_CLOCK_SKEW_ERROR }
  }
  return { ok: true }
}

/** First line of a v2 enroll proof; pinned to the daemon's `src/crypto/keys.ts` by contract-drift. */
export const ENROLL_PROOF_V2_TAG = 'turbopanel-daemon-enroll-v2'
/** First line of a v2 session proof; pinned like {@link ENROLL_PROOF_V2_TAG}. */
export const AUTH_PROOF_V2_TAG = 'turbopanel-daemon-auth-v2'

/**
 * The v2 enroll proof: the v1 fields, then the control plane's key
 * fingerprint, the method, the path and `iat` (Unix seconds), so a proof made
 * for one control plane is no use at another. Newline-joined, no trailing newline.
 */
export function buildEnrollmentPayloadV2(params: {
  challengeId: string
  nonce: string
  licenseId: string
  machineKey: string
  hostname: string
  publicKeyFingerprint: string
  panelFingerprint: string
  iat: number
}): string {
  return [
    ENROLL_PROOF_V2_TAG,
    params.challengeId,
    params.nonce,
    params.licenseId,
    params.machineKey,
    params.hostname,
    params.publicKeyFingerprint,
    params.panelFingerprint,
    'POST',
    '/api/daemon/v1/enroll',
    String(params.iat),
  ].join('\n')
}

/** The v2 session proof; same additions as {@link buildEnrollmentPayloadV2}. */
export function buildAuthPayloadV2(params: {
  challengeId: string
  nonce: string
  serverId: string
  keyId: string
  machineKey: string
  hostname: string
  panelFingerprint: string
  iat: number
}): string {
  return [
    AUTH_PROOF_V2_TAG,
    params.challengeId,
    params.nonce,
    params.serverId,
    params.keyId,
    params.machineKey,
    params.hostname,
    params.panelFingerprint,
    'POST',
    '/api/daemon/v1/auth/session',
    String(params.iat),
  ].join('\n')
}
