import { assertEquals, assertThrows } from '@std/assert'
import {
  badgeCoversZone,
  certificateCoversAll,
  certificateRequestNames,
  describeExistingOriginCertificates,
  findCoveringCertificate,
  MAX_ORIGIN_CERTIFICATE_NAMES,
  ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS,
  originCertificateIsDue,
  originCertificateNames,
  OriginCertificateRefusal,
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
  hostnames: ['app.example.com'],
  scope: 'names' as const,
  retiredAt: null,
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

test('a wildcard certificate lists the zone and everything one label below it', () => {
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

test('the provider link is read back only when every part is present', () => {
  assertEquals(readProviderOrigin({ providerOrigin: LINK }), LINK)
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, externalId: '' } }), null)
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, zoneId: 5 } }), null)
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, hostnames: [] } }), null)
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, hostnames: [3] } }), null)
  assertEquals(readProviderOrigin({ providerOrigin: 'x' }), null)
  assertEquals(readProviderOrigin({}), null)
  assertEquals(readProviderOrigin(null), null)
  // Scope defaults to exact names; a retired time is read back.
  const read = readProviderOrigin({
    providerOrigin: {
      ...LINK,
      scope: 'wildcard',
      retiredAt: '2026-02-01T00:00:00.000Z',
    },
  })
  assertEquals(read?.scope, 'wildcard')
  assertEquals(read?.retiredAt, '2026-02-01T00:00:00.000Z')
  assertEquals(readProviderOrigin({ providerOrigin: { ...LINK, scope: 'other' } })?.scope, 'names')
})

test('exact names cover only themselves; a wildcard covers one label', () => {
  const exact = readProviderOrigin({ providerOrigin: LINK })!
  assertEquals(certificateCoversAll(exact, ['app.example.com']), true)
  assertEquals(certificateCoversAll(exact, ['APP.example.com']), true)
  assertEquals(certificateCoversAll(exact, ['other.example.com']), false)
  assertEquals(certificateCoversAll(exact, ['app.example.com', 'other.example.com']), false)
  assertEquals(certificateCoversAll(exact, []), false)
  const wide = readProviderOrigin({
    providerOrigin: {
      ...LINK,
      scope: 'wildcard',
      hostnames: ['example.com', '*.example.com'],
    },
  })!
  assertEquals(certificateCoversAll(wide, ['a.example.com', 'example.com']), true)
  assertEquals(certificateCoversAll(wide, ['a.b.example.com']), false)
})

test('a certificate for a hostname is a ready, unretired one that lists it, exact before wildcard', () => {
  const exact = row({
    link: { hostnames: ['app.example.com'] },
    notAfter: '2027-01-01T00:00:00.000Z',
  })
  const longer = row({
    link: { hostnames: ['app.example.com'] },
    notAfter: '2028-01-01T00:00:00.000Z',
  })
  const wildcard = row({
    link: { scope: 'wildcard', hostnames: ['example.com', '*.example.com'] },
    notAfter: '2030-01-01T00:00:00.000Z',
  })
  const retired = row({ link: { retiredAt: '2026-02-01T00:00:00.000Z' } })
  const other = row({
    link: { zoneName: 'other.org', hostnames: ['x.other.org'] },
  })
  const revoked = row({
    status: 'revoked',
    notAfter: '2032-01-01T00:00:00.000Z',
  })
  const upload = row({
    source: 'upload',
    notAfter: '2031-01-01T00:00:00.000Z',
  })
  const rows = [exact, longer, wildcard, retired, other, revoked, upload]
  const now = new Date('2026-06-01T00:00:00.000Z')
  // The exact certificate that lasts longest beats the wildcard that also covers the name.
  assertEquals(findCoveringCertificate(rows, 'c1', ['app.example.com'], now)?.id, longer.id)
  assertEquals(pickOriginCertificate(rows, 'x.other.org')?.id, other.id)
  // Only the wildcard covers a name the exact certificates do not list, and only one label deep.
  assertEquals(findCoveringCertificate(rows, 'c1', ['new.example.com'], now)?.id, wildcard.id)
  assertEquals(findCoveringCertificate(rows, 'c1', ['a.b.example.com'], now), null)
  // Every name must be covered; another account's certificate is not reused.
  assertEquals(findCoveringCertificate(rows, 'c1', ['app.example.com', 'zzz.net'], now), null)
  assertEquals(findCoveringCertificate(rows, 'c2', ['app.example.com'], now), null)
  assertEquals(findCoveringCertificate([row({ link: null })], null, ['example.com'], now), null)
})

