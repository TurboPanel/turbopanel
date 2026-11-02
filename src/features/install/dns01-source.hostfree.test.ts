import { assertEquals } from '@std/assert'
import {
  certificateSourceForInstallOrigin,
  deriveInstanceHostnameStatus,
  effectiveCertificateSource,
  validateHostnameSource,
} from './instance-hostnames.ts'

const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-11-01T00:00:00.000Z')
const LATER = '2026-12-01T00:00:00.000Z'
const EARLIER = '2026-10-01T00:00:00.000Z'

test('a dns-01 name is served as an upload only while its issued pair is live', () => {
  const live = { source: 'dns-01' as const, uploadedCertId: 'c1', notAfter: LATER }
  assertEquals(effectiveCertificateSource(live, NOW), 'uploaded')
  assertEquals(effectiveCertificateSource({ ...live, notAfter: EARLIER }, NOW), 'platform-ca')
  assertEquals(effectiveCertificateSource({ ...live, uploadedCertId: null }, NOW), 'platform-ca')
  assertEquals(effectiveCertificateSource({ source: 'lets-encrypt' }, NOW), 'lets-encrypt')
})

test('install trust follows the served source of a dns-01 name', () => {
  const rows = [
    {
      host: 'https://panel.example.com:8443',
      source: 'dns-01' as const,
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
  assertEquals(validateHostnameSource('panel.lan', 'dns-01').ok, true)
  assertEquals(validateHostnameSource('10.0.0.5', 'dns-01').ok, false)
  assertEquals(validateHostnameSource('localhost', 'dns-01').ok, false)
  assertEquals(validateHostnameSource('*.example.com', 'dns-01').ok, false)
})

test('a dns-01 name is pending until its first pair, then ready, failed or expired', () => {
  const base = { source: 'dns-01' as const, acmeLastError: null, notAfter: null }
  assertEquals(deriveInstanceHostnameStatus(base, NOW), 'pending')
  assertEquals(deriveInstanceHostnameStatus({ ...base, notAfter: LATER }, NOW), 'ready')
  assertEquals(deriveInstanceHostnameStatus({ ...base, notAfter: EARLIER }, NOW), 'expired')
  assertEquals(deriveInstanceHostnameStatus({ ...base, acmeLastError: 'no' }, NOW), 'failed')
})
