/**
 * Host-free coverage for per-login source limits and connection caps:
 * validation, range translation, wire resolution and the PATCH preview.
 */

import { assertEquals } from '@std/assert'
import { planLoginPatch } from './login-patch.ts'
import {
  cidrToSourcePrefix,
  LOGIN_SOURCES_ANYWHERE,
  loginSourcesFromStored,
  loginSourcesToStored,
  loginWireLimits,
  parseLoginAllowedSources,
  parseLoginMaxConnections,
} from './login-sources.ts'

const test = Deno.test.bind(Deno)
const SERVER = '01a14499-25e2-76b7-bfbf-51dccf02b389'

const errorOf = (value: unknown) =>
  typeof value === 'object' && value !== null && 'error' in value
    ? (value as { error: string }).error
    : undefined

test('ranges become prefixes only when the proxy can match them exactly', () => {
  assertEquals(cidrToSourcePrefix('203.0.113.0/24'), '203.0.113.%')
  assertEquals(cidrToSourcePrefix('10.0.0.0/8'), '10.%')
  assertEquals(cidrToSourcePrefix('172.16.0.0/16'), '172.16.%')
  assertEquals(cidrToSourcePrefix('198.51.100.7/32'), '198.51.100.7')
  assertEquals(cidrToSourcePrefix('2001:db8::/32'), '2001:db8:%')
  assertEquals(cidrToSourcePrefix('2001:db8:1:2::/64'), '2001:db8:1:2:%')
  for (const bad of [
    '10.0.0.0/20',
    '10.0.0.0/0',
    '2001:db8::/36',
    '2001:db8::/8',
    '2001:0:1::/48',
  ]) {
    assertEquals(errorOf(cidrToSourcePrefix(bad)), 'managed_login_source_range_not_exact', bad)
  }
  assertEquals(errorOf(cidrToSourcePrefix('nope/24')), 'managed_login_source_invalid')
})

test('allowedSources: any alone clears, an empty list is refused, mixes are checked', () => {
  assertEquals(parseLoginAllowedSources(['any']), null)
  assertEquals(parseLoginAllowedSources(null), null)
  assertEquals(errorOf(parseLoginAllowedSources([])), 'managed_login_sources_empty')
  assertEquals(
    errorOf(parseLoginAllowedSources(['any', 'internal'])),
    'managed_login_sources_any_alone'
  )
  assertEquals(errorOf(parseLoginAllowedSources('internal')), 'managed_login_sources_invalid')
  assertEquals(errorOf(parseLoginAllowedSources(['10.0.0.1'])), 'managed_login_source_invalid')
  assertEquals(errorOf(parseLoginAllowedSources(['server:abc'])), 'managed_login_source_invalid')
  assertEquals(
    errorOf(parseLoginAllowedSources(['address:300.1.1.1'])),
    'managed_login_source_invalid'
  )
  assertEquals(
    errorOf(parseLoginAllowedSources(['address:10.%.1'])),
    'managed_login_source_invalid'
  )
  assertEquals(errorOf(parseLoginAllowedSources(['address:%'])), 'managed_login_source_invalid')
  assertEquals(parseLoginAllowedSources(['address:2001:DB8:0000::1', 'address:2001:0DB8:1:%']), [
    'address:2001:db8::1',
    'address:2001:db8:1:%',
  ])
  assertEquals(parseLoginAllowedSources(['address:2001:DB8::1/128']), ['address:2001:db8::1'])
  assertEquals(
    errorOf(parseLoginAllowedSources(['address:10.0.0.0/12'])),
    'managed_login_source_range_not_exact'
  )
  assertEquals(
    errorOf(parseLoginAllowedSources(Array.from({ length: 101 }, (_, i) => `address:10.0.0.${i}`))),
    'managed_login_sources_too_many'
  )
  assertEquals(
    parseLoginAllowedSources([
      'internal',
      `server:${SERVER.toUpperCase()}`,
      'address:203.0.113.0/24',
      'address:198.51.100.7',
      'address:2001:db8:1:%',
      'address:198.51.100.7',
    ]),
    [
      'internal',
      `server:${SERVER}`,
      'address:203.0.113.%',
      'address:198.51.100.7',
      'address:2001:db8:1:%',
    ]
  )
})

test('maxConnections: whole numbers in range, null clears', () => {
  assertEquals(parseLoginMaxConnections(5), 5)
  assertEquals(parseLoginMaxConnections(null), null)
  for (const bad of [0, -1, 1.5, '5', 10_001, undefined]) {
    assertEquals(errorOf(parseLoginMaxConnections(bad)), 'managed_login_max_connections_invalid')
  }
})