test('a certificate close to expiry is not reused', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')
  const soon = row({
    notAfter: new Date(now.getTime() + 5 * 86_400_000).toISOString(),
  })
  assertEquals(findCoveringCertificate([soon], 'c1', ['app.example.com'], now), null)
})

test('a request lists exact names inside the zone, sorted, once, within the provider limit', () => {
  assertEquals(
    certificateRequestNames(
      'Example.com',
      ['B.example.com', 'a.example.com', 'a.example.com'],
      'names'
    ),
    ['a.example.com', 'b.example.com']
  )
  assertEquals(certificateRequestNames('example.com', ['example.com'], 'names'), ['example.com'])
  // A wildcard is only ever the zone and one label below it, whatever names were given.
  assertEquals(certificateRequestNames('example.com', ['a.example.com'], 'wildcard'), [
    'example.com',
    '*.example.com',
  ])
  const refused = (names: string[] | undefined) =>
    assertThrows(
      () => certificateRequestNames('example.com', names, 'names'),
      OriginCertificateRefusal
    )
  refused(undefined)
  refused([])
  refused(['*.example.com'])
  refused(['elsewhere.org'])
  refused(['notexample.com'])
  refused(['bad name.example.com'])
  refused(Array.from({ length: MAX_ORIGIN_CERTIFICATE_NAMES + 1 }, (_, i) => `n${i}.example.com`))
  assertEquals(
    certificateRequestNames(
      'example.com',
      Array.from({ length: MAX_ORIGIN_CERTIFICATE_NAMES }, (_, i) => `n${i}.example.com`),
      'names'
    ).length,
    MAX_ORIGIN_CERTIFICATE_NAMES
  )
})

test('the provider list shows which certificates TurboPanel issued and which it cannot install', () => {
  const ours = row({
    link: { externalId: 'ours', hostnames: ['app.example.com'] },
  })
  const retired = row({
    link: { externalId: 'gone', retiredAt: '2026-02-01T00:00:00.000Z' },
  })
  const listed = describeExistingOriginCertificates(
    [
      {
        externalId: 'foreign',
        hostnames: ['*.example.com', 'example.com'],
        notAfter: null,
        certificatePem: 'pem',
      },
      {
        externalId: 'ours',
        hostnames: ['app.example.com'],
        notAfter: '2027-01-01T00:00:00.000Z',
        certificatePem: 'pem',
      },
      {
        externalId: 'gone',
        hostnames: ['old.example.com'],
        notAfter: null,
        certificatePem: null,
      },
    ],
    [ours, retired],
    'Example.com'
  )
  assertEquals(
    listed.map((c) => [c.externalId, c.issuedHere, c.wildcard, c.retired, c.tlsId]),
    [
      // Code-point order of the first name: the wildcard sorts before the exact names.
      ['foreign', false, true, false, null],
      ['ours', true, false, false, ours.id],
      ['gone', true, false, true, retired.id],
    ]
  )
  const foreign = listed.find((c) => c.externalId === 'foreign')!
  assertEquals(foreign.note.includes('never revokes a certificate it did not issue'), true)
  assertEquals(foreign.note.includes('upload'), true)
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
  const none = {
    ...badge,
    capabilities: { tunnels: true, dns: [], certificates: [] },
  } as BadgeRow
  assertEquals(badgeCoversZone(none, 'example.com'), null)
})
