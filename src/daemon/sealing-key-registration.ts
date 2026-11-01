import { base64urlDecode } from '../lib/encoding/base64url.ts'
import { fingerprintRawPublicKey, isPanelFingerprint } from '../lib/panel-identity/fingerprint.ts'
import type { DaemonSealingKey } from '../features/servers/daemon-sealing-key.ts'
import { verifyDaemonSignature } from './authn/server-key.ts'

/** What the daemon signs: the registration is bound to the public key bytes. */
export const SEALING_KEY_SIGNATURE_PREFIX = 'tp-sealing-key\n'
const SIGNATURE_MAX_CHARS = 128
const PUB_CHARS = 43
function isBase64urlOfLength(value: unknown, chars: number): value is string {
  return typeof value === 'string' && value.length === chars && /^[A-Za-z0-9_-]+$/.test(value)
}

/** Shape check only: 43-character kid and pub, bounded signature. */
export function parseSealingKeyRegistration(
  body: unknown
): { kid: string; pub: string; sig: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const { kid, pub, sig } = body as Record<string, unknown>
  if (!isBase64urlOfLength(kid, PUB_CHARS) || !isBase64urlOfLength(pub, PUB_CHARS)) return null
  if (typeof sig !== 'string' || sig === '' || sig.length > SIGNATURE_MAX_CHARS) return null
  return { kid, pub, sig }
}

/**
 * True when `kid` is the fingerprint of the raw X25519 key `pub` and `sig` is
 * the daemon's Ed25519 signature over `"tp-sealing-key\n" + pub`.
 */
export async function verifySealingKeyRegistration(
  daemonPublicJwk: JsonWebKey,
  registration: { kid: string; pub: string; sig: string }
): Promise<boolean> {
  let raw: Uint8Array
  try {
    raw = base64urlDecode(registration.pub)
  } catch {
    return false
  }
  if (raw.length !== 32) return false
  const kid = await fingerprintRawPublicKey(raw)
  if (kid !== registration.kid || !isPanelFingerprint(kid)) return false
  return await verifyDaemonSignature(
    daemonPublicJwk,
    SEALING_KEY_SIGNATURE_PREFIX + registration.pub,
    registration.sig
  )
}

/** What the registration handler needs; the route passes the database-backed one. */
export type SealingKeyRegistrationStore = {
  loadDaemonPublicJwk(serverId: string): Promise<JsonWebKey | null>
  save(serverId: string, key: DaemonSealingKey & { reportedAt: string }): Promise<void>
}

export type SealingKeyRegistrationResult =
  | { status: 200; body: { ok: true; kid: string } }
  | { status: 400; body: { ok: false; error: string } }

/**
 * Store the daemon's sealing key when the signature checks out against the key
 * on file. A later valid registration replaces the earlier one (the daemon
 * regenerates it with its identity key); an invalid one changes nothing.
 */
export async function registerDaemonSealingKey(
  store: SealingKeyRegistrationStore,
  serverId: string,
  body: unknown
): Promise<SealingKeyRegistrationResult> {
  const registration = parseSealingKeyRegistration(body)
  if (!registration) {
    return { status: 400, body: { ok: false, error: 'kid, pub and sig are required' } }
  }
  const publicJwk = await store.loadDaemonPublicJwk(serverId)
  if (!publicJwk || !(await verifySealingKeyRegistration(publicJwk, registration))) {
    return { status: 400, body: { ok: false, error: 'sealing key signature invalid' } }
  }
  await store.save(serverId, {
    kid: registration.kid,
    pub: registration.pub,
    reportedAt: new Date().toISOString(),
  })
  return { status: 200, body: { ok: true, kid: registration.kid } }
}
