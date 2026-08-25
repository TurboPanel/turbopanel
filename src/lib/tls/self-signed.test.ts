/**
 * Organization CA mint + leaf issue unit tests.
 */

import { assertEquals, assertRejects } from '@std/assert'
import {
  buildBasicConstraintsExtension,
  buildKeyUsageExtension,
  extractSubjectNameDer,
  issueLeafCertificate,
  KEY_USAGE_CRL_SIGN,
  KEY_USAGE_DIGITAL_SIGNATURE,
  KEY_USAGE_KEY_CERT_SIGN,
  KEY_USAGE_KEY_ENCIPHERMENT,
  mintOrganizationCa,
  mintSelfSignedCertificate,
  ORGANIZATION_CA_LEAF_VALID_DAYS,
  ORGANIZATION_CA_ORG_NAME,
  ORGANIZATION_CA_ORG_UNIT,
  parseCertificatePem,
  readBasicConstraintsCa,
  readKeyUsageBits,
  verifyCertificateSignature,
} from './index.ts'
import { extractSpkiDer } from './self-signed.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mintOrganizationCa produces CA:TRUE with keyCertSign keyUsage', async () => {
  const material = await mintOrganizationCa({ organizationId: 'Test Org CA' })
  const parsed = await parseCertificatePem(material.certificatePem)

  assertEquals(readBasicConstraintsCa(material.certificatePem), true)
  const keyUsage = readKeyUsageBits(material.certificatePem)
  assertEquals(keyUsage?.includes(KEY_USAGE_KEY_CERT_SIGN), true)
  assertEquals(keyUsage?.includes(KEY_USAGE_CRL_SIGN), true)
  assertEquals(parsed.subject.includes('Test Org CA'), true)
  assertEquals(parsed.issuer, parsed.subject)
  assertEquals(material.privateKeyPem.includes('BEGIN PRIVATE KEY'), true)
})

test('mintOrganizationCa subject is unique per organization', async () => {
  const orgId = '11111111-1111-4111-8111-111111111111'
  const material = await mintOrganizationCa({ organizationId: orgId })
  const parsed = await parseCertificatePem(material.certificatePem)
  assertEquals(
    parsed.subject,
    `O=${ORGANIZATION_CA_ORG_NAME}, OU=${ORGANIZATION_CA_ORG_UNIT}, CN=${orgId}`,
  )
  assertEquals(parsed.issuer, parsed.subject)
})

test('mintOrganizationCa rejects a blank organizationId', async () => {
  await assertRejects(
    () => mintOrganizationCa({ organizationId: '  ' }),
    TypeError,
    'organizationId is required',
  )
})

test('issueLeafCertificate is signed by CA with CA:FALSE and SANs', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Issuer Org CA' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['db.example.com', 'proxy.example.com'],
    { commonName: 'db.example.com' },
  )

  const caParsed = await parseCertificatePem(ca.certificatePem)
  const leafParsed = await parseCertificatePem(leaf.certificatePem)

  assertEquals(readBasicConstraintsCa(leaf.certificatePem), false)
  assertEquals(leafParsed.issuer, caParsed.subject)
  assertEquals(leafParsed.dnsNames.includes('db.example.com'), true)
  assertEquals(leafParsed.dnsNames.includes('proxy.example.com'), true)
  assertEquals(
    await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem),
    true,
  )
})

test('issueLeafCertificate embeds IP SANs for private listener verify-identity', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Org CA IP SAN' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['managed-test', 'localhost'],
    {
      commonName: 'managed-test',
      ipAddresses: ['203.0.113.50', '203.0.113.50'],
    },
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  assertEquals(parsed.dnsNames.includes('managed-test'), true)
  assertEquals(parsed.ipAddresses, ['203.0.113.50'])
})

test('issueLeafCertificate rejects empty dns names', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-empty-dns' })
  await assertRejects(
    () => issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, []),
    TypeError,
    'at least one DNS name is required',
  )
})

test('ORGANIZATION_CA_LEAF_VALID_DAYS is the managed leaf default', () => {
  assertEquals(ORGANIZATION_CA_LEAF_VALID_DAYS, 90)
})

