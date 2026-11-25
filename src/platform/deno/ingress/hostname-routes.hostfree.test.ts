import { assertEquals } from '@std/assert'
import { hostnameChangeAudit } from './hostname-routes.ts'

Deno.test('the hostname change audit carries the proxied flag', () => {
  const base = { host: 'app.example.net', mode: 'direct' as const, publicPort: 443 }
  assertEquals(hostnameChangeAudit({ ...base, behindCdnProxy: true }), {
    ...base,
    behindCdnProxy: true,
  })
  assertEquals(hostnameChangeAudit({ ...base, behindCdnProxy: false }).behindCdnProxy, false)
})
