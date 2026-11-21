import { assertEquals, assertNotEquals } from '@std/assert'
import {
  isEdgeCacheableStatusResponse,
  statusEdgeCacheKey,
  toEdgeCacheEntry,
} from './status-edge-cache.ts'

const status = 'https://panel.example.net/api/client/v1/status'

Deno.test('key ignores query string and cookies', () => {
  const key = statusEdgeCacheKey(
    new Request(`${status}?x=1`, { headers: { Cookie: 'session=abc' } })
  )
  assertEquals(key?.url, status)
})

Deno.test('key only for plain GET /status without Origin', () => {
  assertEquals(statusEdgeCacheKey(new Request(status, { method: 'POST' })), null)
  assertEquals(
    statusEdgeCacheKey(new Request(status, { headers: { Origin: 'https://a.example.net' } })),
    null
  )
  assertEquals(
    statusEdgeCacheKey(new Request('https://panel.example.net/api/client/v1/servers')),
    null
  )
})

Deno.test('only a public 200 without Set-Cookie is stored', () => {
  const pub = { 'Cache-Control': 'public, max-age=30' }
  assertEquals(isEdgeCacheableStatusResponse(new Response('{}', { headers: pub })), true)
  assertEquals(
    isEdgeCacheableStatusResponse(new Response('{}', { status: 503, headers: pub })),
    false
  )
  assertEquals(
    isEdgeCacheableStatusResponse(new Response('{}', { headers: { ...pub, 'Set-Cookie': 'a=b' } })),
    false
  )
  assertEquals(
    isEdgeCacheableStatusResponse(new Response('{}', { headers: { 'Cache-Control': 'no-store' } })),
    false
  )
})

Deno.test('cache entry drops Server-Timing and keeps the body', async () => {
  const original = new Response('{"ok":true}', {
    headers: { 'Cache-Control': 'public, max-age=30', 'Server-Timing': 'app;dur=1.0' },
  })
  const entry = toEdgeCacheEntry(original)
  assertEquals(entry.headers.get('Server-Timing'), null)
  assertEquals(entry.headers.get('Cache-Control'), 'public, max-age=30')
  assertEquals(await entry.text(), '{"ok":true}')
  assertNotEquals(original.headers.get('Server-Timing'), null)
})
