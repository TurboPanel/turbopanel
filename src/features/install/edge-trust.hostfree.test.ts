import { assertEquals, assertNotEquals } from '@std/assert'
import { edgeTrustForModes, providersForModes, type EdgeTrustState } from './edge-trust.ts'

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
