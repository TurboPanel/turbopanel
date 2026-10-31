/**
 * Host-free coverage for TLS route pure helpers (no Postgres).
 */

import { assertEquals, assertThrows } from '@std/assert'
import { X509Certificate } from 'node:crypto'
import { decryptSecret, encryptSecret, ENVELOPE_MAGIC } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  issueLeafCertificate,
  mintSelfSignedCertificate,
  verifyCertificateSignature,
} from '../../lib/tls/index.ts'
import {
  assertTpSecretPrivateKey,
  buildCreateTlsMaterial,
  classifyTlsInsertConflict,
  createFailure,
  isCreateTlsFailure,
  plainAcmeNote,
  isOrganizationCaExistsCode,
  isTlsUuid,
  materialFromOrganizationCa,
  materialFromSelfSigned,
  materialFromUpload,
  organizationCaDownloadHeaders,
  rotationConflictResponse,
  rotationStatusResponse,
  shouldRevokeTlsFromBody,
  tlsFailurePayload,
  toCaRotationApiResult,
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
  const config = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  return await deriveEncryptionSecretsConfig(config, 'data-encryption')
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
    TypeError
  )
  assertThrows(() => assertTpSecretPrivateKey('not-an-envelope'), TypeError)
  assertThrows(() => assertTpSecretPrivateKey(`${ENVELOPE_MAGIC}.v1.BEGIN`), TypeError)
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

test('rotationConflictResponse and rotationStatusResponse shape API payloads', () => {
  assertEquals(rotationConflictResponse('ca_rotation_in_progress'), {
    body: { error: 'ca_rotation_in_progress' },
    status: 409,
  })
  assertEquals(rotationConflictResponse('no_pending_rotation'), {
    body: { error: 'no_pending_rotation' },
    status: 409,
  })
  assertEquals(rotationConflictResponse('ca_rotation_not_converged'), {
    body: { error: 'ca_rotation_not_converged' },
    status: 409,
  })

  const inFlight = rotationStatusResponse({
    rotationId: 'rot-1',
    fromGeneration: 1,
    toGeneration: 2,
    state: 'awaiting_retire',
    results: [
      toCaRotationApiResult({
        serverId: 'srv-1',
        kind: 'apply',
        managedId: 'mid-1',
        status: 'queued',
        commandId: 'cmd-1',
      }),
    ],
  })
  assertEquals(inFlight.retiredCaStillRequired, true)
  assertEquals(inFlight.results[0]?.commandId, 'cmd-1')
  assertEquals(inFlight.results[0]?.kind, 'apply')
  assertEquals(inFlight.results[0]?.managedId, 'mid-1')

  const done = rotationStatusResponse({
    rotationId: 'rot-1',
    fromGeneration: 1,
    toGeneration: 2,
    state: 'completed',
    results: [],
  })
  assertEquals(done.retiredCaStillRequired, false)
})

test('classifyTlsInsertConflict maps organization CA and fingerprint races', () => {
  assertEquals(
    classifyTlsInsertConflict(
      Object.assign(new Error('organization_ca_exists'), {
        code: 'ORGANIZATION_CA_EXISTS',
      })
    ),
    { error: 'organization_ca_exists', status: 409 }
  )
  assertEquals(
    classifyTlsInsertConflict(
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "uniq_tls_organization_active_ca"'
        ),
        { code: '23505' }
      )
    ),
    { error: 'organization_ca_exists', status: 409 }
  )
  assertEquals(
    classifyTlsInsertConflict(
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "uniq_tls_organization_fingerprint_sha256"'
        ),
        { code: '23505' }
      )
    ),
    { error: 'tls_fingerprint_conflict', status: 409 }
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

test('organizationCaDownloadHeaders names the file after the organization id', () => {
  const organizationId = '019a2b3c-4d5e-7f60-8a7b-9c0d1e2f3a4b'
  assertEquals(organizationCaDownloadHeaders(organizationId), {
    'Content-Type': 'application/x-pem-file',
    'Content-Disposition': `attachment; filename="turbopanel-org-ca-${organizationId}.pem"`,
  })
})

