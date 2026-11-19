import { assertEquals } from '@std/assert'
import { nextBehindCdnProxy } from './service.ts'

Deno.test('the proxied flag is kept or set in direct mode', () => {
  assertEquals(nextBehindCdnProxy('direct', undefined, true), true)
  assertEquals(nextBehindCdnProxy('direct', undefined, false), false)
  assertEquals(nextBehindCdnProxy('direct', true, false), true)
  assertEquals(nextBehindCdnProxy('direct', false, true), false)
})

Deno.test('the proxied flag is cleared in every mode other than direct', () => {
  for (const mode of ['lan-only', 'cloudflare-tunnel', 'cloudflare-proxy', 'bunny-proxy', 'private-overlay', 'passthrough']) {
    assertEquals(nextBehindCdnProxy(mode, undefined, true), false)
    assertEquals(nextBehindCdnProxy(mode, true, true), false)
  }
})
