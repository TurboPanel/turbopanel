import { assertEquals } from 'jsr:@std/assert'
import { mergeServerMetadataIdentity } from './server-registry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mergeServerMetadataIdentity merges os and skips unchanged writes', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13',
    versionCodename: 'trixie',
  }
  const merged = mergeServerMetadataIdentity(
    { hostname: 'old', machineId: 'mid-1' },
    { hostname: 'new', os },
  )
  assertEquals(merged, {
    hostname: 'new',
    machineId: 'mid-1',
    os,
  })

  assertEquals(
    mergeServerMetadataIdentity(
      { hostname: 'new', machineId: 'mid-1', os },
      { hostname: 'new', machineId: 'mid-1', os },
    ),
    null,
  )
})

test('mergeServerMetadataIdentity merges timeSync/addresses without clobbering os/geo', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13.5',
  }
  const geo = { country: 'US', city: 'Chicago' }
  const addresses = {
    privateIpv4: ['10.0.0.1'],
    privateIpv6: [] as string[],
    publicIpv4: ['203.0.113.10'],
    publicIpv6: [] as string[],
  }
  const merged = mergeServerMetadataIdentity(
    {
      hostname: 'web-01',
      os,
      geo,
      timeSync: { timezone: 'UTC', ntpEnabled: true, ntpServers: ['a'] },
    },
    {
      timeSync: { timezone: 'America/Chicago' },
      addresses,
    },
  )
  assertEquals(merged?.os, os)
  assertEquals(merged?.geo, geo)
  assertEquals(merged?.timeSync?.timezone, 'America/Chicago')
  assertEquals(merged?.timeSync?.ntpEnabled, true)
  assertEquals(merged?.timeSync?.ntpServers, ['a'])
  assertEquals(merged?.addresses, addresses)
  assertEquals(typeof merged?.timeSync?.capturedAt, 'string')

  assertEquals(
    mergeServerMetadataIdentity(
      {
        timeSync: {
          timezone: 'America/Chicago',
          ntpEnabled: true,
          ntpServers: ['a'],
        },
        addresses,
      },
      {
        timeSync: {
          timezone: 'America/Chicago',
          ntpEnabled: true,
          ntpServers: ['a'],
        },
        addresses,
      },
    ),
    null,
  )
})

test('mergeServerMetadataIdentity replaces stale addresses with empty daemon report', () => {
  const prior = {
    privateIpv4: ['10.0.0.1'],
    privateIpv6: [] as string[],
    publicIpv4: ['203.0.113.10'],
    publicIpv6: [] as string[],
  }
  const emptyReport = {
    privateIpv4: [] as string[],
    privateIpv6: [] as string[],
    publicIpv4: [] as string[],
    publicIpv6: [] as string[],
  }
  const merged = mergeServerMetadataIdentity(
    { addresses: prior },
    { addresses: emptyReport },
  )
  assertEquals(merged?.addresses, emptyReport)
})
