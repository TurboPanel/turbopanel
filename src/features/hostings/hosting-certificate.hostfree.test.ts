import { assertEquals } from '@std/assert'
import {
  type DeriveHostingCertificateInput,
  deriveHostingCertificate,
  isPendingExpired,
  letsEncryptNames,
  letsEncryptRefusal,
  readPendingLetsEncrypt,
  siblingHostname,
  uploadedExpiryWarning,
  withPendingLetsEncrypt,
} from './hosting-certificate.ts'

const test = Deno.test.bind(Deno)

const NOW = new Date('2026-10-04T12:00:00.000Z')
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString()

function input(overrides: Partial<DeriveHostingCertificateInput>): DeriveHostingCertificateInput {
  return {
    pinned: null,
    pending: null,
    wwwRedirect: false,
    letsEncryptAvailable: true,
    needsDeploy: false,
    now: NOW,
    ...overrides,
  }
}

function managed(acme: Record<string, unknown>) {
  return {
    source: 'lets_encrypt',
    status: 'managed',
    notAfter: new Date(0).toISOString(),
    metadata: { dnsNames: ['a.example.com'], acme: { managedBy: 'caddy', ...acme } },
  }
}

test('no pin and a self-signed pin read as a test certificate', () => {
  assertEquals(deriveHostingCertificate(input({})).state, 'test_certificate')
  const selfSigned = { source: 'self_signed', status: 'ready', notAfter: iso(30), metadata: {} }
  assertEquals(deriveHostingCertificate(input({ pinned: selfSigned })).state, 'test_certificate')
})

test('a revoked pin falls back to a test certificate', () => {
  const revoked = { ...managed({}), status: 'revoked' }
  assertEquals(deriveHostingCertificate(input({ pinned: revoked })).state, 'test_certificate')
})

test('an uploaded certificate reports days left and the warning band', () => {
  const uploaded = { source: 'upload', status: 'ready', notAfter: iso(9), metadata: {} }
  const out = deriveHostingCertificate(input({ pinned: uploaded }))
  assertEquals(out.state, 'uploaded')
  assertEquals(out.source, 'uploaded')
  assertEquals(out.expiresInDays, 9)
  assertEquals(out.uploadedExpiryWarning, '14d')
  assertEquals(out.renewsAutomatically, false)
})

test('uploaded expiry bands: none, 14, 3, 1 days, expired', () => {
  assertEquals(uploadedExpiryWarning(iso(15), NOW), 'none')
  assertEquals(uploadedExpiryWarning(iso(14), NOW), '14d')
  assertEquals(uploadedExpiryWarning(iso(3), NOW), '3d')
  assertEquals(uploadedExpiryWarning(iso(1), NOW), '1d')
  assertEquals(uploadedExpiryWarning(iso(-1), NOW), 'expired')
  assertEquals(uploadedExpiryWarning(null, NOW), 'none')
})

test('a waiting request with no pin is waiting for DNS and keeps the report', () => {
  const dns = {
    ready: false,
    checkedAt: NOW.toISOString(),
    hostnames: [{ hostname: 'a.example.com', resolves: false, addresses: [] }],
    expectedAddresses: ['203.0.113.7'],
  }
  const pending = { requestedAt: iso(-1), wwwRedirect: true, dns }
  const out = deriveHostingCertificate(input({ pending }))
  assertEquals(out.state, 'waiting_for_dns')
  assertEquals(out.dns, dns)
  assertEquals(out.wwwRedirect, true)
})

test("a Let's Encrypt pin with no issuance yet is issuing and says whether a deploy is due", () => {
  const out = deriveHostingCertificate(input({ pinned: managed({}), needsDeploy: true }))
  assertEquals(out.state, 'issuing')
  assertEquals(out.needsDeploy, true)
  assertEquals(out.source, 'lets_encrypt')
})

test("a Let's Encrypt pin with an expiry is secure and renews by itself", () => {
  const out = deriveHostingCertificate(
    input({ pinned: managed({ notAfter: iso(61), lastIssuedAt: iso(-29) }) })
  )
  assertEquals(out.state, 'secure')
  assertEquals(out.renewsAutomatically, true)
  assertEquals(out.expiresInDays, 61)
  assertEquals(out.lastIssuedAt, iso(-29))
  assertEquals(out.needsDeploy, false)
})

test('a recorded error is renewal failed, with the reason', () => {
  const out = deriveHostingCertificate(
    input({ pinned: managed({ notAfter: iso(10), lastError: 'HTTP 404 on challenge' }) })
  )
  assertEquals(out.state, 'renewal_failed')
  assertEquals(out.lastError, 'HTTP 404 on challenge')
})

test("a Let's Encrypt certificate past its expiry is renewal failed", () => {
  const out = deriveHostingCertificate(input({ pinned: managed({ notAfter: iso(-1) }) }))
  assertEquals(out.state, 'renewal_failed')
  assertEquals(out.lastError, 'The certificate has expired.')
})

test('sibling names go both ways and the covered names are sorted and unique', () => {
  assertEquals(siblingHostname('Example.com'), 'www.example.com')
  assertEquals(siblingHostname('www.example.com'), 'example.com')
  assertEquals(letsEncryptNames(['b.example.com', 'a.example.com'], false), [
    'a.example.com',
    'b.example.com',
  ])
  assertEquals(letsEncryptNames(['example.com', 'www.example.com'], true), [
    'example.com',
    'www.example.com',
  ])
})

const OK = {
  acmeEnabled: true,
  protocol: 'http',
  bind: 'public',
  hostnames: ['shop.example.com'],
} as const

test('refusals come in a fixed order', () => {
  assertEquals(letsEncryptRefusal(OK), null)
  assertEquals(letsEncryptRefusal({ ...OK, acmeEnabled: false }), 'lets_encrypt_not_enabled')
  assertEquals(letsEncryptRefusal({ ...OK, protocol: 'tcp' }), 'hosting_not_http')
  assertEquals(letsEncryptRefusal({ ...OK, hostnames: [] }), 'hosting_has_no_hostnames')
  assertEquals(letsEncryptRefusal({ ...OK, bind: 'local' }), 'acme_requires_public_bind')
  for (const hostnames of [['*.example.com'], ['203.0.113.9'], ['localhost'], ['intranet']]) {
    assertEquals(letsEncryptRefusal({ ...OK, hostnames }), 'letsencrypt_hostname_unsupported')
  }
})

test('pending request round-trips through hosting metadata and expires after a week', () => {
  const pending = { requestedAt: iso(-8), wwwRedirect: false, dns: null }
  const metadata = withPendingLetsEncrypt({ keep: 1 }, pending)
  assertEquals(metadata.keep, 1)
  assertEquals(readPendingLetsEncrypt(metadata), pending)
  assertEquals(isPendingExpired(pending, NOW), true)
  assertEquals(isPendingExpired({ ...pending, requestedAt: iso(-6) }, NOW), false)
  assertEquals(readPendingLetsEncrypt(withPendingLetsEncrypt(metadata, null)), null)
})
