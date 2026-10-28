import { assertEquals } from '@std/assert'
import {
  badgeCoversZone,
  isSuperseded,
  ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS,
  originCertificateIsDue,
  originCertificateNames,
  pickOriginCertificate,
  readProviderOrigin,
  type TlsRow,
} from './origin-certificate.ts'
import type { BadgeRow } from './records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const LINK = {
  provider: 'cloudflare',
  carrierId: 'c1',
  badgeId: 'b1',
  zoneId: 'z1',
  zoneName: 'example.com',
  externalId: 'x1',
}

function row(over: Partial<TlsRow> & { link?: Record<string, unknown> | null }): TlsRow {
  const { link, ...rest } = over
  return {
    id: crypto.randomUUID(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: link === null ? {} : { providerOrigin: { ...LINK, ...link } },
    options: null,
    organizationId: 'o1',
    name: 'Origin example.com',
    source: 'provider_origin',
    certificatePem: null,
    privateKeyPem: null,
    status: 'ready',
    notAfter: '2027-01-01T00:00:00.000Z',
    fingerprintSha256: null,
    caState: null,
    caGeneration: null,
    issuedByServerId: null,
    ...rest,
  } as TlsRow
}

test('a zone certificate covers the zone and everything one label below it', () => {
  assertEquals(originCertificateNames(' Example.COM '), ['example.com', '*.example.com'])
})

test('a certificate is due when less than the renewal window is left, or its date is unreadable', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')
  const day = 86_400_000
  const left = (days: number) => new Date(now.getTime() + days * day).toISOString()
  assertEquals(originCertificateIsDue(left(ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS + 1), now), false)
  assertEquals(originCertificateIsDue(left(ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS - 1), now), true)
  assertEquals(originCertificateIsDue(left(-1), now), true)
  assertEquals(originCertificateIsDue(null, now), true)
  assertEquals(originCertificateIsDue('not a date', now), true)
})

test('the provider link is read back only when every part is a non-empty string', () => {
  assertEquals(readProviderOrigin({ providerOrigin: LINK }), LINK)
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, externalId: '' } }), null)
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, zoneId: 5 } }), null)
  assertEquals(readProviderOrigin({ providerOrigin: 'x' }), null)
  assertEquals(readProviderOrigin({}), null)
  assertEquals(readProviderOrigin(null), null)
})

test('a certificate for a hostname is the latest ready one whose zone covers it', () => {
  const older = row({ notAfter: '2027-01-01T00:00:00.000Z' })
  const newer = row({ notAfter: '2028-01-01T00:00:00.000Z' })
  const other = row({ link: { zoneName: 'other.org' } })
  const revoked = row({ status: 'revoked', notAfter: '2030-01-01T00:00:00.000Z' })
  const upload = row({ source: 'upload', notAfter: '2031-01-01T00:00:00.000Z' })
  const rows = [older, newer, other, revoked, upload]
  assertEquals(pickOriginCertificate(rows, 'App.Example.com')?.id, newer.id)
  assertEquals(pickOriginCertificate(rows, 'example.com')?.id, newer.id)
  assertEquals(pickOriginCertificate(rows, 'x.other.org')?.id, other.id)
  // One label only: a name two labels down is not covered by the wildcard.
  assertEquals(pickOriginCertificate(rows, 'a.b.example.com'), null)
  assertEquals(pickOriginCertificate(rows, 'unrelated.net'), null)
  assertEquals(pickOriginCertificate([row({ link: null })], 'example.com'), null)
})

test('a certificate is superseded only by a newer one for the same account and zone', () => {
  const first = row({ createdAt: '2026-01-01T00:00:00.000Z' })
  const second = row({ createdAt: '2026-02-01T00:00:00.000Z' })
  const otherZone = row({ createdAt: '2026-03-01T00:00:00.000Z', link: { zoneName: 'other.org' } })
  const otherAccount = row({ createdAt: '2026-03-01T00:00:00.000Z', link: { carrierId: 'c2' } })
  assertEquals(isSuperseded([first, second], first), true)
  assertEquals(isSuperseded([first, second], second), false)
  assertEquals(isSuperseded([first, otherZone, otherAccount], first), false)
  assertEquals(isSuperseded([row({ link: null })], row({ link: null })), false)
})

test('a token covers a zone only when its recorded certificate rights name it', () => {
  const badge = {
    capabilities: {
      tunnels: true,
      dns: [],
      certificates: [{ id: 'z1', name: 'Example.com' }],
    },
    options: {},
    status: 'active',
  } as unknown as BadgeRow
  assertEquals(badgeCoversZone(badge, 'example.com')?.id, 'z1')
  assertEquals(badgeCoversZone(badge, ' EXAMPLE.com ')?.id, 'z1')
  assertEquals(badgeCoversZone(badge, 'other.org'), null)
  const none = { ...badge, capabilities: { tunnels: true, dns: [], certificates: [] } } as BadgeRow
  assertEquals(badgeCoversZone(none, 'example.com'), null)
})