test('toPublicTlsRow refreshes metadata and rejects unassemblable rows', () => {
  const ok = toPublicTlsRow({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Leaf',
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
  assertEquals(ok.name, 'Leaf')
  assertEquals(ok.metadata.status, 'ready')
  assertEquals(ok.options?.prefer, 1)
  assertEquals(ok.trustBundlePem, undefined)
  assertEquals(ok.caGeneration, null)

  const withBundle = toPublicTlsRow(
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Leaf',
      source: 'organization_ca',
      organizationId: '22222222-2222-4222-8222-222222222222',
      status: 'ready',
      notAfter: '2099-01-01T00:00:00.000Z',
      fingerprintSha256: 'a'.repeat(64),
      metadata: {
        dnsNames: [],
        hasWildcard: false,
        notBefore: '2026-01-01T00:00:00.000Z',
        subject: 'O=TurboPanel, OU=Organization CA, CN=22222222-2222-4222-8222-222222222222',
        issuer: 'O=TurboPanel, OU=Organization CA, CN=22222222-2222-4222-8222-222222222222',
      },
      options: null,
      certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      caGeneration: 3,
    },
    {
      trustBundlePem: '-----BEGIN CERTIFICATE-----\nBUNDLE\n-----END CERTIFICATE-----\n',
    }
  )
  if (!withBundle) {
    throw new TypeError('expected public tls row with trust bundle')
  }
  assertEquals(
    withBundle.trustBundlePem,
    '-----BEGIN CERTIFICATE-----\nBUNDLE\n-----END CERTIFICATE-----\n'
  )
  assertEquals(withBundle.caGeneration, 3)

  assertEquals(
    toPublicTlsRow({
      id: '11111111-1111-4111-8111-111111111111',
      name: null,
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
    null
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
    secrets
  )
  assertEquals(mismatch, createFailure('certificate_key_mismatch'))

  const ok = await materialFromUpload(
    {
      certificatePem: minted.certificatePem,
      privateKeyPem: minted.privateKeyPem,
    },
    secrets
  )
  if (isCreateTlsFailure(ok)) throw new TypeError('expected upload material')
  assertEquals(typeof ok.privateKeyPemSealed, 'string')
  assertTpSecretPrivateKey(ok.privateKeyPemSealed!)
})

test('materialFromSelfSigned and organization CA seal private keys', async () => {
  const secrets = await dataEncryptionSecrets()
  const invalid = await materialFromSelfSigned({}, secrets)
  assertEquals(isCreateTlsFailure(invalid), true)

  const selfSigned = await materialFromSelfSigned({ hostnames: ['Self.Example.com'] }, secrets)
  if (isCreateTlsFailure(selfSigned)) {
    throw new TypeError('expected self-signed material')
  }
  assertEquals(selfSigned.options?.requestedHostnames, ['self.example.com'])
  assertTpSecretPrivateKey(selfSigned.privateKeyPemSealed!)

  const ca = await materialFromOrganizationCa(secrets, {
    organizationId: 'org-ca-test',
  })
  if (isCreateTlsFailure(ca)) {
    throw new TypeError('expected organization CA material')
  }
  assertTpSecretPrivateKey(ca.privateKeyPemSealed!)
})

test('materialFromOrganizationCa (first CA and every rotation) mints P-384 for 15 years, and its sealed key signs leaves', async () => {
  const secrets = await dataEncryptionSecrets()
  const ca = await materialFromOrganizationCa(secrets, {
    organizationId: '019a2b3c-4d5e-7f60-8a7b-9c0d1e2f3a4b',
  })
  if (isCreateTlsFailure(ca)) {
    throw new TypeError('expected organization CA material')
  }
  const cert = new X509Certificate(ca.certificatePem!)
  assertEquals(cert.publicKey.asymmetricKeyType, 'ec')
  assertEquals(cert.publicKey.asymmetricKeyDetails?.namedCurve, 'secp384r1')
  // Within a week of 15 years from now, so a year or leap-day rollover cannot flip it.
  const fifteenYearsMs = 15 * 365.25 * 24 * 3_600_000
  const driftMs = Math.abs(new Date(cert.validTo).getTime() - (Date.now() + fifteenYearsMs))
  assertEquals(driftMs < 7 * 24 * 3_600_000, true)

  // Reload the stored key the way leaf issuance does: unseal, then sign.
  const privateKeyPem = await decryptSecret(secrets, ca.privateKeyPemSealed!)
  const leaf = await issueLeafCertificate(ca.certificatePem!, privateKeyPem, ['managed-test'])
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem!), true)
  assertEquals(new X509Certificate(leaf.certificatePem).checkIssued(cert), true)
})

test('buildCreateTlsMaterial dispatches by source', async () => {
  const secrets = await dataEncryptionSecrets()
  const le = await buildCreateTlsMaterial(
    'lets_encrypt',
    { hostnames: ['le.example.com'] },
    secrets,
    'org-1'
  )
  if (isCreateTlsFailure(le)) {
    throw new TypeError('expected lets encrypt material')
  }
  assertEquals(le.metadata.status, 'automatic')
  assertEquals(le.metadata.acme?.managedBy, 'caddy')

  const selfSigned = await buildCreateTlsMaterial(
    'self_signed',
    { hostnames: ['a.example.com'] },
    secrets,
    'org-1'
  )
  assertEquals(isCreateTlsFailure(selfSigned), false)
})

test('toPublicTlsRow sends null dates for a row with no certificate yet and keeps real dates', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    name: null,
    organizationId: '22222222-2222-4222-8222-222222222222',
    fingerprintSha256: null,
    options: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    metadata: {
      dnsNames: ['app.example.com'],
      hasWildcard: false,
      notBefore: new Date(0).toISOString(),
      subject: '',
      issuer: '',
    },
  }
  const pending = toPublicTlsRow({
    ...base,
    source: 'upload',
    status: 'pending',
    notAfter: new Date(0).toISOString(),
    certificatePem: null,
  })
  assertEquals(pending?.metadata.notAfter, null)
  assertEquals(pending?.metadata.notBefore, null)
  const issued = toPublicTlsRow({
    ...base,
    source: 'upload',
    status: 'ready',
    notAfter: '2099-01-01T00:00:00.000Z',
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    metadata: { ...base.metadata, notBefore: '2026-01-01T00:00:00.000Z' },
  })
  assertEquals(issued?.metadata.notAfter, '2099-01-01T00:00:00.000Z')
  assertEquals(issued?.metadata.notBefore, '2026-01-01T00:00:00.000Z')
})

