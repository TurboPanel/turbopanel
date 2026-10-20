/**
 * The private key formats Caddy actually writes (ECDSA as SEC1, RSA as
 * PKCS#1), made by the openssl command line, must be read, matched against
 * their certificate and normalised to PKCS#8 without losing the key.
 */

import { assertEquals, assertThrows } from '@std/assert'
import {
  type CaddyKeyKind,
  makeCaddyPair,
} from '../../test-fixtures/caddy-key-fixtures.test.support.ts'
import { privateKeyMatchesCertificate } from './keys.ts'
import { parseCertificatePem } from './parse.ts'
import { decodePrivateKeyToPkcs8, normalizePrivateKeyPem, PemError } from './pem.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WRITTEN_LABEL: Record<Exclude<CaddyKeyKind, 'ec-secp256k1'>, string> = {
  'ec-p256': 'EC PRIVATE KEY',
  'ec-p384': 'EC PRIVATE KEY',
  'ec-p521': 'EC PRIVATE KEY',
  'rsa-pkcs1': 'RSA PRIVATE KEY',
  'ec-p256-pkcs8': 'PRIVATE KEY',
}

for (const kind of Object.keys(WRITTEN_LABEL) as (keyof typeof WRITTEN_LABEL)[]) {
  test(`a ${kind} key as the writer stores it is read, matched and normalised to PKCS#8`, async () => {
    const pair = await makeCaddyPair(kind, ['shop.example.com'])
    assertEquals(pair.privateKeyPem.startsWith(`-----BEGIN ${WRITTEN_LABEL[kind]}-----`), true)
    const leaf = await parseCertificatePem(pair.certificatePem)

    // As written, and after normalising, it proves possession of the leaf key.
    assertEquals(await privateKeyMatchesCertificate(pair.privateKeyPem, leaf), true)
    const normalized = normalizePrivateKeyPem(pair.privateKeyPem)
    assertEquals(normalized.startsWith('-----BEGIN PRIVATE KEY-----'), true)
    assertEquals(await privateKeyMatchesCertificate(normalized, leaf), true)

    // Normalising twice changes nothing, and the algorithm is recognised.
    assertEquals(normalizePrivateKeyPem(normalized), normalized)
    assertEquals(
      decodePrivateKeyToPkcs8(pair.privateKeyPem).algorithm,
      kind.startsWith('rsa') ? 'rsa' : 'ec'
    )
  })
}

test('a key from a different pair does not match, in every written form', async () => {
  const [a, b] = await Promise.all([
    makeCaddyPair('ec-p256', ['shop.example.com']),
    makeCaddyPair('ec-p256', ['shop.example.com']),
  ])
  const leaf = await parseCertificatePem(a.certificatePem)
  assertEquals(await privateKeyMatchesCertificate(b.privateKeyPem, leaf), false)
  assertEquals(
    await privateKeyMatchesCertificate(normalizePrivateKeyPem(b.privateKeyPem), leaf),
    false
  )
})

test('a curve outside P-256, P-384 and P-521 is refused in plain words', async () => {
  const pair = await makeCaddyPair('ec-secp256k1', ['shop.example.com'])
  assertThrows(() => normalizePrivateKeyPem(pair.privateKeyPem), PemError, 'not supported')
})

test('a damaged SEC1 key is refused without a crash', async () => {
  const pair = await makeCaddyPair('ec-p256', ['shop.example.com'])
  const lines = pair.privateKeyPem.trim().split('\n')
  const cut = [lines[0], lines[1]!.slice(0, 20), lines.at(-1)].join('\n')
  assertThrows(() => normalizePrivateKeyPem(cut), PemError)
})
