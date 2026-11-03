import { assert, assertEquals } from '@std/assert'
import { scrubSecrets } from '../../../../features/tunnels/scrub.ts'
import {
  accountsDueForRecheck,
  cloudflareTokenShapeProblem,
  listNames,
  preflightCloudflareToken,
  recheckedScopes,
} from './account.ts'
import { createFakeCloudflare } from './fake-cloudflare.test.support.ts'
import { readEdgeTunnel } from './instance-tunnel.ts'

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
    ['token-verify', 'token-policies', 'scope-tunnels', 'scope-dns', 'token-expiry']
  )
})

const ACCOUNT_KEY = 'com.cloudflare.api.account.acct-1'
const ZONES = [
  { id: 'zone-1', name: 'example.com' },
  { id: 'zone-2', name: 'turbopanel.dev' },
  { id: 'zone-3', name: 'other.net' },
]

function policy(
  effect: 'allow' | 'deny',
  resources: Record<string, unknown>,
  names: string[]
): Record<string, unknown> {
  return {
    id: `pol-${effect}-${names.join('-')}`,
    effect,
    resources,
    permission_groups: names.map((name) => ({ id: name, name })),
  }
}

function detail(result: { checks: { id: string; ok: boolean; detail: string }[] }, id: string) {
  return result.checks.find((item) => item.id === id)
}

test('tunnel edit on the account passes and DNS on two zones lists only those zones', async () => {
  const cf = createFakeCloudflare({
    token: TOKEN,
    zones: ZONES,
    policies: [
      policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write']),
      policy(
        'allow',
        {
          'com.cloudflare.api.account.zone.zone-1': '*',
          'com.cloudflare.api.account.zone.zone-2': '*',
        },
        ['DNS Write', 'Zone Read']
      ),
    ],
  })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.ok, true)
  assertEquals(
    detail(result, 'scope-tunnels')?.detail,
    'Cloudflare Tunnel Edit is granted on the account.'
  )
  assertEquals(
    detail(result, 'scope-dns')?.detail,
    'The token can edit DNS in example.com and turbopanel.dev. DNS-01 certificates are issued only for names in these zones.'
  )
  assertEquals(result.zones, ZONES.slice(0, 2))
})

test('tunnel edit in a zone-only policy fails with the zone named (account-owned token)', async () => {
  const cf = createFakeCloudflare({
    token: 'cfat_fixtureTokenValue0123456789abcdef',
    owner: 'account',
    zones: ZONES,
    policies: [
      policy('allow', { 'com.cloudflare.api.account.zone.zone-2': '*' }, [
        'Cloudflare Tunnel Write',
        'Cloudflare Tunnel Read',
        'Zone Read',
        'Zone Write',
        'DNS Read',
        'DNS Write',
      ]),
    ],
  })
  const result = await preflightCloudflareToken(
    'cfat_fixtureTokenValue0123456789abcdef',
    cf.fetch,
    NOW
  )
  assertEquals(result.ok, false)
  assertEquals(detail(result, 'scope-tunnels'), {
    id: 'scope-tunnels',
    ok: false,
    detail:
      'Cloudflare Tunnel Edit is only granted on the turbopanel.dev zone. Give it to the account instead.',
  })
  assertEquals(detail(result, 'scope-dns')?.ok, true)
  assert(cf.log.includes('GET /accounts/acct-1/tokens/tok-1'))
})

test('a token that cannot read its own policies fails and names the permission', async () => {
  const cfat = 'cfat_fixtureTokenValue0123456789abcdef'
  const cf = createFakeCloudflare({
    token: cfat,
    owner: 'account',
    forbidden: [/\/tokens\/tok-1$/],
  })
  const result = await preflightCloudflareToken(cfat, cf.fetch, NOW)
  assertEquals(result.ok, false)
  assertEquals(
    detail(result, 'token-policies')?.detail,
    'The token cannot read its own permissions. Add Account › Account API Tokens › Read to the token.'
  )
  assertEquals(result.zones, [])
})

test('a user-owned token reads itself at the user endpoint, and names the user permission when it cannot', async () => {
  const cf = createFakeCloudflare({ token: TOKEN })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.ok, true)
  assert(cf.log.includes('GET /user/tokens/tok-1'))
  const refused = createFakeCloudflare({ token: TOKEN, forbidden: [/^\/user\/tokens\/tok-1$/] })
  const denied = await preflightCloudflareToken(TOKEN, refused.fetch, NOW)
  assertEquals(
    detail(denied, 'token-policies')?.detail,
    'The token cannot read its own permissions. Add User › API Tokens › Read to the token.'
  )
})

test('DNS edit on the whole account passes with a warning that lists every zone', async () => {
  const cf = createFakeCloudflare({
    token: TOKEN,
    zones: ZONES,
    policies: [
      policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write']),
      policy('allow', { [ACCOUNT_KEY]: { 'com.cloudflare.api.account.zone.*': '*' } }, [
        'DNS Write',
      ]),
    ],
  })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(result.ok, true)
  assertEquals(
    detail(result, 'scope-dns')?.detail,
    'The token can edit DNS in every zone of the account, more than the control plane needs: example.com, turbopanel.dev and other.net. DNS-01 certificates are issued only for names in these zones.'
  )
  assertEquals(result.zones.length, 3)
})