test('wire limits resolve servers, keep prefixes, and fail closed on an old daemon', () => {
  const metadata = {
    allowedSources: ['internal', `server:${SERVER}`, 'address:203.0.113.%'],
    maxConnections: 3,
  }
  const addresses = new Map([[SERVER, ['198.51.100.7', '2001:db8::7']]])
  assertEquals(
    loginWireLimits(metadata, { daemonSupportsLimits: true, serverAddresses: addresses }),
    {
      omit: false,
      fields: {
        allowedSources: ['198.51.100.7', '2001:db8::7', '203.0.113.%'],
        allowLocalSources: true,
        maxConnections: 3,
      },
    }
  )
  assertEquals(
    loginWireLimits(metadata, { daemonSupportsLimits: false, serverAddresses: addresses }),
    {
      omit: true,
    }
  )
  // Naming the server the payload is for lets its own programs in (they arrive as the gateway).
  assertEquals(
    loginWireLimits(
      { allowedSources: [`server:${SERVER}`], maxConnections: undefined },
      { daemonSupportsLimits: true, serverAddresses: new Map(), serverId: SERVER }
    ),
    { omit: false, fields: { allowedSources: [], allowLocalSources: true } }
  )
  // No source limit: nothing sent to an old daemon, so version skew changes nothing.
  assertEquals(
    loginWireLimits(
      { allowedSources: undefined, maxConnections: 3 },
      { daemonSupportsLimits: false, serverAddresses: addresses }
    ),
    { omit: false, fields: {} }
  )
  assertEquals(
    loginWireLimits(
      { allowedSources: undefined, maxConnections: undefined },
      { daemonSupportsLimits: true, serverAddresses: addresses }
    ),
    {
      omit: false,
      fields: {},
    }
  )
  // A server with no known address still limits the login (nothing but local passes).
  assertEquals(
    loginWireLimits(
      { allowedSources: [`server:${SERVER}`], maxConnections: undefined },
      { daemonSupportsLimits: true, serverAddresses: new Map() }
    ),
    { omit: false, fields: { allowedSources: [] } }
  )
})

test('PATCH plans store, clear and describe limits in plain words', () => {
  const base = {
    role: 'user' as const,
    grantMode: 'recipe' as const,
    tool: false,
    databases: [],
    privileges: [],
    connectionRole: 'read-write' as const,
    allowedSources: undefined,
    maxConnections: undefined,
  }
  const current = base
  const set = planLoginPatch('postgres', current, {
    allowedSources: ['internal', 'address:198.51.100.7'],
    maxConnections: 2,
  })
  if (!set.ok) throw new Error('expected ok')
  assertEquals(set.patch.allowedSources, ['internal', 'address:198.51.100.7'])
  assertEquals(set.patch.maxConnections, 2)
  assertEquals(
    set.summary.some((line) => line.includes('refuses every query from other addresses')),
    true
  )
  assertEquals(
    set.summary.some((line) => line.includes('at most 2 connections')),
    true
  )

  const cleared = planLoginPatch(
    'mysql',
    { ...base, allowedSources: ['internal'], maxConnections: 2 },
    { allowedSources: null, maxConnections: null }
  )
  if (!cleared.ok) throw new Error('expected ok')
  assertEquals(cleared.patch.allowedSources, null)
  assertEquals(cleared.patch.maxConnections, null)
  assertEquals(
    cleared.summary.some((line) => line.includes('from anywhere')),
    true
  )
})

test('anywhere is stored as the explicit pair and read back as no limit', () => {
  assertEquals([...LOGIN_SOURCES_ANYWHERE], ['address:0.0.0.0/0', 'address:::/0'])
  assertEquals(loginSourcesToStored(undefined), ['address:0.0.0.0/0', 'address:::/0'])
  assertEquals(loginSourcesToStored(null), ['address:0.0.0.0/0', 'address:::/0'])
  assertEquals(loginSourcesToStored(['internal']), ['internal'])
  assertEquals(loginSourcesFromStored(['address:0.0.0.0/0', 'address:::/0']), undefined)
  assertEquals(loginSourcesFromStored(null), undefined)
  assertEquals(loginSourcesFromStored(['internal', 'address:203.0.113.7']), [
    'internal',
    'address:203.0.113.7',
  ])
})

test('typing the full-open ranges means anywhere; mixing them with other places is refused', () => {
  assertEquals(parseLoginAllowedSources(['address:0.0.0.0/0']), null)
  assertEquals(parseLoginAllowedSources(['address:::/0']), null)
  assertEquals(parseLoginAllowedSources(['address:0::/0']), null)
  assertEquals(
    errorOf(parseLoginAllowedSources(['address:0.0.0.0/0', 'internal'])),
    'managed_login_sources_any_alone'
  )
})

test('host names are refused in plain words', () => {
  const refused = parseLoginAllowedSources(['address:db.example.com'])
  assertEquals(errorOf(refused), 'managed_login_source_invalid')
  assertEquals(String((refused as { message: string }).message).includes('Host names'), true)
  assertEquals(
    errorOf(parseLoginAllowedSources(['address:2001:db8::/56'])),
    'managed_login_source_range_not_exact'
  )
})
