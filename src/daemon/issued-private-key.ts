import { isHpkeEnvelope, openFromSender } from '../lib/panel-identity/hpke.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'

type IssuedKeyBody = { privateKeyPem?: unknown; privateKeyEnvelope?: unknown }

export type IssuedPrivateKey =
  { ok: true; privateKeyPem: string } | { ok: false; status: 400 | 503; error: string }

/**
 * The private key of a certificate a daemon reports: plain PEM (older
 * daemons) or an envelope sealed to the panel's sealing key, with the panel's
 * identity key id as the aad. Exactly one of the two. The key and the
 * envelope are never put into an error.
 */
export async function resolveIssuedPrivateKey(
  body: IssuedKeyBody,
  identity: PanelIdentity | null
): Promise<IssuedPrivateKey> {
  const { privateKeyPem, privateKeyEnvelope } = body
  if (privateKeyPem !== undefined && privateKeyEnvelope !== undefined) {
    return { ok: false, status: 400, error: 'send privateKeyPem or privateKeyEnvelope, not both' }
  }
  if (privateKeyEnvelope === undefined) {
    if (typeof privateKeyPem !== 'string') {
      return { ok: false, status: 400, error: 'privateKeyPem or privateKeyEnvelope is required' }
    }
    return { ok: true, privateKeyPem }
  }
  if (!isHpkeEnvelope(privateKeyEnvelope)) {
    return { ok: false, status: 400, error: 'privateKeyEnvelope is not valid' }
  }
  if (!identity) {
    return { ok: false, status: 503, error: 'panel sealing key unavailable' }
  }
  if (privateKeyEnvelope.kid !== identity.seal.kid) {
    return { ok: false, status: 400, error: 'envelope_open_failed' }
  }
  try {
    const opened = await openFromSender(
      identity.seal.privateKey,
      identity.current.kid,
      privateKeyEnvelope
    )
    return { ok: true, privateKeyPem: new TextDecoder('utf-8', { fatal: true }).decode(opened) }
  } catch {
    return { ok: false, status: 400, error: 'envelope_open_failed' }
  }
}
