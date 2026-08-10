/**
 * Organization CA mint + leaf issue unit tests.
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import {
  issueLeafCertificate,
  KEY_USAGE_CRL_SIGN,
  KEY_USAGE_KEY_CERT_SIGN,
  mintOrganizationCa,
  parseCertificatePem,
  readBasicConstraintsCa,
  readKeyUsageBits,
  verifyCertificateSignature,
} from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mintOrganizationCa produces CA:TRUE with keyCertSign keyUsage', async () => {
  const material = await mintOrganizationCa({ commonName: 'Test Org CA' })
  const parsed = await parseCertificatePem(material.certificatePem)

  assertEquals(readBasicConstraintsCa(material.certificatePem), true)
  const keyUsage = readKeyUsageBits(material.certificatePem)
  assertEquals(keyUsage?.includes(KEY_USAGE_KEY_CERT_SIGN), true)
  assertEquals(keyUsage?.includes(KEY_USAGE_CRL_SIGN), true)
  assertEquals(parsed.subject.includes('Test Org CA'), true)
  assertEquals(parsed.issuer, parsed.subject)
  assertEquals(material.privateKeyPem.includes('BEGIN PRIVATE KEY'), true)
})

test('issueLeafCertificate is signed by CA with CA:FALSE and SANs', async () => {
  const ca = await mintOrganizationCa({ commonName: 'Issuer Org CA' })
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
  const ca = await mintOrganizationCa({ commonName: 'Org CA IP SAN' })
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
  const ca = await mintOrganizationCa()
  await assertRejects(
    () => issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, []),
    TypeError,
    'at least one DNS name is required',
  )
})
