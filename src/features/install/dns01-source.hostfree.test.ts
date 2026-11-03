import { assertEquals } from '@std/assert'
import {
  certificateSourceForInstallOrigin,
  deriveInstanceHostnameStatus,
  effectiveCertificateSource,
  isAcmeHostnameSource,
  validateHostnameSource,
  wireCertificateSource,
} from './instance-hostnames.ts'

const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-11-01T00:00:00.000Z')
const LATER = '2026-12-01T00:00:00.000Z'
const EARLIER = '2026-10-01T00:00:00.000Z'

test('an acme-dns-01 name is served as an upload only while its issued pair is live', () => {
  const live = { source: 'acme-dns-01' as const, uploadedCertId: 'c1', notAfter: LATER }
  assertEquals(effectiveCertificateSource(live, NOW), 'uploaded')
  assertEquals(effectiveCertificateSource({ ...live, notAfter: EARLIER }, NOW), 'platform-ca')
  assertEquals(effectiveCertificateSource({ ...live, uploadedCertId: null }, NOW), 'platform-ca')
  assertEquals(effectiveCertificateSource({ source: 'acme-http-01' }, NOW), 'acme-http-01')
})

test('install trust follows the served source of an acme-dns-01 name', () => {
  const rows = [
    {
      host: 'https://panel.example.com:8443',
      source: 'acme-dns-01' as const,
      uploadedCertId: null,
      notAfter: null,
    },
  ]
  assertEquals(
    certificateSourceForInstallOrigin('https://panel.example.com:8443', rows),
    'platform-ca'
  )
})

test('DNS-01 needs one exact DNS name; a private name is fine', () => {
  assertEquals(validateHostnameSource('panel.lan', 'acme-dns-01').ok, true)
  assertEquals(validateHostnameSource('10.0.0.5', 'acme-dns-01').ok, false)
  assertEquals(validateHostnameSource('localhost', 'acme-dns-01').ok, false)
  assertEquals(validateHostnameSource('*.example.com', 'acme-dns-01').ok, false)
})

test('an acme-dns-01 name is pending until its first pair, then ready, failed or expired', () => {
  const base = { source: 'acme-dns-01' as const, acmeLastError: null, notAfter: null }
  assertEquals(deriveInstanceHostnameStatus(base, NOW), 'pending')
  assertEquals(deriveInstanceHostnameStatus({ ...base, notAfter: LATER }, NOW), 'ready')
  assertEquals(deriveInstanceHostnameStatus({ ...base, notAfter: EARLIER }, NOW), 'expired')
  assertEquals(deriveInstanceHostnameStatus({ ...base, acmeLastError: 'no' }, NOW), 'failed')
})

test('the daemon wire keeps lets-encrypt for an HTTP-01 name and never sees acme-dns-01', () => {
  assertEquals(wireCertificateSource('acme-http-01'), 'lets-encrypt')
  assertEquals(wireCertificateSource('uploaded'), 'uploaded')
  assertEquals(wireCertificateSource('platform-ca'), 'platform-ca')
  const live = { source: 'acme-dns-01' as const, uploadedCertId: 'c1', notAfter: LATER }
  assertEquals(wireCertificateSource(effectiveCertificateSource(live, NOW)), 'uploaded')
  assertEquals(
    wireCertificateSource(effectiveCertificateSource({ ...live, notAfter: EARLIER }, NOW)),
    'platform-ca'
  )
})

test("both Let's Encrypt sources count as ACME; the others do not", () => {
  assertEquals(isAcmeHostnameSource('acme-http-01'), true)
  assertEquals(isAcmeHostnameSource('acme-dns-01'), true)
  assertEquals(isAcmeHostnameSource('uploaded'), false)
  assertEquals(isAcmeHostnameSource('platform-ca'), false)
  assertEquals(isAcmeHostnameSource('lets-encrypt'), false)
  assertEquals(isAcmeHostnameSource('dns-01'), false)
})
