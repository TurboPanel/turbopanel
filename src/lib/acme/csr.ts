/**
 * A PKCS#10 certificate request for an ECDSA P-256 key: an empty subject and
 * the names in a subject-alternative-name extension, which is all an ACME
 * server reads. Web Crypto only.
 */
import { decodePrivateKeyToPkcs8, encodePemBlock } from '../tls/pem.ts'

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length)
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), lengthBytes(content.length), content)
}

const sequence = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts))
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts))
const octetString = (content: Uint8Array) => tlv(0x04, content)
const oid = (content: number[]) => tlv(0x06, Uint8Array.from(content))

/** A non-negative INTEGER from big-endian bytes: no leading zeros, a sign byte when needed. */
function unsignedInteger(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1
  const trimmed = bytes.slice(start)
  const padded = (trimmed[0] ?? 0) >= 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed
  return tlv(0x02, padded)
}

/** Web Crypto signs as `r || s`; X.509 wants a DER `SEQUENCE { r, s }`. */
function derSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  return sequence(unsignedInteger(raw.slice(0, half)), unsignedInteger(raw.slice(half)))
}

const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]
const OID_EXTENSION_REQUEST = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]
const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11]

function sanExtension(names: readonly string[]): Uint8Array {
  const generalNames = sequence(...names.map((name) => tlv(0x82, encoder.encode(name))))
  return sequence(oid(OID_SUBJECT_ALT_NAME), octetString(generalNames))
}

/** The DER request for `names`, signed with `privateKey`; `spki` is its public key. */
export async function buildCertificateRequest(params: {
  privateKey: CryptoKey
  spki: Uint8Array
  names: readonly string[]
}): Promise<Uint8Array> {
  if (params.names.length === 0) throw new TypeError('a certificate request needs a name')
  const extensions = sequence(sanExtension(params.names))
  const attribute = sequence(oid(OID_EXTENSION_REQUEST), set(extensions))
  const info = sequence(
    unsignedInteger(Uint8Array.of(0)),
    sequence(),
    params.spki,
    tlv(0xa0, attribute)
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      params.privateKey,
      info as BufferSource
    )
  )
  return sequence(
    info,
    sequence(oid(OID_ECDSA_SHA256)),
    tlv(0x03, concat(Uint8Array.of(0), derSignature(signature)))
  )
}

export type CertificateKeyPair = {
  /** PKCS#8 `PRIVATE KEY` PEM, to be sealed by the caller. */
  privateKeyPem: string
  privateKey: CryptoKey
  spki: Uint8Array
}

/** A fresh ECDSA P-256 key for one certificate. */
export async function generateCertificateKey(): Promise<CertificateKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  return { privateKeyPem: encodePemBlock('PRIVATE KEY', pkcs8), privateKey: pair.privateKey, spki }
}

/** Rebuild the signing key and public key from the PEM {@link generateCertificateKey} made. */
export async function loadCertificateKey(privateKeyPem: string): Promise<CertificateKeyPair> {
  const { pkcs8 } = decodePrivateKeyToPkcs8(privateKeyPem)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  )
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  )
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))
  return { privateKeyPem, privateKey, spki }
}
