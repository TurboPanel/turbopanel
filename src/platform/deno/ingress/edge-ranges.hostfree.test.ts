import { assertEquals, assertRejects } from '@std/assert'
import { isSafeEdgeRange } from '../../../features/install/edge-trust.ts'
import type { Db } from '../../../db/connection.ts'
import {
  describeEdgeTrust,
  edgeRefreshDue,
  fetchBunnyRanges,
  fetchCloudflareRanges,
  refreshedEdgeState,
  runEdgeTrustTick,
} from './edge-ranges.ts'

const test = Deno.test.bind(Deno)
const NOW = new Date('2026-11-01T00:00:00Z')

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init)
}

test('Cloudflare list is requested with the stored etag and 304 means unchanged', async () => {
  let sent: string | null = null
  const fetchFn = ((_url: string, init?: RequestInit) => {
    sent = new Headers(init?.headers).get('if-none-match')
    return Promise.resolve(new Response(null, { status: 304 }))
  }) as typeof fetch
  const result = await fetchCloudflareRanges(
    fetchFn,
    { v4: ['198.51.100.0/24'], v6: [], etag: 'abc', fetchedAt: 'x' },
    NOW
  )
  assertEquals(result, 'unchanged')
  assertEquals(sent, 'abc')
})

test('Cloudflare list keeps the etag and every safe range', async () => {
  const fetchFn = (() =>
    Promise.resolve(
      json({
        result: {
          ipv4_cidrs: ['198.51.100.0/24'],
          ipv6_cidrs: ['2001:db8::/32'],
          etag: 'e1',
        },
      })
    )) as typeof fetch
  const result = await fetchCloudflareRanges(fetchFn, undefined, NOW)
  assertEquals(result, {
    v4: ['198.51.100.0/24'],
    v6: ['2001:db8::/32'],
    fetchedAt: NOW.toISOString(),
    etag: 'e1',
  })
})

test('an empty or failing Cloudflare answer is an error, never an empty list', async () => {
  const empty = (() => Promise.resolve(json({ result: {} }))) as typeof fetch
  await assertRejects(() => fetchCloudflareRanges(empty, undefined, NOW))
  const down = (() => Promise.resolve(new Response('no', { status: 503 }))) as typeof fetch
  await assertRejects(() => fetchCloudflareRanges(down, undefined, NOW))
})

test('Bunny addresses become host ranges for both families', async () => {
  const fetchFn = ((url: string) =>
    Promise.resolve(
      json(url.endsWith('/ipv6') ? ['2001:db8::1'] : ['203.0.113.7'])
    )) as typeof fetch
  const result = await fetchBunnyRanges(fetchFn, NOW)
  assertEquals(result.v4, ['203.0.113.7/32'])
  assertEquals(result.v6, ['2001:db8::1/128'])
})

const CF_BODY = { result: { ipv4_cidrs: ['198.51.100.0/24'], ipv6_cidrs: [], etag: 'e2' } }

test('a refresh fetches only the providers the modes need and stamps the check time', async () => {
  const urls: string[] = []
  const fetchFn = ((url: string) => {
    urls.push(url)
    return Promise.resolve(json(CF_BODY))
  }) as typeof fetch
  const next = await refreshedEdgeState({}, ['direct', 'cloudflare-proxy'], fetchFn, NOW)
  assertEquals(urls.length, 1)
  assertEquals(next.cloudflare?.v4, ['198.51.100.0/24'])
  assertEquals(next.bunny, undefined)
  assertEquals(next.lastCheckedAt, NOW.toISOString())
})

test('a failed fetch keeps the previous list, records the error and never empties the set', async () => {
  const previous = { v4: ['198.51.100.0/24'], v6: [], fetchedAt: 'old', etag: 'e1' }
  const down = (() => Promise.resolve(new Response('no', { status: 503 }))) as typeof fetch
  const next = await refreshedEdgeState({ cloudflare: previous }, ['cloudflare-proxy'], down, NOW)
  assertEquals(next.cloudflare, previous)
  assertEquals(next.lastError?.provider, 'cloudflare')
})

test('an unchanged etag keeps the list and moves its fetched time', async () => {
  const previous = { v4: ['198.51.100.0/24'], v6: [], fetchedAt: 'old', etag: 'e1' }
  const same = (() => Promise.resolve(new Response(null, { status: 304 }))) as typeof fetch
  const next = await refreshedEdgeState({ cloudflare: previous }, ['cloudflare-proxy'], same, NOW)
  assertEquals(next.cloudflare?.v4, previous.v4)
  assertEquals(next.cloudflare?.fetchedAt, NOW.toISOString())
  assertEquals(next.lastError, undefined)
})