test('deny policies win over allow policies', async () => {
  const cf = createFakeCloudflare({
    token: TOKEN,
    zones: ZONES,
    policies: [
      policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write', 'DNS Write']),
      policy('deny', { 'com.cloudflare.api.account.zone.zone-3': '*' }, ['DNS Write']),
    ],
  })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(
    result.zones.map((zone) => zone.name),
    ['example.com', 'turbopanel.dev']
  )
  const deniedTunnel = createFakeCloudflare({
    token: TOKEN,
    policies: [
      policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write', 'DNS Write']),
      policy('DENY' as 'deny', { 'com.cloudflare.api.account.*': '*' }, [
        'Cloudflare Tunnel Write',
      ]),
    ],
  })
  const denied = await preflightCloudflareToken(TOKEN, deniedTunnel.fetch, NOW)
  assertEquals(
    detail(denied, 'scope-tunnels')?.detail,
    'A deny policy on the token takes Cloudflare Tunnel Edit away from the account. Remove that policy.'
  )
  const deniedDns = createFakeCloudflare({
    token: TOKEN,
    policies: [
      policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write', 'DNS Write']),
      policy('deny', { 'com.cloudflare.api.account.zone.*': '*' }, ['DNS Write']),
    ],
  })
  const noDns = await preflightCloudflareToken(TOKEN, deniedDns.fetch, NOW)
  assertEquals(
    detail(noDns, 'scope-dns')?.detail,
    'A deny policy on the token takes DNS Edit away from every zone it was granted on. Remove that policy.'
  )
})

test('a token without tunnel or DNS edit fails both scope checks', async () => {
  const cf = createFakeCloudflare({
    token: TOKEN,
    policies: [policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Read', 'DNS Read'])],
  })
  const result = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(
    detail(result, 'scope-tunnels')?.detail,
    'The token does not have Cloudflare Tunnel Edit on the account (Account › Cloudflare Tunnel › Edit).'
  )
  assertEquals(
    detail(result, 'scope-dns')?.detail,
    'The token cannot edit DNS records in any zone (Zone › DNS › Edit).'
  )
})

test('a recheck that cannot read the policies keeps the stored scopes', async () => {
  const previous = {
    tunnels: true,
    dns: true,
    checkedAt: '2026-10-01T00:00:00Z',
    zones: [{ id: 'zone-1', name: 'example.com' }],
    expiresOn: null,
  }
  const cf = createFakeCloudflare({ token: TOKEN, forbidden: [/^\/user\/tokens\/tok-1$/] })
  const preflight = await preflightCloudflareToken(TOKEN, cf.fetch, NOW)
  assertEquals(recheckedScopes(previous, preflight, NOW), {
    ...previous,
    checkedAt: NOW.toISOString(),
  })
  assertEquals(recheckedScopes(null, preflight, NOW).tunnels, false)
})

test('listNames joins with commas and "and", and counts past ten', () => {
  assertEquals(listNames(['a']), 'a')
  assertEquals(listNames(['a', 'b', 'c']), 'a, b and c')
  const many = Array.from({ length: 12 }, (_, index) => `z${index}`)
  assertEquals(listNames(many), 'z0, z1, z2, z3, z4, z5, z6, z7, z8, z9 and 2 more')
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

test('the edge view finds a dashboard tunnel through the CNAME and lists its locations and names', async () => {
  const id = '6f0c3c1e-1111-4222-8333-944455556666'
  const cf = createFakeCloudflare({ token: TOKEN })
  cf.tunnels.push({
    id,
    name: 'made-in-dashboard',
    status: 'healthy',
    connections: [{ colo_name: 'nrt01' }, { colo_name: 'kix01' }, { colo_name: 'nrt01' }],
  })
  cf.configurations.set(id, {
    config: {
      ingress: [{ hostname: 'canary.example.com', service: 'x' }, { service: 'http_status:404' }],
    },
  })
  cf.records.set('zone-1', [
    { id: 'r', type: 'CNAME', name: 'canary.example.com', content: `${id}.cfargotunnel.com` },
  ])
  const account = {
    id: 'a',
    provider: 'cloudflare' as const,
    label: 'x',
    accountId: 'acct-1',
    zoneIds: ['zone-1'],
    scopes: {
      tunnels: true,
      dns: true,
      checkedAt: '',
      zones: [{ id: 'zone-1', name: 'example.com' }],
      expiresOn: null,
    },
    lastVerifiedAt: null,
    lastError: null,
    createdAt: '',
  }
  const hostname = {
    id: 'h',
    host: 'https://canary.example.com:8443',
    providerState: null,
  } as unknown as Parameters<typeof readEdgeTunnel>[0]['hostnames'][number]
  const read = await readEdgeTunnel({
    account,
    token: TOKEN,
    fetch: cf.fetch,
    hostnames: [hostname],
    now: NOW,
  })
  assertEquals(read.edge?.tunnelId, id)
  assertEquals(read.edge?.connections, 3)
  assertEquals(read.edge?.locations, ['kix01', 'nrt01'])
  assertEquals(read.edge?.hostnames, ['canary.example.com'])
})
