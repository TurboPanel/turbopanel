/**
 * Release-manifest signature check for the control plane.
 *
 * The daemon and the installer already refuse an unsigned or foreign manifest.
 * The control plane reads the same manifests to decide what to show and what
 * to schedule, so it verifies them with the same pinned public key before it
 * uses a single field (audit M6). Mirror of turbopaneld `src/update/signing.ts`:
 * keep the canonical form byte-identical (keys sorted by code unit, no
 * whitespace, `signature` removed, non-ASCII unescaped, UTF-8) and keep the
 * pinned key equal to the daemon's `RELEASE_SIGNING_PUBLIC_KEY_HEX`.
 *
 * Workers and Deno both import this module: WebCrypto only.
 */

/** Raw 32-byte Ed25519 public key of the release signing key, hex (public). */
export const RELEASE_SIGNING_PUBLIC_KEY_HEX =
  'e854267676c6700a79ff19b89211b76d609af142f4c2c1cb011339346d1cea0a'

/** Why a manifest was refused. Stable codes: logs and the refusal accessor use them. */
export type ManifestRefusalCode =
  | 'manifest_unsigned'
  | 'manifest_signature_malformed'
  | 'manifest_signature_invalid'
  | 'manifest_replayed'

export class ManifestRefusedError extends Error {
  constructor(
    readonly code: ManifestRefusalCode,
    message: string
  ) {
    super(message)
    this.name = 'ManifestRefusedError'
  }
}

const ED25519 = { name: 'Ed25519' } as const
const SIGNATURE_BYTES = 64
const PUBLIC_KEY_BYTES = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted(compareCodeUnits)
    const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

/** The bytes a signature covers: the manifest without `signature`, canonicalised. */
export function canonicalManifestBytes(manifest: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const { signature: _signature, ...unsigned } = manifest
  const encoded = new TextEncoder().encode(canonicalize(unsigned))
  const copy = new Uint8Array(new ArrayBuffer(encoded.length))
  copy.set(encoded)
  return copy
}

function decodeHex(hex: string): Uint8Array<ArrayBuffer> | null {
  const clean = hex.trim()
  if (!/^(?:[\da-f]{2})+$/i.test(clean)) return null
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.trim())
    const out = new Uint8Array(new ArrayBuffer(binary.length))
    out.set(Array.from(binary, (char) => char.codePointAt(0) ?? 0))
    return out
  } catch {
    return null
  }
}

function malformed(message: string): ManifestRefusedError {
  return new ManifestRefusedError('manifest_signature_malformed', message)
}

function readSignatureValue(raw: unknown): string {
  if (raw === undefined || raw === null) {
    throw new ManifestRefusedError(
      'manifest_unsigned',
      'channel manifest is unsigned (missing signature)'
    )
  }
  if (!isRecord(raw) || raw.alg !== 'ed25519') {
    throw malformed('channel manifest signature must be an ed25519 object')
  }
  if (typeof raw.value !== 'string' || raw.value.trim() === '') {
    throw malformed('channel manifest signature missing value')
  }
  return raw.value
}

/**
 * Verify a manifest's embedded signature against the pinned release key.
 * Throws {@link ManifestRefusedError} (fail closed) on a missing, malformed or
 * invalid signature; resolves only when the pinned key signed these exact bytes.
 */
export async function verifyManifestSignature(
  manifest: Record<string, unknown>,
  publicKeyHex: string = RELEASE_SIGNING_PUBLIC_KEY_HEX
): Promise<void> {
  const sig = decodeBase64(readSignatureValue(manifest.signature))
  if (sig?.length !== SIGNATURE_BYTES) {
    throw malformed(`channel manifest signature must be ${SIGNATURE_BYTES} base64 bytes`)
  }
  const raw = decodeHex(publicKeyHex)
  if (raw?.length !== PUBLIC_KEY_BYTES) {
    throw malformed('release public key is not a 32-byte hex key')
  }
  const key = await crypto.subtle.importKey('raw', raw, ED25519, false, ['verify'])
  const ok = await crypto.subtle.verify(ED25519, key, sig, canonicalManifestBytes(manifest))
  if (!ok) {
    throw new ManifestRefusedError(
      'manifest_signature_invalid',
      'channel manifest signature is invalid for the pinned release key'
    )
  }
}