test('the refresh is due daily, when forced, or when a needed list is missing', () => {
  const fresh = {
    cloudflare: { v4: ['198.51.100.0/24'], v6: [], fetchedAt: 'x' },
    lastCheckedAt: NOW.toISOString(),
  }
  const hourLater = new Date(NOW.getTime() + 3_600_000)
  const dayLater = new Date(NOW.getTime() + 86_400_000)
  assertEquals(edgeRefreshDue(fresh, ['cloudflare-proxy'], hourLater), false)
  assertEquals(edgeRefreshDue(fresh, ['cloudflare-proxy'], hourLater, true), true)
  assertEquals(edgeRefreshDue(fresh, ['cloudflare-proxy'], dayLater), true)
  assertEquals(edgeRefreshDue(fresh, ['cloudflare-proxy', 'bunny-proxy'], hourLater), true)
})

test('the summary shows counts and times and the providers in use, not the lists', () => {
  const state = {
    cloudflare: { v4: ['198.51.100.0/24'], v6: ['2001:db8::/32'], etag: 'e', fetchedAt: 'f' },
    appliedHash: 'h',
  }
  assertEquals(describeEdgeTrust(state, ['cloudflare-proxy', 'direct']), {
    ok: true,
    enabledProviders: ['cloudflare'],
    cloudflare: { count: 2, etag: 'e', fetchedAt: 'f' },
    bunny: null,
    appliedHash: 'h',
    appliedAt: null,
    lastError: null,
  })
})

/** A query builder where every step returns itself and awaiting it gives no rows. */
function emptyDb(): Db {
  const chain: object = new Proxy(() => chain, {
    get: (_target, key) =>
      key === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : chain,
    apply: () => chain,
  })
  return chain as Db
}

test('the scheduled pass sends nothing when no edge mode is in use', async () => {
  let applied = 0
  await runEdgeTrustTick(emptyDb(), () => {
    applied += 1
    return Promise.resolve()
  })
  assertEquals(applied, 0)
})

function cloudflareAnswering(ipv4: string[], ipv6: string[] = []): typeof fetch {
  return (() =>
    Promise.resolve(json({ result: { ipv4_cidrs: ipv4, ipv6_cidrs: ipv6 } }))) as typeof fetch
}

test('a vendor answer with a catch-all, private or loopback range is refused whole', async () => {
  const v4Bad = ['0.0.0.0/0', '10.0.0.0/8', '127.0.0.0/8', '192.168.1.0/24', '100.64.0.0/10']
  const v6Bad = ['::/0', '::1/128', 'fc00::/7', 'fe80::/10', '2001::/8']
  await Promise.all([
    ...v4Bad.map((bad) =>
      assertRejects(
        () => fetchCloudflareRanges(cloudflareAnswering(['198.51.100.0/24', bad]), undefined, NOW),
        Error,
        'unusable range'
      )
    ),
    ...v6Bad.map((bad) =>
      assertRejects(() =>
        fetchCloudflareRanges(cloudflareAnswering(['198.51.100.0/24'], [bad]), undefined, NOW)
      )
    ),
  ])
})

test('a refused answer keeps the last good list and records the error', async () => {
  const previous = { v4: ['198.51.100.0/24'], v6: [], fetchedAt: 'old' }
  const next = await refreshedEdgeState(
    { cloudflare: previous },
    ['cloudflare-proxy'],
    cloudflareAnswering(['0.0.0.0/0']),
    NOW
  )
  assertEquals(next.cloudflare, previous)
  assertEquals(next.lastError?.provider, 'cloudflare')
})

test('a Bunny list with a private address or an oversized answer is refused', async () => {
  const privateList = (() => Promise.resolve(json(['10.1.2.3']))) as typeof fetch
  await assertRejects(() => fetchBunnyRanges(privateList, NOW), Error, 'unusable range')
  const huge = (() =>
    Promise.resolve(
      new Response('[' + '"1.2.3.4",'.repeat(200_000) + '"1.2.3.5"]')
    )) as typeof fetch
  await assertRejects(() => fetchBunnyRanges(huge, NOW), Error, 'too large')
})

test('every fetch has a timeout and refuses redirects', async () => {
  const seen: RequestInit[] = []
  const fetchFn = ((_url: string, init?: RequestInit) => {
    seen.push(init ?? {})
    return Promise.resolve(json({ result: { ipv4_cidrs: ['198.51.100.0/24'] } }))
  }) as typeof fetch
  await fetchCloudflareRanges(fetchFn, undefined, NOW)
  assertEquals(seen[0]?.redirect, 'error')
  assertEquals(seen[0]?.signal instanceof AbortSignal, true)
})

test('the safe-range rule', () => {
  for (const ok of ['173.245.48.0/20', '203.0.113.7/32', '2400:cb00::/32', '2001:db8::1/128']) {
    assertEquals(isSafeEdgeRange(ok), true, ok)
  }
  for (const bad of ['0.0.0.0/0', '1.0.0.0/7', '::/0', '2000::/15', '172.20.0.0/16', 'junk', '']) {
    assertEquals(isSafeEdgeRange(bad), false, bad)
  }
})

test('a list past the entry cap is refused even when it is small in bytes', async () => {
  const many = ((url: string) =>
    Promise.resolve(
      json(url.endsWith('/ipv6') ? [] : Array.from({ length: 5001 }, () => '203.0.113.7'))
    )) as typeof fetch
  await assertRejects(() => fetchBunnyRanges(many, NOW), Error, 'too long')
})
