import { assertEquals, assertRejects } from '@std/assert'
import {
  describeEdgeTrust,
  edgeRefreshDue,
  fetchBunnyRanges,
  fetchCloudflareRanges,
  refreshedEdgeState,
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

test('Cloudflare list keeps valid CIDRs and the etag', async () => {
  const fetchFn = (() =>
    Promise.resolve(
      json({
        result: {
          ipv4_cidrs: ['198.51.100.0/24', 'junk'],
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
      json(url.endsWith('/ipv6') ? ['2001:db8::1'] : ['203.0.113.7', 'bad'])
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
