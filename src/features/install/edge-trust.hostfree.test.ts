import { assertEquals, assertNotEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  EDGE_TRUST_SETTING_KEY,
  edgeTrustForModes,
  emptyEdgeTrustHash,
  loadEdgeTrustState,
  markEdgeTrustApplied,
  providersForModes,
  type EdgeTrustState,
} from './edge-trust.ts'

const test = Deno.test.bind(Deno)

const STATE: EdgeTrustState = {
  cloudflare: { v4: ['198.51.100.0/24', 'not-a-cidr'], v6: ['2001:db8::/32'], fetchedAt: 'x' },
  bunny: { v4: ['203.0.113.7/32'], v6: [], fetchedAt: 'x' },
}

test('only proxy modes need a provider list', () => {
  assertEquals(providersForModes(['direct', 'cloudflare-tunnel', 'lan-only']), [])
  assertEquals(providersForModes(['bunny-proxy', 'cloudflare-proxy']), ['cloudflare', 'bunny'])
})

test('the union holds only the enabled providers and drops invalid entries', async () => {
  const cf = await edgeTrustForModes(STATE, ['cloudflare-proxy'])
  assertEquals(cf.cloudflare, ['198.51.100.0/24', '2001:db8::/32'].sort())
  assertEquals(cf.bunny, [])
  assertEquals(cf.cidrs, cf.cloudflare)
  const both = await edgeTrustForModes(STATE, ['cloudflare-proxy', 'bunny-proxy'])
  assertEquals(both.cidrs.length, 3)
  assertNotEquals(both.hash, cf.hash)
})

test('no edge mode gives an empty set with a stable hash', async () => {
  const a = await edgeTrustForModes(STATE, ['direct'])
  const b = await edgeTrustForModes({}, [])
  assertEquals(a.cidrs, [])
  assertEquals(a.hash, b.hash)
})

type Row = { key: string; value: unknown }

/** Just enough of the query builder for the `setting` reads and upserts used here. */
function fakeSettingsDb(rows: Row[]): Db {
  const select = () => ({
    from: () => ({ where: () => Promise.resolve(rows) }),
  })
  const insert = () => ({
    values: (row: Row) => ({
      onConflictDoUpdate: () => {
        rows.splice(0, rows.length, row)
        return Promise.resolve()
      },
    }),
  })
  return { select, insert } as unknown as Db
}

test('a stored state round-trips and drops malformed parts', async () => {
  const rows: Row[] = [
    {
      key: EDGE_TRUST_SETTING_KEY,
      value: {
        cloudflare: STATE.cloudflare,
        bunny: 'broken',
        appliedHash: 'h',
        appliedAt: 't',
        lastCheckedAt: 'c',
        lastError: { provider: 'bunny', message: 'm', at: 'a' },
      },
    },
  ]
  const state = await loadEdgeTrustState(fakeSettingsDb(rows))
  assertEquals(state.cloudflare, STATE.cloudflare)
  assertEquals(state.bunny, undefined)
  assertEquals(state.appliedHash, 'h')
  assertEquals(state.lastError?.provider, 'bunny')
})

test('an absent or non-object setting reads as an empty state', async () => {
  assertEquals(await loadEdgeTrustState(fakeSettingsDb([])), {})
  const odd: Row[] = [{ key: EDGE_TRUST_SETTING_KEY, value: ['x'] }]
  assertEquals(await loadEdgeTrustState(fakeSettingsDb(odd)), {})
})

test('marking a set applied keeps the ranges and stamps the hash and time', async () => {
  const rows: Row[] = [{ key: EDGE_TRUST_SETTING_KEY, value: { cloudflare: STATE.cloudflare } }]
  const db = fakeSettingsDb(rows)
  await markEdgeTrustApplied(db, 'abc', new Date('2026-11-01T00:00:00Z'))
  const saved = await loadEdgeTrustState(db)
  assertEquals(saved.cloudflare, STATE.cloudflare)
  assertEquals(saved.appliedHash, 'abc')
  assertEquals(saved.appliedAt, '2026-11-01T00:00:00.000Z')
  assertEquals((await emptyEdgeTrustHash()).length, 64)
})
