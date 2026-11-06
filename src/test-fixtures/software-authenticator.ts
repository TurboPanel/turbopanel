/**
 * Test-only software authenticator for rotation passkeys: fresh keys per run
 * (nothing secret is stored), assertions shaped exactly like a browser's
 * `navigator.credentials.get` response. Never imported from production code.
 */
import { base64urlEncode } from '../lib/encoding/base64url.ts'
import type {
  KeysetApproval,
  RotationPasskey,
  RotationPasskeyAlg,
} from '../lib/panel-identity/keyset-statement.ts'

const encoder = new TextEncoder()

export type SoftPasskey = {
  passkey: RotationPasskey
  privateKey: CryptoKey
}

export type AssertOptions = {
  rpId: string
  challenge: string
  origin?: string
  flags?: number
  type?: string
  crossOrigin?: boolean
  /** Sign with this key instead (a forged approval under the passkey's id). */
  signWith?: SoftPasskey
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** DER INTEGER body of one 32-byte big-endian component (minimal, positive). */
function derInteger(component: Uint8Array): Uint8Array {
  let start = 0
  while (start < component.length - 1 && component[start] === 0) start += 1
  const trimmed = component.subarray(start)
  const body = trimmed[0]! & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed
  return Uint8Array.of(0x02, body.length, ...body)
}

/** Raw r‖s to DER ECDSA-Sig-Value, the form authenticators send. */
export function rawEcdsaToDer(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.subarray(0, 32))
  const s = derInteger(raw.subarray(32, 64))
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s)
}

export async function createSoftPasskey(alg: RotationPasskeyAlg): Promise<SoftPasskey> {
  const pair = (
    alg === 'EdDSA'
      ? await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
      : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ])
  ) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const credentialId = crypto.getRandomValues(new Uint8Array(32))
  const id = base64urlEncode(await sha256(credentialId))
  return { passkey: { id, alg, pub: base64urlEncode(raw) }, privateKey: pair.privateKey }
}

/** One assertion by `signer` (or `options.signWith`), approving `options.challenge`. */
export async function softAssert(
  signer: SoftPasskey,
  options: AssertOptions
): Promise<KeysetApproval> {
  const rpIdHash = await sha256(encoder.encode(options.rpId))
  const authData = new Uint8Array(37)
  authData.set(rpIdHash, 0)
  authData[32] = options.flags ?? 0x05
  const clientData: Record<string, unknown> = {
    type: options.type ?? 'webauthn.get',
    challenge: options.challenge,
    origin: options.origin ?? `https://${options.rpId}`,
  }
  if (options.crossOrigin !== undefined) clientData.crossOrigin = options.crossOrigin
  const clientDataBytes = encoder.encode(JSON.stringify(clientData))
  const clientHash = await sha256(clientDataBytes)
  const signed = new Uint8Array(authData.length + clientHash.length)
  signed.set(authData, 0)
  signed.set(clientHash, authData.length)
  const key = options.signWith ?? signer
  const sig = new Uint8Array(
    key.passkey.alg === 'EdDSA'
      ? await crypto.subtle.sign('Ed25519', key.privateKey, signed as BufferSource)
      : await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          key.privateKey,
          signed as BufferSource
        )
  )
  return {
    id: signer.passkey.id,
    authenticatorData: base64urlEncode(authData),
    clientDataJSON: base64urlEncode(clientDataBytes),
    signature: base64urlEncode(key.passkey.alg === 'EdDSA' ? sig : rawEcdsaToDer(sig)),
  }
}

/** A fresh Ed25519 control plane key: its fingerprint and raw public key. */
export async function softPanelKey(): Promise<{ kid: string; pub: string }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { kid: base64urlEncode(await sha256(raw)), pub: base64urlEncode(raw) }
}
