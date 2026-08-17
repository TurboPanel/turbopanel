import { assertEquals } from 'jsr:@std/assert'
import { mergeServerMetadataIdentity } from './server-registry.ts'
import type { ServerReportedIp } from './server-addresses.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// `mergeServerMetadataIdentity` is a pure merge over `server.metadata` jsonb
// (os / resources / timeSync / ips / geo) — hostname and machineKey are dedicated
// `server` columns now (see `identityColumnPatch` / `touchServerMetadata` in
// server-registry.ts) and are never read or written by this function.

test('mergeServerMetadataIdentity merges os and skips unchanged writes', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13',
    codename: 'trixie',
  }
  const merged = mergeServerMetadataIdentity(
    {},
    { os },
  )
  assertEquals(merged, { os })

  assertEquals(
    mergeServerMetadataIdentity(
      { os },
      { os },
    ),
    null,
  )
})

test('mergeServerMetadataIdentity merges timeSync/ips without clobbering os/geo', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13.5',
  }
  const geo = { country: 'US', city: 'Chicago' }
  const ips: ServerReportedIp[] = [
    { address: '10.0.0.1', version: 4, scope: 'private' },
    { address: '203.0.113.10', version: 4, scope: 'public' },
  ]
  const merged = mergeServerMetadataIdentity(
    {
      os,
      geo,
      timeSync: { timezone: 'UTC', ntpEnabled: true, ntpServers: ['a'] },
    },
    {
      timeSync: { timezone: 'America/Chicago' },
      ips,
    },
  )
  assertEquals(merged?.os, os)
  assertEquals(merged?.geo, geo)
  assertEquals(merged?.timeSync?.timezone, 'America/Chicago')
  assertEquals(merged?.timeSync?.ntpEnabled, true)
  assertEquals(merged?.timeSync?.ntpServers, ['a'])
  assertEquals(merged?.ips, ips)
  assertEquals(typeof merged?.timeSync?.capturedAt, 'string')

  assertEquals(
    mergeServerMetadataIdentity(
      {
        timeSync: {
          timezone: 'America/Chicago',
          ntpEnabled: true,
          ntpServers: ['a'],
        },
        ips,
      },
      {
        timeSync: {
          timezone: 'America/Chicago',
          ntpEnabled: true,
          ntpServers: ['a'],
        },
        ips,
      },
    ),
    null,
  )
})

test('mergeServerMetadataIdentity replaces stale ips with empty daemon report', () => {
  const prior: ServerReportedIp[] = [
    { address: '10.0.0.1', version: 4, scope: 'private' },
    { address: '203.0.113.10', version: 4, scope: 'public' },
  ]
  const emptyReport: ServerReportedIp[] = []
  const merged = mergeServerMetadataIdentity(
    { ips: prior },
    { ips: emptyReport },
  )
  assertEquals(merged?.ips, emptyReport)
})

test('mergeServerMetadataIdentity ignores hostname/machineKey on the identity payload', () => {
  // Passing hostname/machineKey (dedicated columns) alongside no metadata-worthy
  // change must not produce a patch — those fields never reach `server.metadata`.
  const merged = mergeServerMetadataIdentity(
    {},
    { hostname: 'new-host', machineKey: 'mid-1' },
  )
  assertEquals(merged, null)
})

test('mergeServerMetadataIdentity treats null/undefined current as empty base', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13',
  }
  assertEquals(mergeServerMetadataIdentity(null, { os }), { os })
  assertEquals(mergeServerMetadataIdentity(undefined, { os }), { os })
})

test('mergeServerMetadataIdentity ignores invalid os and empty patches', () => {
  assertEquals(
    mergeServerMetadataIdentity(
      { os: { family: 'linux', id: 'debian', version: '13' } },
      { os: { family: 'not-a-family' } as never },
    ),
    null,
  )
  assertEquals(mergeServerMetadataIdentity({ geo: { country: 'US' } }, {}), null)
})

test('mergeServerMetadataIdentity deep-merges timeSync NTP fields', () => {
  const merged = mergeServerMetadataIdentity(
    {
      timeSync: {
        timezone: 'UTC',
        ntpEnabled: true,
        ntpServers: ['a.example'],
        fallbackNtpServers: ['b.example'],
      },
    },
    {
      timeSync: {
        timezone: 'America/Chicago',
        ntpEnabled: false,
      },
    },
  )
  assertEquals(merged?.timeSync?.timezone, 'America/Chicago')
  assertEquals(merged?.timeSync?.ntpEnabled, false)
  assertEquals(merged?.timeSync?.ntpServers, ['a.example'])
  assertEquals(merged?.timeSync?.fallbackNtpServers, ['b.example'])
})

test('mergeServerMetadataIdentity merges docker without clobbering os/geo', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13.5',
  }
  const geo = { country: 'US', city: 'Chicago' }
  const merged = mergeServerMetadataIdentity(
    { os, geo },
    { docker: { version: '28.3.3', composeVersion: '2.39.1' } },
  )
  assertEquals(merged?.os, os)
  assertEquals(merged?.geo, geo)
  assertEquals(merged?.docker, { version: '28.3.3', composeVersion: '2.39.1' })

  assertEquals(
    mergeServerMetadataIdentity(
      { docker: { version: '28.3.3', composeVersion: '2.39.1' } },
      { docker: { version: '28.3.3', composeVersion: '2.39.1' } },
    ),
    null,
  )
})

test('mergeServerMetadataIdentity replaces docker when compose appears later', () => {
  const merged = mergeServerMetadataIdentity(
    { docker: { version: '28.3.3' } },
    { docker: { version: '28.3.3', composeVersion: '2.39.1' } },
  )
  assertEquals(merged?.docker, { version: '28.3.3', composeVersion: '2.39.1' })
})
