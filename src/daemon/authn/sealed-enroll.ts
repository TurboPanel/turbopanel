import { isHpkeEnvelope, openFromSender } from '../../lib/panel-identity/hpke.ts'
import type { PanelIdentity } from '../../lib/panel-identity/identity.ts'

/**
 * A pinned daemon seals its license token to this control plane's sealing key
 * instead of sending it in clear, so whoever relays or ends TLS in front of the
 * control plane without the identity key never reads it. Negotiation is in
 * band: the daemon puts `clientNonce` in its challenge request and a control
 * plane that supports this echoes it in the (signed) answer.
 */
export const ENROLL_SEAL_AAD_PREFIX = 'tp-enroll-license'

const CLIENT_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

/** A well-formed client nonce, or undefined (absent or malformed is treated as not sent). */
export function parseClientNonce(value: unknown): string | undefined {
  return typeof value === 'string' && CLIENT_NONCE_PATTERN.test(value) ? value : undefined
}

/**
 * What the envelope is bound to: this control plane's key, the challenge it was
 * issued for, the daemon's nonce and the fingerprint of the key being enrolled.
 * The daemon builds the same string.
 */
export function enrollSealAad(parts: {
  panelFingerprint: string
  challengeId: string
  challengeNonce: string
  clientNonce: string
  publicKeyFingerprint: string
}): string {
  return [
    ENROLL_SEAL_AAD_PREFIX,
    parts.panelFingerprint,
    parts.challengeId,
    parts.challengeNonce,
    parts.clientNonce,
    parts.publicKeyFingerprint,
  ].join('\n')
}

export type OpenedEnrollLicense =
  { ok: true; licenseToken: string } | { ok: false; status: 400 | 503; error: string }

/** Open `sealedLicenseToken`; the token and the envelope are never put into an error. */
export async function openSealedLicenseToken(
  envelope: unknown,
  identity: PanelIdentity | null,
  bound: {
    challengeId: string
    challengeNonce: string
    clientNonce: string | undefined
    publicKeyFingerprint: string
  }
): Promise<OpenedEnrollLicense> {
  if (!isHpkeEnvelope(envelope) || bound.clientNonce === undefined) {
    return { ok: false, status: 400, error: 'sealedLicenseToken is not valid' }
  }
  if (!identity) {
    return { ok: false, status: 503, error: 'panel sealing key unavailable' }
  }
  if (envelope.kid !== identity.seal.kid) {
    return { ok: false, status: 400, error: 'envelope_open_failed' }
  }
  try {
    const opened = await openFromSender(
      identity.seal.privateKey,
      enrollSealAad({
        panelFingerprint: identity.current.kid,
        challengeId: bound.challengeId,
        challengeNonce: bound.challengeNonce,
        clientNonce: bound.clientNonce,
        publicKeyFingerprint: bound.publicKeyFingerprint,
      }),
      envelope
    )
    const licenseToken = new TextDecoder('utf-8', { fatal: true }).decode(opened).trim()
    if (!licenseToken) return { ok: false, status: 400, error: 'envelope_open_failed' }
    return { ok: true, licenseToken }
  } catch {
    return { ok: false, status: 400, error: 'envelope_open_failed' }
  }
}

/** The token an enroll body carries: sealed (opened here) or, from an older daemon, plain. */
export async function resolveEnrollLicenseToken(
  token: { plain: string; sealed: unknown },
  panelIdentity: (() => Promise<PanelIdentity | null>) | undefined,
  bound: Parameters<typeof openSealedLicenseToken>[2]
): Promise<OpenedEnrollLicense> {
  if (token.sealed === undefined) return { ok: true, licenseToken: token.plain }
  return await openSealedLicenseToken(
    token.sealed,
    panelIdentity ? await panelIdentity() : null,
    bound
  )
}
