/**
 * Mint a short-lived self-signed RSA leaf for org TLS library `self_signed` source.
 * Workers + Deno safe (Web Crypto only).
 */

import { encodePemBlock } from './pem.ts'
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

function ia5(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  return concat(Uint8Array.of(0x16), encLen(encoded.length), encoded)
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

const OID_CN = Uint8Array.of(0x55, 0x04, 0x03)
const OID_RSA_ENCRYPTION = Uint8Array.of(
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

function rdnCn(cn: string): Uint8Array {
  return set(seq(concat(oid(OID_CN), utf8(cn))))
}

function algorithmIdentifier(oidBytes: Uint8Array): Uint8Array {
  return seq(concat(oid(oidBytes), Uint8Array.of(0x05, 0x00)))
}

function buildSanExtension(dnsNames: string[]): Uint8Array {
  const generals = concat(
    ...dnsNames.map((name) => {
      const encoded = new TextEncoder().encode(name)
      return contextPrimitive(2, encoded)
    }),
  )
  const generalNames = seq(generals)
  const extnValue = octetString(generalNames)
  return seq(concat(oid(OID_SAN), Uint8Array.of(0x01, 0x01, 0xff), extnValue))
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

  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )

  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  )

  const now = new Date()
  const notBefore = new Date(now.getTime() - 60_000)
  const validDays = opts?.validDays ?? 90
  const notAfter = new Date(now.getTime() + validDays * 86_400_000)
  const cn = opts?.commonName ?? names[0]!

  const serial = new Uint8Array(8)
  crypto.getRandomValues(serial)

  const version = context(0, integer(Uint8Array.of(0x02)))
  const serialInt = integer(serial)
  const sigAlg = algorithmIdentifier(OID_SHA256_RSA)
  const issuer = seq(rdnCn(cn))
  const validity = seq(concat(utctime(notBefore), utctime(notAfter)))
  const subject = seq(rdnCn(cn))
  // subjectPublicKeyInfo is already a full SEQUENCE TLV from export
  const extensions = context(3, seq(buildSanExtension(names)))

  const tbs = seq(
    concat(version, serialInt, sigAlg, issuer, validity, subject, spki, extensions),
  )

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      keyPair.privateKey,
      new Uint8Array(tbs),
    ),
  )
  // BIT STRING: unused bits byte + signature
  const sigBitString = concat(
    Uint8Array.of(0x03),
    encLen(signature.length + 1),
    Uint8Array.of(0x00),
    signature,
  )

  const certDer = seq(concat(tbs, algorithmIdentifier(OID_SHA256_RSA), sigBitString))
  const certificatePem = encodePemBlock('CERTIFICATE', certDer)
  const privateKeyPem = encodePemBlock('PRIVATE KEY', pkcs8)
  const parsed = await parseCertificatePem(certificatePem)

  return { certificatePem, privateKeyPem, parsed }
}
