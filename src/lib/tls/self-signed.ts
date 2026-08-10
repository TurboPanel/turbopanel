/**
 * Mint short-lived self-signed RSA leaves and organization CA material for the
 * org TLS library. Workers + Deno safe (Web Crypto only).
 */

import {
  children,
  content,
  expectTag,
  readNode,
  type Asn1Node,
} from './asn1.ts'
import { decodeFirstCertificate, decodePrivateKeyToPkcs8, encodePemBlock } from './pem.ts'
import { parseCertificatePem } from './parse.ts'
import type { ParsedCertificate } from './types.ts'

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

function encLen(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length)
  if (length <= 0xff) return Uint8Array.of(0x81, length)
  return Uint8Array.of(0x82, (length >> 8) & 0xff, length & 0xff)
}

function seq(contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x30), encLen(contentBytes.length), contentBytes)
}

function set(contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x31), encLen(contentBytes.length), contentBytes)
}

function integer(bytes: Uint8Array): Uint8Array {
  let value = bytes
  if (value.length === 0 || (value[0]! & 0x80) !== 0) {
    value = concat(Uint8Array.of(0x00), value)
  }
  return concat(Uint8Array.of(0x02), encLen(value.length), value)
}

function octetString(bytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x04), encLen(bytes.length), bytes)
}

function oid(contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x06), encLen(contentBytes.length), contentBytes)
}

function utf8(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  return concat(Uint8Array.of(0x0c), encLen(encoded.length), encoded)
}

