/**
 * Host-free coverage for TLS route pure helpers (no Postgres).
 */

import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  ENVELOPE_MAGIC,
  encryptSecret,
} from '../authn/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import {
  assertTpSecretPrivateKey,
  buildCreateTlsMaterial,
  classifyTlsInsertConflict,
  createFailure,
  isCreateTlsFailure,
  isOrganizationCaExistsCode,
  isTlsUuid,
  materialFromOrganizationCa,
  materialFromSelfSigned,
  materialFromUpload,
  ORGANIZATION_CA_DOWNLOAD_HEADERS,
  shouldRevokeTlsFromBody,
  tlsFailurePayload,
  toPublicTlsRow,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function dataEncryptionSecrets() {
  const config = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  return deriveEncryptionSecretsConfig(config, 'data-encryption')
}

test('isTlsUuid accepts mixed-case UUIDs and rejects malformed values', () => {
  assertEquals(isTlsUuid('ABCDEF12-3456-789A-BCDE-F0123456789A'), true)
  assertEquals(isTlsUuid(''), false)
  assertEquals(isTlsUuid('11111111-1111-4111-8111'), false)
})

test('assertTpSecretPrivateKey accepts enc envelopes and rejects PEM plaintext', async () => {
  const secrets = await dataEncryptionSecrets()
  const sealed = await encryptSecret(secrets, 'synthetic-key-material')
  assertEquals(sealed.startsWith(`${ENVELOPE_MAGIC}.`), true)
  assertTpSecretPrivateKey(sealed)

  assertThrows(
    () => assertTpSecretPrivateKey('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    TypeError,
  )
  assertThrows(() => assertTpSecretPrivateKey('not-an-envelope'), TypeError)
  assertThrows(
    () => assertTpSecretPrivateKey(`${ENVELOPE_MAGIC}.v1.BEGIN`),
    TypeError,
  )
})

test('tlsFailurePayload omits detail when absent', () => {
  assertEquals(tlsFailurePayload(createFailure('Invalid request')), {
    body: { error: 'Invalid request' },
    status: 400,
  })
  assertEquals(tlsFailurePayload(createFailure('invalid_certificate', 'bad leaf')), {
    body: { error: 'invalid_certificate', detail: 'bad leaf' },
    status: 400,
  })
})

test('classifyTlsInsertConflict maps organization CA and fingerprint races', () => {
  assertEquals(
    classifyTlsInsertConflict(
      Object.assign(new Error('organization_ca_exists'), {
        code: 'ORGANIZATION_CA_EXISTS',
      }),
    ),
    { error: 'organization_ca_exists', status: 409 },
  )
  assertEquals(
    classifyTlsInsertConflict(
      Object.assign(
        new Error('duplicate key value violates unique constraint "uniq_tls_organization_active_ca"'),
        { code: '23505' },
      ),
    ),
    { error: 'organization_ca_exists', status: 409 },
  )
  assertEquals(
    classifyTlsInsertConflict(
      Object.assign(
        new Error('duplicate key value violates unique constraint "uniq_tls_organization_fingerprint_sha256"'),
        { code: '23505' },
      ),
    ),
    { error: 'tls_fingerprint_conflict', status: 409 },
  )
  assertEquals(classifyTlsInsertConflict(new Error('other')), null)
  assertEquals(isOrganizationCaExistsCode({ code: 'ORGANIZATION_CA_EXISTS' }), true)
  assertEquals(isOrganizationCaExistsCode({ code: '23505' }), false)
})

test('shouldRevokeTlsFromBody only reacts to revoke:true', () => {
  assertEquals(shouldRevokeTlsFromBody({ revoke: true }), true)
  assertEquals(shouldRevokeTlsFromBody({ revoke: false }), false)
  assertEquals(shouldRevokeTlsFromBody({}), false)
})

test('ORGANIZATION_CA_DOWNLOAD_HEADERS are stable', () => {
  assertEquals(ORGANIZATION_CA_DOWNLOAD_HEADERS['Content-Type'], 'application/x-pem-file')
  assertEquals(
    ORGANIZATION_CA_DOWNLOAD_HEADERS['Content-Disposition'],
    'attachment; filename="organization-ca.pem"',
  )
})

test('toPublicTlsRow refreshes metadata and rejects unassemblable rows', () => {
  const ok = toPublicTlsRow({
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Leaf',
    source: 'self_signed',
    organizationId: '22222222-2222-4222-8222-222222222222',
    status: 'ready',
    notAfter: '2099-01-01T00:00:00.000Z',
    fingerprintSha256: 'a'.repeat(64),
    metadata: {
      dnsNames: ['app.example.com'],
      hasWildcard: false,
      notBefore: '2026-01-01T00:00:00.000Z',
      subject: 'CN=app.example.com',
      issuer: 'CN=app.example.com',
    },
    options: { prefer: 1 },
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
  if (!ok) throw new TypeError('expected public tls row')
  assertEquals(ok.displayName, 'Leaf')
  assertEquals(ok.metadata.status, 'ready')
  assertEquals(ok.options?.prefer, 1)

  assertEquals(
    toPublicTlsRow({
      id: '11111111-1111-4111-8111-111111111111',
      displayName: null,
      source: 'upload',
      organizationId: '22222222-2222-4222-8222-222222222222',
      status: 'ready',
      notAfter: null,
      fingerprintSha256: null,
      metadata: 'not-an-object',
      options: null,
      certificatePem: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    null,
  )
})

test('materialFromUpload rejects missing PEM fields and key mismatches', async () => {
  const secrets = await dataEncryptionSecrets()
  const missing = await materialFromUpload({}, secrets)
  assertEquals(isCreateTlsFailure(missing), true)

  const minted = await mintSelfSignedCertificate(['upload.example.com'])
  const other = await mintSelfSignedCertificate(['other.example.com'])
  const mismatch = await materialFromUpload(
    {
      certificatePem: minted.certificatePem,
      privateKeyPem: other.privateKeyPem,
    },
    secrets,
  )
  assertEquals(mismatch, createFailure('certificate_key_mismatch'))

  const ok = await materialFromUpload(
    {
      certificatePem: minted.certificatePem,
      privateKeyPem: minted.privateKeyPem,
    },
    secrets,
  )
  if (isCreateTlsFailure(ok)) throw new TypeError('expected upload material')
  assertEquals(typeof ok.privateKeyPemSealed, 'string')
  assertTpSecretPrivateKey(ok.privateKeyPemSealed!)
})

test('materialFromSelfSigned and organization CA seal private keys', async () => {
  const secrets = await dataEncryptionSecrets()
  const invalid = await materialFromSelfSigned({}, secrets)
  assertEquals(isCreateTlsFailure(invalid), true)

  const selfSigned = await materialFromSelfSigned(
    { hostnames: ['Self.Example.com'] },
    secrets,
  )
  if (isCreateTlsFailure(selfSigned)) {
    throw new TypeError('expected self-signed material')
  }
  assertEquals(selfSigned.options?.requestedHostnames, ['self.example.com'])
  assertTpSecretPrivateKey(selfSigned.privateKeyPemSealed!)

  const ca = await materialFromOrganizationCa(secrets, { commonName: 'Org CA' })
  if (isCreateTlsFailure(ca)) throw new TypeError('expected organization CA material')
  assertTpSecretPrivateKey(ca.privateKeyPemSealed!)
})

test('buildCreateTlsMaterial dispatches by source', async () => {
  const secrets = await dataEncryptionSecrets()
  const le = await buildCreateTlsMaterial(
    'lets_encrypt',
    { hostnames: ['le.example.com'] },
    secrets,
  )
  if (isCreateTlsFailure(le)) throw new TypeError('expected lets encrypt material')
  assertEquals(le.metadata.status, 'pending')

  const selfSigned = await buildCreateTlsMaterial(
    'self_signed',
    { hostnames: ['a.example.com'] },
    secrets,
  )
  assertEquals(isCreateTlsFailure(selfSigned), false)
})
