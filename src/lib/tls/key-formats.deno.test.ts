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

// --- hand-shaped SEC1 keys: shapes other writers produce or attackers could send ---

function derOf(pem: string): Uint8Array {
  const body = pem.split('\n').filter((line) => line.length > 0 && !line.startsWith('-----'))
  return Uint8Array.from(atob(body.join('')), (c) => c.codePointAt(0)!)
}

/** The private scalar of a short (single-byte length) SEC1 key. */
function scalarOf(pem: string): Uint8Array {
  const der = derOf(pem)
  // 30 len | 02 01 01 | 04 slen scalar ...
  const at = 2 + (der[1]! >= 0x80 ? der[1]! & 0x7f : 0) + 3
  const length = der[at + 1]!
  return der.subarray(at + 2, at + 2 + length)
}

function sec1Pem(parts: number[][]): string {
  const body = parts.flat()
  const der = Uint8Array.of(0x30, body.length, ...body)
  return `-----BEGIN EC PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END EC PRIVATE KEY-----\n`
}

const OID_P384 = [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22]

test('a SEC1 key without curve parameters is placed by the length of its private scalar', async () => {
  for (const [kind, bytes] of [
    ['ec-p256', 32],
    ['ec-p384', 48],
    ['ec-p521', 66],
  ] as const) {
    const pair = await makeCaddyPair(kind, ['shop.example.com'])
    const scalar = scalarOf(pair.privateKeyPem)
    assertEquals(scalar.length, bytes)
    const bare = sec1Pem([
      [0x02, 0x01, 0x01],
      [0x04, scalar.length, ...scalar],
    ])
    const leaf = await parseCertificatePem(pair.certificatePem)
    assertEquals(await privateKeyMatchesCertificate(normalizePrivateKeyPem(bare), leaf), true, kind)
  }
})

test('a scalar whose length does not match the stated curve is refused', async () => {
  const pair = await makeCaddyPair('ec-p256', ['shop.example.com'])
  const scalar = scalarOf(pair.privateKeyPem)
  const wrong = sec1Pem([
    [0x02, 0x01, 0x01],
    [0x04, scalar.length, ...scalar],
    [0xa0, OID_P384.length, ...OID_P384],
  ])
  assertThrows(() => normalizePrivateKeyPem(wrong), PemError, 'does not match its stated curve')
  const odd = sec1Pem([
    [0x02, 0x01, 0x01],
    [0x04, 10, ...new Array(10).fill(7)],
  ])
  assertThrows(() => normalizePrivateKeyPem(odd), PemError, 'not supported')
})

test('explicit curve parameters are refused in plain words', async () => {
  const pem = await new Deno.Command('openssl', {
    args: ['ecparam', '-name', 'prime256v1', '-param_enc', 'explicit', '-genkey', '-noout'],
    stdout: 'piped',
  }).output()
  const text = new TextDecoder().decode(pem.stdout)
  assertEquals(text.includes('BEGIN EC PRIVATE KEY'), true)
  assertThrows(() => normalizePrivateKeyPem(text), PemError, 'explicit EC curve parameters')
  // Hand-shaped: [0] holds a SEQUENCE instead of an OID.
  const scalar = new Array(32).fill(1)
  const handmade = sec1Pem([
    [0x02, 0x01, 0x01],
    [0x04, 32, ...scalar],
    [0xa0, 2, 0x30, 0x00],
  ])
  assertThrows(() => normalizePrivateKeyPem(handmade), PemError, 'explicit EC curve parameters')
})

test('encrypted private keys are refused, in the old and the PKCS#8 forms', async () => {
  const pair = await makeCaddyPair('ec-p256', ['shop.example.com'])
  const lines = pair.privateKeyPem.trim().split('\n')
  const oldStyle = [
    lines[0],
    'Proc-Type: 4,ENCRYPTED',
    'DEK-Info: AES-256-CBC,00112233445566778899AABBCCDDEEFF',
    '',
    ...lines.slice(1),
  ].join('\n')
  assertThrows(() => normalizePrivateKeyPem(oldStyle), PemError, 'encrypted private keys')

  const dir = await Deno.makeTempDir({ prefix: 'enc-key-' })
  try {
    await Deno.writeTextFile(`${dir}/k.pem`, pair.privateKeyPem)
    const enc = await new Deno.Command('openssl', {
      args: [
        'pkcs8',
        '-topk8',
        '-v2',
        'aes-256-cbc',
        '-passout',
        'pass:test',
        '-in',
        `${dir}/k.pem`,
      ],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    const encrypted = new TextDecoder().decode(enc.stdout)
    assertEquals(encrypted.includes('BEGIN ENCRYPTED PRIVATE KEY'), true)
    assertThrows(() => normalizePrivateKeyPem(encrypted), PemError, 'encrypted private keys')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
