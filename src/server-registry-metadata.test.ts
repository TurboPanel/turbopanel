import { assertEquals } from '@std/assert'
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
// (resources including ips / docker / geo). Hostname, machineKey, OS, and
// time-sync are dedicated `server` columns (see `touchServerMetadata`).

test('mergeServerMetadataIdentity ignores os (dedicated columns)', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13',
    codename: 'trixie',
  }
  assertEquals(mergeServerMetadataIdentity({}, { os }), null)
  assertEquals(
    mergeServerMetadataIdentity({ geo: { country: 'US' } }, { os }),
    null,
  )
})

test('mergeServerMetadataIdentity merges ips under resources without clobbering geo', () => {
  const geo = { country: 'US', city: 'Chicago' }
  const cpus = [{ cores: { total: 4 }, threads: { total: 8 } }]
  const ips: ServerReportedIp[] = [
    { address: '10.0.0.1', version: 4, scope: 'private', interface: 'eth0' },
    { address: '203.0.113.10', version: 4, scope: 'public', interface: 'eth0' },
  ]
  const merged = mergeServerMetadataIdentity(
    { geo, resources: { cpus } },
    { resources: { ips } },
  )
  assertEquals(merged?.geo, geo)
  assertEquals(merged?.resources?.cpus, cpus)
  assertEquals(merged?.resources?.ips, ips)

  const heartbeatMerged = mergeServerMetadataIdentity(
    { resources: { cpus } },
    { resources: { ips } },
  )
  assertEquals(heartbeatMerged?.resources?.cpus, cpus)
  assertEquals(heartbeatMerged?.resources?.ips, ips)

  assertEquals(
    mergeServerMetadataIdentity(
      { resources: { cpus, ips } },
      { resources: { ips } },
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
    { resources: { ips: prior, cpus: [{ cores: { total: 2 } }] } },
    { resources: { ips: emptyReport } },
  )
  assertEquals(merged?.resources?.ips, emptyReport)
  assertEquals(merged?.resources?.cpus, [{ cores: { total: 2 } }])
})

test('mergeServerMetadataIdentity ignores hostname/machineKey on the identity payload', () => {
  const merged = mergeServerMetadataIdentity(
    {},
    { hostname: 'new-host', machineKey: 'mid-1' },
  )
  assertEquals(merged, null)
})

test('mergeServerMetadataIdentity replaces cpus on hello refresh', () => {
  const merged = mergeServerMetadataIdentity(
    { resources: { cpus: [{ cores: { total: 2 } }] } },
    {
      resources: {
        cpus: [{ cores: { total: 8 }, threads: { total: 16 } }],
      },
    },
  )
  assertEquals(merged?.resources?.cpus, [
    { cores: { total: 8 }, threads: { total: 16 } },
  ])
})

test('mergeServerMetadataIdentity treats null/undefined current as empty base', () => {
  const resources = {
    cpus: [{ cores: { total: 4 }, threads: { total: 8 } }],
  }
  assertEquals(
    mergeServerMetadataIdentity(null, { resources }),
    { resources },
  )
  assertEquals(
    mergeServerMetadataIdentity(undefined, { resources }),
    { resources },
  )
})

test('mergeServerMetadataIdentity ignores empty patches', () => {
  assertEquals(
    mergeServerMetadataIdentity({ geo: { country: 'US' } }, {}),
    null,
  )
})

test('mergeServerMetadataIdentity ignores timeSync (dedicated columns)', () => {
  assertEquals(
    mergeServerMetadataIdentity(
      { resources: { cpus: [{ cores: { total: 1 } }] } },
      {
        timeSync: {
          timezone: 'America/Chicago',
          ntpEnabled: false,
        },
      },
    ),
    null,
  )
})

test('mergeServerMetadataIdentity merges docker without clobbering geo', () => {
  const geo = { country: 'US', city: 'Chicago' }
  const merged = mergeServerMetadataIdentity(
    { geo },
    { docker: { version: '28.3.3', composeVersion: '2.39.1' } },
  )
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
