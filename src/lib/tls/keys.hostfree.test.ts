/**
 * Host-free EC / Ed25519 private-key match paths (RSA covered by tls.test.ts).
 */

import { assertEquals, assertRejects } from '@std/assert'
import { privateKeyMatchesCertificate, TlsKeyError } from './keys.ts'
import { encodePemBlock } from './pem.ts'
import type { ParsedCertificate } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function stubParsed(spkiDer: Uint8Array): ParsedCertificate {
  return {
    dnsNames: ['ec.example.com'],
    ipAddresses: [],
    hasWildcard: false,
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2027-01-01T00:00:00.000Z'),
    fingerprintSha256: 'a'.repeat(64),
    subject: 'CN=ec.example.com',
    issuer: 'CN=ec.example.com',
    leafDer: new Uint8Array(),
    spkiDer,
  }
}

async function mintEcMaterial(namedCurve: 'P-256' | 'P-384' = 'P-256') {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  )
  const spki = new Uint8Array(
    await crypto.subtle.exportKey('spki', pair.publicKey),
  )
  return {
    privateKeyPem: encodePemBlock('PRIVATE KEY', pkcs8),
    parsed: stubParsed(spki),
  }
}

test('privateKeyMatchesCertificate verifies an EC P-256 key against its SPKI', async () => {
  const material = await mintEcMaterial('P-256')
  assertEquals(
    await privateKeyMatchesCertificate(material.privateKeyPem, material.parsed),
    true,
  )
})

test('privateKeyMatchesCertificate returns false for mismatched EC keys', async () => {
  const first = await mintEcMaterial('P-256')
  const second = await mintEcMaterial('P-256')
  assertEquals(
    await privateKeyMatchesCertificate(second.privateKeyPem, first.parsed),
    false,
  )
})

test('privateKeyMatchesCertificate verifies Ed25519 when the runtime supports it', async () => {
  let pair: CryptoKeyPair
  try {
    pair = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]) as CryptoKeyPair
  } catch {
    // Runtime without Ed25519 — skip without failing the suite.
    return
  }
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  )
  const spki = new Uint8Array(
    await crypto.subtle.exportKey('spki', pair.publicKey),
  )
  assertEquals(
    await privateKeyMatchesCertificate(
      encodePemBlock('PRIVATE KEY', pkcs8),
      stubParsed(spki),
    ),
    true,
  )
})

test('privateKeyMatchesCertificate wraps EC import exhaustion as TlsKeyError', async () => {
  // PKCS#8 with EC OID but garbage key bytes so every namedCurve import fails.
  const bogusEcPkcs8 = Uint8Array.from([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x04, 0x14,
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13,
  ])
  await assertRejects(
    () =>
      privateKeyMatchesCertificate(
        encodePemBlock('PRIVATE KEY', bogusEcPkcs8),
        stubParsed(new Uint8Array([1, 2, 3])),
      ),
    TlsKeyError,
  )
})
