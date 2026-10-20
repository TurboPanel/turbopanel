/**
 * PEM encode/decode helpers (Workers + Deno safe).
 */

export class PemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PemError'
  }
}

function normalizePem(pem: string): string {
  return pem.replaceAll('\r\n', '\n').trim()
}

export function decodePemBlock(pem: string, label: string): Uint8Array {
  const normalized = normalizePem(pem)
  const begin = `-----BEGIN ${label}-----`
  const end = `-----END ${label}-----`
  const start = normalized.indexOf(begin)
  if (start < 0) {
    throw new PemError(`missing PEM block ${label}`)
  }
  const afterBegin = start + begin.length
  const endIdx = normalized.indexOf(end, afterBegin)
  if (endIdx < 0) {
    throw new PemError(`unterminated PEM block ${label}`)
  }
  const b64 = normalized.slice(afterBegin, endIdx).replaceAll(/\s+/g, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0
  }
  return bytes
}

export function encodePemBlock(label: string, der: Uint8Array): string {
  let binary = ''
  for (const byte of der) {
    binary += String.fromCodePoint(byte)
  }
  const b64 = btoa(binary)
  const lines: string[] = [`-----BEGIN ${label}-----`]
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64))
  }
  lines.push(`-----END ${label}-----`)
  return `${lines.join('\n')}\n`
}

/** Extract all CERTIFICATE PEM blocks (leaf first, then intermediates). */
export function splitCertificateChain(pem: string): string[] {
  const normalized = normalizePem(pem)
  const blocks: string[] = []
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  let match: RegExpExecArray | null
  while ((match = re.exec(normalized)) !== null) {
    blocks.push(`${match[0]}\n`)
  }
  if (blocks.length === 0) {
    throw new PemError('no CERTIFICATE PEM blocks found')
  }
  return blocks
}

export function decodeFirstCertificate(pem: string): Uint8Array {
  const blocks = splitCertificateChain(pem)
  return decodePemBlock(blocks[0]!, 'CERTIFICATE')
}

/**
 * Decode a private key PEM as PKCS#8 DER.
 * Accepts PKCS#8 `PRIVATE KEY`, PKCS#1 `RSA PRIVATE KEY` and SEC1
 * `EC PRIVATE KEY` (P-256, P-384, P-521); the last two are re-wrapped as
 * PKCS#8. These are the forms Caddy's certificate store writes (RSA as PKCS#1,
 * ECDSA as SEC1).
 */
export function decodePrivateKeyToPkcs8(pem: string): {
  pkcs8: Uint8Array
  algorithm: 'rsa' | 'ec' | 'okp'
} {
  const normalized = normalizePem(pem)
  if (/ENCRYPTED|Proc-Type:/.test(normalized)) {
    throw new PemError('encrypted private keys are not supported; use an unencrypted key')
  }
  if (normalized.includes('BEGIN PRIVATE KEY')) {
    const pkcs8 = decodePemBlock(normalized, 'PRIVATE KEY')
    return { pkcs8, algorithm: detectPkcs8Algorithm(pkcs8) }
  }
  if (normalized.includes('BEGIN RSA PRIVATE KEY')) {
    const rsaDer = decodePemBlock(normalized, 'RSA PRIVATE KEY')
    return { pkcs8: wrapRsaPkcs1AsPkcs8(rsaDer), algorithm: 'rsa' }
  }
  if (normalized.includes('BEGIN EC PRIVATE KEY')) {
    const sec1Der = decodePemBlock(normalized, 'EC PRIVATE KEY')
    return { pkcs8: wrapEcSec1AsPkcs8(sec1Der), algorithm: 'ec' }
  }
  throw new PemError('unsupported private key PEM label')
}

/** The key as a PKCS#8 `PRIVATE KEY` PEM, whatever supported form it arrived in. */
export function normalizePrivateKeyPem(pem: string): string {
  return encodePemBlock('PRIVATE KEY', decodePrivateKeyToPkcs8(pem).pkcs8)
}

// Named-curve OID contents (DER, without tag and length).
const CURVE_P256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07)
const CURVE_P384 = Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x22)
const CURVE_P521 = Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x23)
// id-ecPublicKey, as a complete OBJECT IDENTIFIER element.
const EC_PUBLIC_KEY_OID = Uint8Array.of(0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01)

type Tlv = { tag: number; content: Uint8Array; end: number }

/** Read one DER element at `offset` (definite lengths only, up to 3 length bytes). */
function readTlv(der: Uint8Array, offset: number): Tlv {
  if (offset + 2 > der.length) throw new PemError('malformed EC private key')
  const tag = der[offset]!
  let length = der[offset + 1]!
  let start = offset + 2
  if (length >= 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 3 || start + count > der.length) {
      throw new PemError('malformed EC private key')
    }
    length = 0
    for (let i = 0; i < count; i += 1) length = (length << 8) | der[start + i]!
    start += count
  }
  const end = start + length
  if (end > der.length) throw new PemError('malformed EC private key')
  return { tag, content: der.subarray(start, end), end }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function curveFromPrivateKeyLength(length: number): Uint8Array | null {
  if (length === 32) return CURVE_P256
  if (length === 48) return CURVE_P384
  if (length === 66) return CURVE_P521
  return null
}

/**
 * Wrap a SEC1 ECPrivateKey (RFC 5915) in a PKCS#8 PrivateKeyInfo.
 * The curve comes from the key's own parameters, or from the length of the
 * private scalar when a writer left them out; only P-256, P-384 and P-521
 * are accepted. The embedded key keeps its public point and drops the
 * parameters, which PKCS#8 carries in the algorithm identifier.
 */