test('toPublicTlsRow never carries the private state of a server-ordered certificate', () => {
  const shown = toPublicTlsRow({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Leaf',
    source: 'lets_encrypt',
    organizationId: '22222222-2222-4222-8222-222222222222',
    status: 'automatic',
    notAfter: '2099-01-01T00:00:00.000Z',
    fingerprintSha256: 'a'.repeat(64),
    metadata: {
      dnsNames: ['app.example.com'],
      hasWildcard: false,
      notBefore: '2026-01-01T00:00:00.000Z',
      subject: 'CN=app.example.com',
      issuer: 'CN=app.example.com',
      acme: { managedBy: 'server', challengeType: 'http-01' },
      httpCert: {
        issuingServerId: 'server-secret-id',
        requestId: 'req_secret',
        startedAt: '2026-01-01T00:00:00.000Z',
        startByAt: '2026-01-01T01:00:00.000Z',
      },
    },
    options: {},
    certificatePem: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
  const text = JSON.stringify(shown)
  assertEquals(text.includes('httpCert'), false)
  assertEquals(text.includes('req_secret'), false)
  assertEquals(text.includes('server-secret-id'), false)
  assertEquals(shown?.metadata.acme?.managedBy, 'server')
})

test('an issuance note reads in plain words and is dropped once a certificate was issued after it', () => {
  const raw = 'The operation was aborted due to timeout'
  const failing = plainAcmeNote({
    acme: { lastError: raw, lastFailedAt: '2026-10-30T10:00:00.000Z' },
  })
  assertEquals(failing.acme?.lastError?.startsWith('This name did not answer in time'), true)
  const settled = plainAcmeNote({
    acme: {
      lastError: raw,
      lastFailedAt: '2026-10-30T10:00:00.000Z',
      lastIssuedAt: '2026-10-30T11:00:00.000Z',
    },
  })
  assertEquals(settled.acme?.lastError, undefined)
  const renewalFailed = plainAcmeNote({
    acme: {
      lastError: 'DNS problem: NXDOMAIN',
      lastFailedAt: '2026-10-30T12:00:00.000Z',
      lastIssuedAt: '2026-10-30T11:00:00.000Z',
    },
  })
  assertEquals(renewalFailed.acme?.lastError, 'DNS problem: NXDOMAIN')
})
