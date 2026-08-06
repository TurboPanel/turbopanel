import { assertEquals, assertThrows } from '@std/assert'
import {
  decodeFirstCertificate,
  decodePemBlock,
  decodePrivateKeyToPkcs8,
  encodePemBlock,
  PemError,
  splitCertificateChain,
} from './pem.ts'
import { mintSelfSignedCertificate } from './self-signed.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('encodePemBlock round-trips DER through decodePemBlock', () => {
  const der = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x05])
  const pem = encodePemBlock('TEST', der)
  assertEquals(decodePemBlock(pem, 'TEST'), der)
})

test('splitCertificateChain returns the leaf first for multi-block PEM', async () => {
  const first = await mintSelfSignedCertificate(['one.example.com'])
  const second = await mintSelfSignedCertificate(['two.example.com'])
  const chain = `${first.certificatePem}${second.certificatePem}`
  const blocks = splitCertificateChain(chain)
  assertEquals(blocks.length, 2)
  assertEquals(decodeFirstCertificate(chain), decodePemBlock(blocks[0]!, 'CERTIFICATE'))
})

test('decodePemBlock rejects missing and unterminated blocks', () => {
  assertThrows(
    () => decodePemBlock('-----BEGIN CERTIFICATE-----\nabc', 'CERTIFICATE'),
    PemError,
    'unterminated PEM block CERTIFICATE',
  )
  assertThrows(
    () => decodePemBlock('not pem', 'CERTIFICATE'),
    PemError,
    'missing PEM block CERTIFICATE',
  )
})

test('splitCertificateChain rejects PEM without certificate blocks', () => {
  assertThrows(
    () => splitCertificateChain('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    PemError,
    'no CERTIFICATE PEM blocks found',
  )
})

test('decodePrivateKeyToPkcs8 accepts PKCS#8 RSA keys minted by self-signed helper', async () => {
  const material = await mintSelfSignedCertificate(['key.example.com'])
  const decoded = decodePrivateKeyToPkcs8(material.privateKeyPem)
  assertEquals(decoded.algorithm, 'rsa')
  assertEquals(decoded.pkcs8.length > 0, true)
})

test('decodePrivateKeyToPkcs8 rejects unsupported PEM labels', () => {
  assertThrows(
    () => decodePrivateKeyToPkcs8('-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----'),
    PemError,
    'EC PRIVATE KEY (SEC1) PEM is not supported',
  )
  assertThrows(
    () => decodePrivateKeyToPkcs8('not a key'),
    PemError,
    'unsupported private key PEM label',
  )
})