function utctime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, '0')
  const yy = pad(date.getUTCFullYear() % 100)
  const text =
    `${yy}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  const encoded = new TextEncoder().encode(text)
  return concat(Uint8Array.of(0x17), encLen(encoded.length), encoded)
}

function context(tag: number, contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0xa0 | tag), encLen(contentBytes.length), contentBytes)
}

function contextPrimitive(tag: number, contentBytes: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x80 | tag), encLen(contentBytes.length), contentBytes)
}

function boolean(value: boolean): Uint8Array {
  return Uint8Array.of(0x01, 0x01, value ? 0xff : 0x00)
}

function bitString(bits: Uint8Array, unusedBits = 0): Uint8Array {
  return concat(
    Uint8Array.of(0x03),
    encLen(bits.length + 1),
    Uint8Array.of(unusedBits),
    bits,
  )
}

const OID_CN = Uint8Array.of(0x55, 0x04, 0x03)
const OID_SHA256_RSA = Uint8Array.of(
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x0b,
)
const OID_SAN = Uint8Array.of(0x55, 0x1d, 0x11)
/** 2.5.29.19 basicConstraints */
const OID_BASIC_CONSTRAINTS = Uint8Array.of(0x55, 0x1d, 0x13)
/** 2.5.29.15 keyUsage */
const OID_KEY_USAGE = Uint8Array.of(0x55, 0x1d, 0x0f)
/** 2.5.29.37 extKeyUsage */
const OID_EXT_KEY_USAGE = Uint8Array.of(0x55, 0x1d, 0x25)
/** 1.3.6.1.5.5.7.3.1 id-kp-serverAuth */
const OID_SERVER_AUTH = Uint8Array.of(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)
/** 1.3.6.1.5.5.7.3.2 id-kp-clientAuth */
const OID_CLIENT_AUTH = Uint8Array.of(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02)

/** RFC 5280 keyUsage bit positions (MSB of first byte = bit 0). */
export const KEY_USAGE_DIGITAL_SIGNATURE = 0
export const KEY_USAGE_KEY_ENCIPHERMENT = 2
export const KEY_USAGE_KEY_CERT_SIGN = 5
export const KEY_USAGE_CRL_SIGN = 6

function rdnCn(cn: string): Uint8Array {
  return set(seq(concat(oid(OID_CN), utf8(cn))))
}

function algorithmIdentifier(oidBytes: Uint8Array): Uint8Array {
  return seq(concat(oid(oidBytes), Uint8Array.of(0x05, 0x00)))
}

function encodeIpAddress(address: string): Uint8Array | null {
  const trimmed = address.trim()
  // IPv4 only — managed private listeners are IPv4 literals today.
  const v4 = trimmed.split('.')
  if (v4.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i += 1) {
    const part = v4[i]!
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    bytes[i] = n
  }
  return bytes
}

function buildSanExtension(opts: {
  dnsNames: readonly string[]
  ipAddresses?: readonly string[]
}): Uint8Array {
  const generals: Uint8Array[] = []
  for (const name of opts.dnsNames) {
    const encoded = new TextEncoder().encode(name)
    // dNSName [2] IA5String
    generals.push(contextPrimitive(2, encoded))
  }
  for (const raw of opts.ipAddresses ?? []) {
    const ipBytes = encodeIpAddress(raw)
    if (ipBytes === null) {
      throw new TypeError(`invalid IP address for SAN: ${raw}`)
    }
    // iPAddress [7] OCTET STRING
    generals.push(contextPrimitive(7, ipBytes))
  }
  if (generals.length === 0) {
    throw new TypeError('at least one DNS name or IP address is required for SAN')
  }
  const generalNames = seq(concat(...generals))
  const extnValue = octetString(generalNames)
  return seq(concat(oid(OID_SAN), Uint8Array.of(0x01, 0x01, 0xff), extnValue))
}

/**
 * Build a basicConstraints extension (critical).
 * When `ca` is true, pathLen may optionally limit intermediate depth.
 */
export function buildBasicConstraintsExtension(opts: {
  ca: boolean
  pathLen?: number
}): Uint8Array {
  const innerParts: Uint8Array[] = []
  if (opts.ca) {
    innerParts.push(boolean(true))
    if (opts.pathLen !== undefined) {
      innerParts.push(integer(Uint8Array.of(opts.pathLen & 0xff)))
    }
  } else {
    innerParts.push(boolean(false))
  }
  const value = seq(concat(...innerParts))
  return seq(
    concat(
      oid(OID_BASIC_CONSTRAINTS),
      Uint8Array.of(0x01, 0x01, 0xff),
      octetString(value),
    ),
  )
}

/**
 * Build a keyUsage extension from RFC 5280 bit positions (0–8).
 * Critical, as typical for CAs and server certs that set KU.
 */
export function buildKeyUsageExtension(bits: readonly number[]): Uint8Array {
  if (bits.length === 0) {
    throw new TypeError('at least one keyUsage bit is required')
  }
  let highest = 0
  for (const bit of bits) {
    if (bit < 0 || bit > 15) {
      throw new TypeError(`keyUsage bit out of range: ${bit}`)
    }
    highest = Math.max(highest, bit)
  }
  const byteLen = Math.floor(highest / 8) + 1
  const usageBytes = new Uint8Array(byteLen)
  for (const bit of bits) {
    const byteIndex = Math.floor(bit / 8)
    const bitInByte = 7 - (bit % 8)
    usageBytes[byteIndex]! |= 1 << bitInByte
  }
  const unusedBits = 7 - (highest % 8)
  return seq(
    concat(
      oid(OID_KEY_USAGE),
      Uint8Array.of(0x01, 0x01, 0xff),
      octetString(bitString(usageBytes, unusedBits)),
    ),
  )
}

function buildExtendedKeyUsageExtension(
  purposes: readonly Uint8Array[],
): Uint8Array {
  const purposeSeq = seq(concat(...purposes.map((p) => oid(p))))
  return seq(
    concat(oid(OID_EXT_KEY_USAGE), octetString(purposeSeq)),
  )
}

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
}

function randomSerial(): Uint8Array {
  const serial = new Uint8Array(8)
  crypto.getRandomValues(serial)
  return serial
}

function validityWindow(validDays: number): { notBefore: Date; notAfter: Date } {
  const now = new Date()
  return {
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + validDays * 86_400_000),
  }
}

function signBitString(signature: Uint8Array): Uint8Array {
  return concat(
    Uint8Array.of(0x03),
    encLen(signature.length + 1),
    Uint8Array.of(0x00),
    signature,
  )
}

async function assembleCertificate(
  tbs: Uint8Array,
  signingKey: CryptoKey,
): Promise<{ certificatePem: string; certDer: Uint8Array }> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      signingKey,
      new Uint8Array(tbs),
    ),
  )
  const certDer = seq(
    concat(tbs, algorithmIdentifier(OID_SHA256_RSA), signBitString(signature)),
  )
  return {
    certificatePem: encodePemBlock('CERTIFICATE', certDer),
    certDer,
  }
}

/** Full Name DER TLV (SEQUENCE of RDNs) from a certificate PEM. */
export function extractSubjectNameDer(certificatePem: string): Uint8Array {
  const leafDer = decodeFirstCertificate(certificatePem)
  const cert = readNode(leafDer, 0)
  expectTag(cert, 0x30, 'Certificate')
  const tbs = children(cert)[0]
  if (!tbs) throw new TypeError('empty certificate')
  expectTag(tbs, 0x30, 'TBSCertificate')
  const tbsChildren = children(tbs)
  let idx = 0
  if (tbsChildren[0]?.tag === 0xa0) idx = 1
  if (tbsChildren.length < idx + 6) {
    throw new TypeError('truncated TBSCertificate')
  }
  const subjectNode = tbsChildren[idx + 4]!
  return leafDer.subarray(
    subjectNode.contentOffset - subjectNode.headerLength,
    subjectNode.end,
  )
}

/** Full subjectPublicKeyInfo DER TLV from a leaf certificate PEM. */
export function extractSpkiDer(certificatePem: string): Uint8Array {
  const leafDer = decodeFirstCertificate(certificatePem)
  const cert = readNode(leafDer, 0)
  expectTag(cert, 0x30, 'Certificate')
  const tbs = children(cert)[0]
  if (!tbs) throw new TypeError('empty certificate')
  const tbsChildren = children(tbs)
  let idx = 0
  if (tbsChildren[0]?.tag === 0xa0) idx = 1
  const spkiNode = tbsChildren[idx + 5]!
  return leafDer.subarray(
    spkiNode.contentOffset - spkiNode.headerLength,
    spkiNode.end,
  )
}

/** Whether an extension OID appears with a critical-flag style presentation. */
function extensionNodes(leafDer: Uint8Array): Asn1Node[] {
  const cert = readNode(leafDer, 0)
  const tbs = children(cert)[0]
  if (!tbs) return []
  const tbsChildren = children(tbs)
  let idx = 0
  if (tbsChildren[0]?.tag === 0xa0) idx = 1
  for (let i = idx + 6; i < tbsChildren.length; i += 1) {
    const node = tbsChildren[i]!
    if (node.tag !== 0xa3) continue
    const extSeq = children(node)[0]
    if (!extSeq) return []
    return children(extSeq)
  }
  return []
}

function readOidBytes(oidNode: Asn1Node): string {
  const raw = content(oidNode)
  // Minimal OID path decode for known short OIDs used in tests.
  const parts: number[] = []
  if (raw.length === 0) return ''
  parts.push(Math.floor(raw[0]! / 40), raw[0]! % 40)
  let value = 0
  for (let i = 1; i < raw.length; i += 1) {
    value = (value << 7) | (raw[i]! & 0x7f)
    if ((raw[i]! & 0x80) === 0) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

/**
 * Find the OCTET STRING value node of the extension matching `oidDotted`
 * (handling the optional intervening `critical` BOOLEAN), or `null` when the
 * extension is absent.
 */
function findExtensionValueNode(
  leafDer: Uint8Array,
  oidDotted: string,
): Asn1Node | null {
  for (const ext of extensionNodes(leafDer)) {
    const kids = children(ext)
    if (kids.length < 2) continue
    if (readOidBytes(kids[0]!) !== oidDotted) continue
    return kids[1]!.tag === 0x01 ? kids[2]! : kids[1]!
  }
  return null
}

/**
 * Parse basicConstraints CA flag from a leaf PEM (defaults false when absent).
 */
export function readBasicConstraintsCa(certificatePem: string): boolean {
  const leafDer = decodeFirstCertificate(certificatePem)
  const valueNode = findExtensionValueNode(leafDer, '2.5.29.19')
  if (!valueNode) return false
  expectTag(valueNode, 0x04, 'basicConstraints OCTET STRING')
  const inner = readNode(content(valueNode), 0)
  expectTag(inner, 0x30, 'BasicConstraints')
  const fields = children(inner)
  if (fields.length === 0 || fields[0]!.tag !== 0x01) return false
  return content(fields[0]!)[0] === 0xff
}

/** Decode the set bit positions from a parsed keyUsage BIT STRING node. */
function parseKeyUsageBitString(bitStringNode: Asn1Node): number[] {
  const raw = content(bitStringNode)
  if (raw.length < 1) return []
  const unused = raw[0]!
  const usageBytes = raw.subarray(1)
  const bits: number[] = []
  for (let byteIndex = 0; byteIndex < usageBytes.length; byteIndex += 1) {
    const byte = usageBytes[byteIndex]!
    const lastByteUnusedFrom = byteIndex === usageBytes.length - 1 ? 8 - unused : 8
    for (let bitInByte = 0; bitInByte < lastByteUnusedFrom; bitInByte += 1) {
      if ((byte & (1 << (7 - bitInByte))) !== 0) {
        bits.push(byteIndex * 8 + bitInByte)
      }
    }
  }
  return bits
}

/**
 * Parse keyUsage bit string from a leaf PEM; returns null when absent.
 */
export function readKeyUsageBits(certificatePem: string): number[] | null {
  const leafDer = decodeFirstCertificate(certificatePem)
  const valueNode = findExtensionValueNode(leafDer, '2.5.29.15')
  if (!valueNode) return null
  expectTag(valueNode, 0x04, 'keyUsage OCTET STRING')
  const bitStringNode = readNode(content(valueNode), 0)
  expectTag(bitStringNode, 0x03, 'keyUsage BIT STRING')
  return parseKeyUsageBitString(bitStringNode)
}

/**
 * Verify that leaf cert was signed by the CA public key (RSASSA-PKCS1-v1_5).
 */
export async function verifyCertificateSignature(
  leafCertificatePem: string,
  caCertificatePem: string,
): Promise<boolean> {
  const leafDer = decodeFirstCertificate(leafCertificatePem)
  const cert = readNode(leafDer, 0)
  expectTag(cert, 0x30, 'Certificate')
  const certChildren = children(cert)
  if (certChildren.length < 3) return false
  const tbs = certChildren[0]!
  const sigNode = certChildren[2]!
  expectTag(sigNode, 0x03, 'signatureValue')
  const sigContent = content(sigNode)
  // First byte is unused-bits count.
  const signature = sigContent.subarray(1)
  const tbsDer = leafDer.subarray(
    tbs.contentOffset - tbs.headerLength,
    tbs.end,
  )
  const caSpki = extractSpkiDer(caCertificatePem)
  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      asBufferSource(caSpki),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      asBufferSource(signature),
      asBufferSource(tbsDer),
    )
  } catch {
    return false
  }
}

async function importRsaPrivateKeyFromPem(
  privateKeyPem: string,
): Promise<CryptoKey> {
  const decoded = decodePrivateKeyToPkcs8(privateKeyPem)
  if (decoded.algorithm !== 'rsa') {
    throw new TypeError('organization CA private key must be RSA')
  }
  return crypto.subtle.importKey(
    'pkcs8',
    asBufferSource(decoded.pkcs8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export type SelfSignedMaterial = {
  certificatePem: string
  privateKeyPem: string
  parsed: ParsedCertificate
}

/**
 * Generate RSA-2048 self-signed cert covering `dnsNames` (validity ~90 days).
 */
export async function mintSelfSignedCertificate(
  dnsNames: string[],
  opts?: { validDays?: number; commonName?: string },
): Promise<SelfSignedMaterial> {
  const names = dnsNames
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
  if (names.length === 0) {
    throw new TypeError('at least one DNS name is required')
  }

  const keyPair = await generateRsaKeyPair()
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  )

  const validDays = opts?.validDays ?? 90
  const { notBefore, notAfter } = validityWindow(validDays)
  const cn = opts?.commonName ?? names[0]!

  const version = context(0, integer(Uint8Array.of(0x02)))
  const serialInt = integer(randomSerial())
  const sigAlg = algorithmIdentifier(OID_SHA256_RSA)
  const issuer = seq(rdnCn(cn))
  const validity = seq(concat(utctime(notBefore), utctime(notAfter)))
  const subject = seq(rdnCn(cn))
  const extensions = context(3, seq(buildSanExtension({ dnsNames: names })))

  const tbs = seq(
    concat(version, serialInt, sigAlg, issuer, validity, subject, spki, extensions),
  )

  const { certificatePem } = await assembleCertificate(tbs, keyPair.privateKey)
  const privateKeyPem = encodePemBlock('PRIVATE KEY', pkcs8)
  const parsed = await parseCertificatePem(certificatePem)

  return { certificatePem, privateKeyPem, parsed }
}

/**
 * Mint a self-signed organization CA (RSA-2048, CA:TRUE, 3650-day default).
 */
export async function mintOrganizationCa(opts?: {
  commonName?: string
  validDays?: number
}): Promise<SelfSignedMaterial> {
  const keyPair = await generateRsaKeyPair()
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  )

  const validDays = opts?.validDays ?? 3650
  const { notBefore, notAfter } = validityWindow(validDays)
  const cn = opts?.commonName ?? 'TurboPanel Organization CA'

  const version = context(0, integer(Uint8Array.of(0x02)))
  const serialInt = integer(randomSerial())
  const sigAlg = algorithmIdentifier(OID_SHA256_RSA)
  const nameDer = seq(rdnCn(cn))
  const validity = seq(concat(utctime(notBefore), utctime(notAfter)))
  const extensions = context(
    3,
    seq(
      concat(
        buildBasicConstraintsExtension({ ca: true, pathLen: 0 }),
        buildKeyUsageExtension([
          KEY_USAGE_KEY_CERT_SIGN,
          KEY_USAGE_CRL_SIGN,
        ]),
      ),
    ),
  )

  const tbs = seq(
    concat(
      version,
      serialInt,
      sigAlg,
      nameDer,
      validity,
      nameDer,
      spki,
      extensions,
    ),
  )

  const { certificatePem } = await assembleCertificate(tbs, keyPair.privateKey)
  const privateKeyPem = encodePemBlock('PRIVATE KEY', pkcs8)
  const parsed = await parseCertificatePem(certificatePem)

  return { certificatePem, privateKeyPem, parsed }
}

/**
 * Issue a server leaf certificate signed by an organization CA.
 *
 * `dnsNames` supplies DNS SANs. Optional `ipAddresses` adds iPAddress SANs so
 * clients that dial a private listener IP with verify-identity can match.
 */
export async function issueLeafCertificate(
  caCertPem: string,
  caPrivateKeyPem: string,
  dnsNames: string[],
  opts?: {
    validDays?: number
    commonName?: string
    includeClientAuth?: boolean
    ipAddresses?: readonly string[]
  },
): Promise<SelfSignedMaterial> {
  const names = dnsNames
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
  if (names.length === 0) {
    throw new TypeError('at least one DNS name is required')
  }
  const ipAddresses = uniqueIpAddresses(opts?.ipAddresses ?? [])

  const keyPair = await generateRsaKeyPair()
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  )
  const caSigningKey = await importRsaPrivateKeyFromPem(caPrivateKeyPem)
  const issuerNameDer = extractSubjectNameDer(caCertPem)

  const validDays = opts?.validDays ?? 90
  const { notBefore, notAfter } = validityWindow(validDays)
  const cn = opts?.commonName ?? names[0]!

  const ekuOids = [OID_SERVER_AUTH]
  if (opts?.includeClientAuth) {
    ekuOids.push(OID_CLIENT_AUTH)
  }

  const version = context(0, integer(Uint8Array.of(0x02)))
  const serialInt = integer(randomSerial())
  const sigAlg = algorithmIdentifier(OID_SHA256_RSA)
  const validity = seq(concat(utctime(notBefore), utctime(notAfter)))
  const subject = seq(rdnCn(cn))
  const extensions = context(
    3,
    seq(
      concat(
        buildBasicConstraintsExtension({ ca: false }),
        buildKeyUsageExtension([
          KEY_USAGE_DIGITAL_SIGNATURE,
          KEY_USAGE_KEY_ENCIPHERMENT,
        ]),
        buildExtendedKeyUsageExtension(ekuOids),
        buildSanExtension({ dnsNames: names, ipAddresses }),
      ),
    ),
  )

  const tbs = seq(
    concat(
      version,
      serialInt,
      sigAlg,
      issuerNameDer,
      validity,
      subject,
      spki,
      extensions,
    ),
  )

  const { certificatePem } = await assembleCertificate(tbs, caSigningKey)
  const privateKeyPem = encodePemBlock('PRIVATE KEY', pkcs8)
  const parsed = await parseCertificatePem(certificatePem)

  return { certificatePem, privateKeyPem, parsed }
}

function uniqueIpAddresses(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (encodeIpAddress(trimmed) === null) {
      throw new TypeError(`invalid IP address for SAN: ${trimmed}`)
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}
