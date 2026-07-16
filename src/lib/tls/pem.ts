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
  const b64 = normalized
    .slice(afterBegin, endIdx)
    .replaceAll(/\s+/g, '')
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
  const re =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
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
 * Accepts PKCS#8 PRIVATE KEY or PKCS#1 RSA PRIVATE KEY (wrapped as PKCS#8).
 */
export function decodePrivateKeyToPkcs8(pem: string): {
  pkcs8: Uint8Array
  algorithm: 'rsa' | 'ec' | 'okp'
} {
  const normalized = normalizePem(pem)
  if (normalized.includes('BEGIN PRIVATE KEY')) {
    const pkcs8 = decodePemBlock(normalized, 'PRIVATE KEY')
    return { pkcs8, algorithm: detectPkcs8Algorithm(pkcs8) }
  }
  if (normalized.includes('BEGIN RSA PRIVATE KEY')) {
    const rsaDer = decodePemBlock(normalized, 'RSA PRIVATE KEY')
    return { pkcs8: wrapRsaPkcs1AsPkcs8(rsaDer), algorithm: 'rsa' }
  }
  if (normalized.includes('BEGIN EC PRIVATE KEY')) {
    throw new PemError('EC PRIVATE KEY (SEC1) PEM is not supported; use PKCS#8')
  }
  throw new PemError('unsupported private key PEM label')
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
  const rsaOid = Uint8Array.of(
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
  )
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
  return Uint8Array.of(
    0x83,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  )
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