function wrapEcSec1AsPkcs8(sec1Der: Uint8Array): Uint8Array {
  const top = readTlv(sec1Der, 0)
  if (top.tag !== 0x30 || top.end !== sec1Der.length) {
    throw new PemError('malformed EC private key')
  }
  const body = top.content
  const version = readTlv(body, 0)
  if (version.tag !== 0x02 || version.content.length !== 1 || version.content[0] !== 1) {
    throw new PemError('malformed EC private key')
  }
  const scalar = readTlv(body, version.end)
  if (scalar.tag !== 0x04) throw new PemError('malformed EC private key')
  let curve: Uint8Array | null = null
  let publicKeyElement: Uint8Array | null = null
  for (let offset = scalar.end; offset < body.length;) {
    const item = readTlv(body, offset)
    if (item.tag === 0xa0) {
      const oid = readTlv(item.content, 0)
      if (oid.tag === 0x30) {
        throw new PemError('explicit EC curve parameters are not supported; use a named curve')
      }
      if (oid.tag !== 0x06) throw new PemError('malformed EC private key')
      curve = oid.content
    } else if (item.tag === 0xa1) {
      publicKeyElement = body.subarray(offset, item.end)
    }
    offset = item.end
  }
  curve ??= curveFromPrivateKeyLength(scalar.content.length)
  if (curve === null || ![CURVE_P256, CURVE_P384, CURVE_P521].some((c) => sameBytes(c, curve))) {
    throw new PemError('EC private key uses a curve that is not supported (P-256, P-384, P-521)')
  }
  if (
    curveFromPrivateKeyLength(scalar.content.length) === null ||
    !sameBytes(curveFromPrivateKeyLength(scalar.content.length)!, curve)
  ) {
    throw new PemError('EC private key does not match its stated curve')
  }
  const inner = encodeSequence(
    concat(
      Uint8Array.of(0x02, 0x01, 0x01),
      encodeOctetString(scalar.content),
      publicKeyElement ?? new Uint8Array(0)
    )
  )
  const curveOid = concat(Uint8Array.of(0x06, curve.length), curve)
  const algorithm = encodeSequence(concat(EC_PUBLIC_KEY_OID, curveOid))
  return encodeSequence(
    concat(Uint8Array.of(0x02, 0x01, 0x00), algorithm, encodeOctetString(inner))
  )
}

const OID_RSA = '1.2.840.113549.1.1.1'
const OID_EC = '1.2.840.10045.2.1'
// Ed25519 algorithm OID (RFC 8410) — not an IP address.
const OID_ED25519 = '1.3.101.112' // NOSONAR typescript:S1313 — ASN.1 OID, not an IP

function detectPkcs8Algorithm(pkcs8: Uint8Array): 'rsa' | 'ec' | 'okp' {
  // PrivateKeyInfo ::= SEQUENCE { version, algorithm, privateKey }
  // Scan for known algorithm OIDs in the DER.
  if (containsOid(pkcs8, OID_RSA)) return 'rsa'
  if (containsOid(pkcs8, OID_ED25519)) return 'okp'
  if (containsOid(pkcs8, OID_EC)) return 'ec'
  throw new PemError('unrecognized PKCS#8 key algorithm')
}

function containsOid(der: Uint8Array, oid: string): boolean {
  const encoded = encodeOidContent(oid)
  outer: for (let i = 0; i <= der.length - encoded.length; i += 1) {
    for (let j = 0; j < encoded.length; j += 1) {
      if (der[i + j] !== encoded[j]) continue outer
    }
    return true
  }
  return false
}

function encodeOidContent(oid: string): Uint8Array {
  const parts = oid.split('.').map(Number)
  if (parts.length < 2) {
    throw new PemError('invalid OID')
  }
  const out: number[] = [40 * parts[0]! + parts[1]!]
  for (let i = 2; i < parts.length; i += 1) {
    let value = parts[i]!
    const stack: number[] = []
    stack.push(value & 0x7f)
    value >>= 7
    while (value > 0) {
      stack.push((value & 0x7f) | 0x80)
      value >>= 7
    }
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      out.push(stack[k]!)
    }
  }
  return new Uint8Array(out)
}

/** Wrap PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo envelope. */
function wrapRsaPkcs1AsPkcs8(rsaDer: Uint8Array): Uint8Array {
  // PrivateKeyInfo SEQUENCE {
  //   version INTEGER 0,
  //   algorithm AlgorithmIdentifier { rsaEncryption, NULL },
  //   privateKey OCTET STRING (rsaDer)
  // }
  const version = Uint8Array.of(0x02, 0x01, 0x00)
  const rsaOid = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)
  const nullParams = Uint8Array.of(0x05, 0x00)
  const algorithm = encodeSequence(concat(rsaOid, nullParams))
  const privateKey = encodeOctetString(rsaDer)
  return encodeSequence(concat(version, algorithm, privateKey))
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length)
  if (length <= 0xff) return Uint8Array.of(0x81, length)
  if (length <= 0xffff) {
    return Uint8Array.of(0x82, (length >> 8) & 0xff, length & 0xff)
  }
  return Uint8Array.of(0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff)
}

function encodeSequence(contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x30), encodeLength(contentBytes.length), contentBytes)
}

function encodeOctetString(contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x04), encodeLength(contentBytes.length), contentBytes)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
