import { assert, assertEquals } from '@std/assert'
import { scrubSecrets } from '../../../../features/tunnels/scrub.ts'
import {
  accountsDueForRecheck,
  cloudflareTokenShapeProblem,
  preflightCloudflareToken,
} from './account.ts'
import { createFakeCloudflare } from './fake-cloudflare.test.support.ts'

const test = Deno.test.bind(Deno)

const TOKEN = 'cfut_fixtureTokenValue0123456789abcdef'
const NOW = new Date('2026-11-01T00:00:00.000Z')

test('a token with both scopes passes and names its account and zones', async () => {
  const cf = createFakeCloudflare({ token: TOKEN })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.ok, true)
  assertEquals(result.accountId, 'acct-1')
  assertEquals(result.zones, [{ id: 'zone-1', name: 'example.com' }])
  assertEquals(
    result.checks.map((item) => item.id),
    ['token-verify', 'scope-tunnels', 'scope-dns', 'token-expiry']
  )
})

test('a token without DNS edit fails the DNS scope check', async () => {
  const cf = createFakeCloudflare({ token: TOKEN, forbidden: [/dns_records/] })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.ok, false)
  assertEquals(result.checks.find((item) => item.id === 'scope-dns')?.ok, false)
})

test('a token without tunnel edit fails the tunnel scope check', async () => {
  const cf = createFakeCloudflare({ token: TOKEN, forbidden: [/cfd_tunnel/] })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.checks.find((item) => item.id === 'scope-tunnels')?.ok, false)
})

test('a token that expires within 30 days is refused with the date', async () => {
  const cf = createFakeCloudflare({ token: TOKEN, expiresOn: '2026-11-11T00:00:00Z' })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  const expiry = result.checks.find((item) => item.id === 'token-expiry')
  assertEquals(expiry?.ok, false)
  assert(expiry?.detail.includes('2026-11-11'))
})

test('a token Cloudflare does not know fails verify, and no check text holds the token', async () => {
  const cf = createFakeCloudflare({ token: 'cfut_someOtherToken0000000000000000' })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.ok, false)
  for (const item of result.checks) assertEquals(item.detail.includes(TOKEN), false)
})

test('a Global API Key is refused by shape before any request', async () => {
  const cf = createFakeCloudflare({ token: TOKEN })
  const result = await preflightCloudflareToken(
    '0123456789abcdef0123456789abcdef01234',
    cf.fetch,
    NOW
  )
  assertEquals(result.checks[0]?.id, 'token-shape')
  assertEquals(cf.log.length, 0)
  assertEquals(cloudflareTokenShapeProblem(' '), 'Paste a Cloudflare API token.')
})

test('scrubSecrets hides a short prefixed Cloudflare token', () => {
  assertEquals(scrubSecrets('bad token cfut_abc123 here'), 'bad token [redacted] here')
  assertEquals(scrubSecrets('cfat_x-y_z'), '[redacted]')
})

test('accounts older than a day are due for a recheck', () => {
  const base = {
    provider: 'cloudflare' as const,
    label: 'x',
    accountId: null,
    zoneIds: [],
    lastVerifiedAt: null,
    lastError: null,
    createdAt: '',
  }
  const fresh = {
    ...base,
    id: 'a',
    scopes: {
      tunnels: true,
      dns: true,
      checkedAt: '2026-10-31T12:00:00Z',
      zones: [],
      expiresOn: null,
    },
  }
  const stale = {
    ...base,
    id: 'b',
    scopes: {
      tunnels: true,
      dns: true,
      checkedAt: '2026-10-30T00:00:00Z',
      zones: [],
      expiresOn: null,
    },
  }
  const never = { ...base, id: 'c', scopes: null }
  assertEquals(
    accountsDueForRecheck([fresh, stale, never], NOW).map((item) => item.id),
    ['b', 'c']
  )
})
