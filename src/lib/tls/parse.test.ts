import { X509Certificate } from 'node:crypto'
import { assertEquals, assertRejects } from '@std/assert'
import { CertificateParseError, parseCertificatePem } from './parse.ts'
import { issueLeafCertificate, mintOrganizationCa } from './self-signed.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseCertificatePem rejects non-PEM input', async () => {
  await assertRejects(() => parseCertificatePem('not-a-certificate'), CertificateParseError)
})

test('parseCertificatePem extracts DNS and IP SANs from a minted leaf', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Parse CA' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['app.example.com', '*.example.com'],
    {
      commonName: 'app.example.com',
      ipAddresses: ['203.0.113.20'],
    }
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  assertEquals(parsed.dnsNames.includes('app.example.com'), true)
  assertEquals(parsed.dnsNames.includes('*.example.com'), true)
  assertEquals(parsed.hasWildcard, true)
  assertEquals(parsed.ipAddresses, ['203.0.113.20'])
  assertEquals(parsed.fingerprintSha256.length, 64)
  assertEquals(parsed.subject.includes('app.example.com'), true)
  assertEquals(parsed.leafDer.length > 0, true)
  assertEquals(parsed.spkiDer.length > 0, true)
})

test('parseCertificatePem reads the organization CA subject as self-issued', async () => {
  const orgId = 'Org Parse CA'
  const ca = await mintOrganizationCa({ organizationId: orgId })
  const parsed = await parseCertificatePem(ca.certificatePem)
  assertEquals(parsed.issuer, parsed.subject)
  assertEquals(parsed.subject.includes(`CN=${orgId}`), true)
  assertEquals(parsed.subject.includes('O=TurboPanel'), true)
  assertEquals(parsed.subject.includes('OU=Organization CA'), true)
})

test('a leaf carries IPv4 and IPv6 iPAddress SANs that read back exactly', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Dual Stack CA' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['omega', 'omega.example.com'],
    {
      commonName: 'omega.example.com',
      ipAddresses: ['192.0.2.77', '2001:db8::4', '[fd00::5]'],
    }
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  assertEquals(parsed.dnsNames, ['omega', 'omega.example.com'])
  assertEquals(parsed.ipAddresses, ['192.0.2.77', '2001:db8::4', 'fd00::5'])
  // An independent decoder sees the same 4- and 16-octet entries.
  assertEquals(
    new X509Certificate(leaf.certificatePem).subjectAltName,
    'DNS:omega, DNS:omega.example.com, IP Address:192.0.2.77, IP Address:2001:db8::4, IP Address:fd00::5'
  )
})
