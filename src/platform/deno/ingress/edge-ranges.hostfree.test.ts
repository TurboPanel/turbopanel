import { assertEquals, assertRejects } from '@std/assert'
import { fetchBunnyRanges, fetchCloudflareRanges } from './edge-ranges.ts'

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
