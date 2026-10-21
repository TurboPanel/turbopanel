/**
 * An uploaded certificate is stored with a PKCS#8 key, whatever form the
 * owner's key file is in (SEC1 EC, PKCS#1 RSA or PKCS#8).
 */

import { assertEquals } from '@std/assert'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { parseCertificatePem, privateKeyMatchesCertificate } from '../../lib/tls/index.ts'
import { makeCaddyPair } from '../../test-fixtures/caddy-key-fixtures.test.support.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { isCreateTlsFailure, materialFromUpload } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

for (const kind of ['ec-p256', 'ec-p384', 'rsa-pkcs1', 'ec-p256-pkcs8'] as const) {
  test(`an upload with a ${kind} key stores a PKCS#8 key that still matches the certificate`, async () => {
    const secrets = await deriveEncryptionSecretsConfig(
      parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
      'data-encryption'
    )
    const pair = await makeCaddyPair(kind, ['upload.example.com'])
    const material = await materialFromUpload(
      { certificatePem: pair.certificatePem, privateKeyPem: pair.privateKeyPem },
      secrets
    )
    if (isCreateTlsFailure(material)) throw new Error('upload was refused')
    const stored = await decryptSecret(secrets, material.privateKeyPemSealed!)
    assertEquals(stored.startsWith('-----BEGIN PRIVATE KEY-----'), true)
    const leaf = await parseCertificatePem(material.certificatePem!)
    assertEquals(await privateKeyMatchesCertificate(stored, leaf), true)
  })
}