test('issueLeafCertificate honors validDays and includeClientAuth', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-leaf-opts' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['leaf.example.com'],
    { validDays: 30, includeClientAuth: true, commonName: 'leaf.example.com' },
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  const lifetimeMs = parsed.notAfter.getTime() - parsed.notBefore.getTime()
  // ~30 days (±1 day for UTCTIME second resolution / clock skew).
  assertEquals(lifetimeMs > 29 * 24 * 60 * 60 * 1000, true)
  assertEquals(lifetimeMs < 31 * 24 * 60 * 60 * 1000, true)
  assertEquals(
    await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem),
    true,
  )
})

test('issueLeafCertificate rejects invalid IP SANs', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-bad-ip' })
  await assertRejects(
    () =>
      issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'], {
        ipAddresses: ['not-an-ip'],
      }),
    TypeError,
    'invalid IP address for SAN',
  )
})

test('issueLeafCertificate skips blank IP SAN entries', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-blank-ip' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['db.example.com'],
    { ipAddresses: ['  ', '203.0.113.10', ''] },
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  assertEquals(parsed.ipAddresses, ['203.0.113.10'])
})

test('buildBasicConstraintsExtension and buildKeyUsageExtension encode DER', () => {
  const leafBc = buildBasicConstraintsExtension({ ca: false })
  const caBc = buildBasicConstraintsExtension({ ca: true })
  const caWithPath = buildBasicConstraintsExtension({ ca: true, pathLen: 0 })
  // Leaf and CA without pathLen are the same TLV shape (one BOOLEAN); pathLen
  // adds an INTEGER and grows the encoding.
  assertEquals(leafBc.length, caBc.length)
  assertEquals(caWithPath.length > caBc.length, true)
  assertEquals(leafBc[0], 0x30)
  assertEquals(caWithPath[0], 0x30)

  const usage = buildKeyUsageExtension([
    KEY_USAGE_DIGITAL_SIGNATURE,
    KEY_USAGE_KEY_ENCIPHERMENT,
  ])
  assertEquals(usage[0], 0x30)
  assertEquals(usage.length > 0, true)
})

test('buildKeyUsageExtension rejects empty and out-of-range bits', () => {
  try {
    buildKeyUsageExtension([])
    throw new TypeError('expected empty keyUsage to throw')
  } catch (error) {
    assertEquals(error instanceof TypeError, true)
    assertEquals(
      (error as TypeError).message,
      'at least one keyUsage bit is required',
    )
  }
  try {
    buildKeyUsageExtension([16])
    throw new TypeError('expected out-of-range keyUsage to throw')
  } catch (error) {
    assertEquals(error instanceof TypeError, true)
    assertEquals(
      (error as TypeError).message,
      'keyUsage bit out of range: 16',
    )
  }
})

test('extractSubjectNameDer and extractSpkiDer return non-empty TLVs', async () => {
  const material = await mintOrganizationCa({ organizationId: 'org-extract' })
  const subject = extractSubjectNameDer(material.certificatePem)
  const spki = extractSpkiDer(material.certificatePem)
  assertEquals(subject[0], 0x30)
  assertEquals(spki[0], 0x30)
  assertEquals(subject.length > 4, true)
  assertEquals(spki.length > 4, true)
})

test('verifyCertificateSignature rejects a leaf signed by a different CA', async () => {
  const caA = await mintOrganizationCa({ organizationId: 'org-a' })
  const caB = await mintOrganizationCa({ organizationId: 'org-b' })
  const leaf = await issueLeafCertificate(
    caA.certificatePem,
    caA.privateKeyPem,
    ['leaf.example.com'],
  )
  assertEquals(
    await verifyCertificateSignature(leaf.certificatePem, caB.certificatePem),
    false,
  )
})

test('mintOrganizationCa honors custom validDays', async () => {
  const material = await mintOrganizationCa({
    organizationId: 'org-short-ca',
    validDays: 10,
  })
  const lifetimeMs = material.parsed.notAfter.getTime() -
    material.parsed.notBefore.getTime()
  assertEquals(lifetimeMs > 9 * 24 * 60 * 60 * 1000, true)
  assertEquals(lifetimeMs < 11 * 24 * 60 * 60 * 1000, true)
})

test('readBasicConstraintsCa is false for a self-signed leaf without CA:TRUE', async () => {
  const leaf = await mintSelfSignedCertificate(['solo.example.com'])
  // mintSelfSignedCertificate only embeds SAN — no basicConstraints extension.
  assertEquals(readBasicConstraintsCa(leaf.certificatePem), false)
  assertEquals(readKeyUsageBits(leaf.certificatePem), null)
})
