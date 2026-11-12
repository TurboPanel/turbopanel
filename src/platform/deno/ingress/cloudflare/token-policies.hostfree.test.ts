import { assertEquals } from '@std/assert'
import { type CloudflareTokenPolicy, dnsGrant, tunnelGrant } from './token-policies.ts'

const test = Deno.test.bind(Deno)

const ACCOUNT = 'acct-1'
const ACCOUNT_KEY = `com.cloudflare.api.account.${ACCOUNT}`
const ZONE = 'com.cloudflare.api.account.zone.'
const ZONES = [
  { id: 'zone-1', name: 'example.com' },
  { id: 'zone-2', name: 'turbopanel.dev' },
]

function policy(
  effect: string,
  resources: Record<string, unknown>,
  names: string[]
): CloudflareTokenPolicy {
  return { effect, resources, permission_groups: names.map((name) => ({ name })) }
}

test('DNS Edit through the nested account form with one named zone covers only that zone', () => {
  const grant = dnsGrant(
    [policy('allow', { [ACCOUNT_KEY]: { [`${ZONE}zone-2`]: '*' } }, ['DNS Write'])],
    ACCOUNT,
    ZONES
  )
  assertEquals(grant, { zones: [ZONES[1]!], allZones: false, denied: false })
})

test('a nested form whose zone wildcard value is not "*" does not reach every zone', () => {
  const grant = dnsGrant(
    [
      policy('allow', { [`${ZONE}zone-1`]: '*' }, ['DNS Write']),
      policy('allow', { [ACCOUNT_KEY]: { [`${ZONE}*`]: 'read' } }, ['DNS Write']),
    ],
    ACCOUNT,
    ZONES
  )
  assertEquals(grant, { zones: [ZONES[0]!], allZones: false, denied: false })
})

test('Tunnel Edit through the all-accounts wildcard counts as the account', () => {
  const grant = tunnelGrant(
    [policy('allow', { 'com.cloudflare.api.account.*': '*' }, ['Cloudflare Tunnel Write'])],
    ACCOUNT
  )
  assertEquals(grant, { kind: 'account' })
})

test('a deny on the zones of the account (nested map) does not take Tunnel Edit away', () => {
  const grant = tunnelGrant(
    [
      policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write']),
      policy('deny', { [ACCOUNT_KEY]: { [`${ZONE}*`]: '*' } }, ['Cloudflare Tunnel Write']),
    ],
    ACCOUNT
  )
  assertEquals(grant, { kind: 'account' })
})

test('Tunnel Edit on the all-zones wildcard is zone-only', () => {
  const grant = tunnelGrant(
    [policy('allow', { [`${ZONE}*`]: '*' }, ['Cloudflare Tunnel Write'])],
    ACCOUNT
  )
  assertEquals(grant, { kind: 'zone-only', zoneIds: [] })
})

test('dashboard names (Edit) and the legacy Argo Tunnel Write name count', () => {
  for (const name of ['Cloudflare Tunnel Edit', 'Argo Tunnel Write']) {
    assertEquals(tunnelGrant([policy('allow', { [ACCOUNT_KEY]: '*' }, [name])], ACCOUNT), {
      kind: 'account',
    })
  }
  const dns = dnsGrant([policy('allow', { [ACCOUNT_KEY]: '*' }, ['DNS Edit'])], ACCOUNT, ZONES)
  assertEquals(dns.zones, ZONES)
  assertEquals(dns.allZones, true)
})

test('read groups and unknown effects grant nothing', () => {
  assertEquals(
    tunnelGrant([policy('allow', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Read'])], ACCOUNT),
    { kind: 'missing' }
  )
  assertEquals(
    tunnelGrant([policy('maybe', { [ACCOUNT_KEY]: '*' }, ['Cloudflare Tunnel Write'])], ACCOUNT),
    { kind: 'missing' }
  )
})
