/**
 * Choosing among several API Tokens of one account: only active tokens, the
 * one limited to the zone before one that reaches many, zones matched by id,
 * the reason when none qualifies, the zone of a hostname from stored scopes,
 * and the warnings a token carries. No database.
 */
import { assert, assertEquals } from '@std/assert'
import { lossOf } from './badge-dependents.ts'
import {
  type BadgeRow,
  badgeWarnings,
  findStoredZone,
  parseBadgeBody,
  pickBadges,
} from './records.ts'
import type { BadgeCapabilities } from './vocabulary.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; keeps Sonar's test detection happy. */
const test = Deno.test.bind(Deno)

const ZONE_A = { id: 'zone-a', name: 'example.com' }
const ZONE_B = { id: 'zone-b', name: 'shop.example.org' }
const ZONE_C = { id: 'zone-c', name: 'deep.example.com' }

function badgeRow(
  id: string,
  capabilities: Partial<BadgeCapabilities>,
  extra: Partial<BadgeRow> = {}
): BadgeRow {
  return {
    id,
    carrierId: 'carrier-1',
    secretId: `secret-${id}`,
    label: id,
    lastFour: '1234',
    capabilities: {
      tunnels: false,
      dns: [],
      certificates: [],
      ...capabilities,
    },
    options: {},
    status: 'active',
    expiresAt: null,
    lastCheckedAt: '2026-10-28T10:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  } as BadgeRow
}

const ids = (rows: readonly BadgeRow[]) => rows.map((r) => r.id)

test('a tunnel call takes the active tokens that reach tunnels, most recently checked first', () => {
  const rows = [
    badgeRow(
      'old',
      { tunnels: true },
      {
        lastCheckedAt: '2026-10-01T00:00:00.000Z',
      }
    ),
    badgeRow(
      'fresh',
      { tunnels: true },
      {
        lastCheckedAt: '2026-10-28T00:00:00.000Z',
      }
    ),
    badgeRow('dns-only', { dns: [ZONE_A] }),
    badgeRow('broken', { tunnels: true }, { status: 'attention' }),
  ]
  const picked = pickBadges(rows, { capability: 'tunnels' })
  assertEquals(ids(picked.badges), ['fresh', 'old'])
  assertEquals(picked.missing, null)
})

test('a token limited to the zone comes before one that reaches many zones', () => {
  const rows = [
    badgeRow(
      'wide',
      { dns: [ZONE_A, ZONE_B, ZONE_C] },
      {
        createdAt: '2026-09-01T00:00:00.000Z',
      }
    ),
    badgeRow('narrow', { dns: [ZONE_A] }),
    badgeRow('other-zone', { dns: [ZONE_B] }),
  ]
  const picked = pickBadges(rows, { capability: 'dns', zone: ZONE_A })
  assertEquals(ids(picked.badges), ['narrow', 'wide'])
})

test('zones are matched by id, so a zone deleted and added again does not match its old id', () => {
  const rows = [badgeRow('re-added', { dns: [{ id: 'zone-new', name: 'example.com' }] })]
  const picked = pickBadges(rows, {
    capability: 'dns',
    zone: { id: 'zone-old', name: 'example.com' },
  })
  assertEquals(picked.badges, [])
  assertEquals(picked.missing, 'zone')
})

test('the reason says whether no token has the right or none covers the zone', () => {
  const noDns = pickBadges([badgeRow('t', { tunnels: true })], {
    capability: 'dns',
    zone: ZONE_A,
  })
  assertEquals(noDns.missing, 'capability')
  const otherZone = pickBadges([badgeRow('d', { dns: [ZONE_B] })], {
    capability: 'dns',
    zone: ZONE_A,
  })
  assertEquals(otherZone.missing, 'zone')
  const attentionOnly = pickBadges([badgeRow('d', { dns: [ZONE_A] }, { status: 'attention' })], {
    capability: 'dns',
    zone: ZONE_A,
  })
  assertEquals(attentionOnly.missing, 'capability')
  const certificates = pickBadges([badgeRow('c', { certificates: [ZONE_A] })], {
    capability: 'certificates',
    zone: ZONE_A,
  })
  assertEquals(ids(certificates.badges), ['c'])
})

test('a hostname belongs to the longest zone any active token reaches', () => {
  const rows = [
    badgeRow('a', { dns: [ZONE_A] }),
    badgeRow('c', { dns: [ZONE_C] }),
    badgeRow(
      'gone',
      { dns: [{ id: 'zone-x', name: 'www.deep.example.com' }] },
      { status: 'attention' }
    ),
  ]
  assertEquals(findStoredZone(rows, 'www.deep.example.com')?.id, 'zone-c')
  assertEquals(findStoredZone(rows, 'blog.example.com')?.id, 'zone-a')
  assertEquals(findStoredZone(rows, 'example.com')?.id, 'zone-a')
  assertEquals(findStoredZone(rows, 'notexample.com'), null)
  assertEquals(findStoredZone(rows, 'other.net'), null)
})

test('what a token alone covers is what would be lost without it', () => {
  const tunnelToken = badgeRow('t', { tunnels: true })
  const dnsA = badgeRow('a', { dns: [ZONE_A] })
  const dnsAB = badgeRow('ab', { dns: [ZONE_A, ZONE_B] })
  const lossOfAb = lossOf(dnsAB.capabilities as BadgeCapabilities, [tunnelToken, dnsA])
  assertEquals(lossOfAb.tunnels, false)
  assertEquals(
    lossOfAb.dnsZones.map((z) => z.id),
    ['zone-b']
  )
  const lossOfTunnel = lossOf(tunnelToken.capabilities as BadgeCapabilities, [dnsA])
  assertEquals(lossOfTunnel.tunnels, true)
  const coveredByBroken = lossOf(dnsA.capabilities as BadgeCapabilities, [
    badgeRow('x', { dns: [ZONE_A] }, { status: 'attention' }),
  ])
  assertEquals(coveredByBroken.dnsZones.length, 1)
})

test('a token near its expiry, or one the provider refused, carries a plain warning', () => {
  const now = new Date('2026-10-28T00:00:00.000Z')
  assertEquals(badgeWarnings(badgeRow('a', {}), now), [])
  const soon = badgeWarnings(badgeRow('b', {}, { expiresAt: '2026-11-04T00:00:00.000Z' }), now)
  assertEquals(soon, ['This API Token expires in 7 days.'])
  const gone = badgeWarnings(badgeRow('c', {}, { expiresAt: '2026-10-27T00:00:00.000Z' }), now)
  assertEquals(gone, ['This API Token has expired.'])
  const refused = badgeWarnings(
    badgeRow(
      'd',
      {},
      {
        options: {
          lastFailure: {
            capability: 'dns',
            zone: 'example.com',
            at: '2026-10-27T00:00:00Z',
          },
        },
      }
    ),
    now
  )
  assert(refused[0]!.includes('edit DNS for example.com'))
})

test('zones named with a token are checked for shape and capped', () => {
  const body = { label: 'Zone Token', token: 'x'.repeat(40) }
  const ok = parseBadgeBody({
    ...body,
    zones: [{ id: 'abc123', name: 'Example.COM' }, { id: 'abc123' }],
  })
  assert(ok.ok)
  assertEquals(ok.value.zones, [{ id: 'abc123', name: 'example.com' }])
  assertEquals(parseBadgeBody(body).ok && parseBadgeBody(body), {
    ok: true,
    value: { label: 'Zone Token', token: 'x'.repeat(40), zones: [] },
  })
  assertEquals(parseBadgeBody({ ...body, zones: [{ id: 'bad id!' }] }).ok, false)
  assertEquals(parseBadgeBody({ ...body, zones: [{ id: 'abc', name: 'not a zone' }] }).ok, false)
  assertEquals(
    parseBadgeBody({
      ...body,
      zones: Array.from({ length: 51 }, (_, i) => ({ id: `z${i}` })),
    }).ok,
    false
  )
})
