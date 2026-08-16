import { assertEquals } from 'jsr:@std/assert'
import {
  parseServerIps,
  serverIpsEquals,
  ipsFromDaemonPresence,
} from '../../server-addresses.ts'
import {
  formatServerOsDisplay,
  parseServerOptions,
  parseServerOsMetadata,
  parseServerHostResources,
  parseServerTimeSync,
  resolveEffectiveServerTimezone,
  resolveServerResponseTimezone,
  resolveServerOsLogoKey,
  serverOsMetadataEquals,
  serverHostResourcesEquals,
  serverTimeSyncEquals,
  resourcesFromDaemonPresence,
} from './server-metadata.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('formatServerOsDisplay formats Debian with point release', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'debian',
      version: '13.5',
      codename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    }),
    'Debian 13.5 (Trixie)',
  )
})

test('formatServerOsDisplay formats Raspberry Pi OS from variant', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '12.11',
      codename: 'bookworm',
    }),
    'Raspberry Pi OS 12.11 (Bookworm)',
  )
})

test('formatServerOsDisplay formats raspbian ID as Raspberry Pi OS', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'raspbian',
      version: '11',
      codename: 'bullseye',
    }),
    'Raspberry Pi OS 11 (Bullseye)',
  )
})

test('formatServerOsDisplay falls back when fields are sparse', () => {
  assertEquals(
    formatServerOsDisplay({ family: 'linux', id: 'ubuntu', version: '24.04' }),
    'Ubuntu 24.04',
  )
  assertEquals(
    formatServerOsDisplay({ family: 'linux', id: 'debian' }),
    'Debian',
  )
  assertEquals(
    formatServerOsDisplay({
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    }),
    'Debian',
  )
  assertEquals(formatServerOsDisplay(null), null)
  assertEquals(formatServerOsDisplay(undefined), null)
})

test('resolveServerOsLogoKey picks debian vs raspberry-pi-os', () => {
  assertEquals(
    resolveServerOsLogoKey({ family: 'linux', id: 'debian' }),
    'debian',
  )
  assertEquals(
    resolveServerOsLogoKey({
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
    }),
    'raspberry-pi-os',
  )
  assertEquals(
    resolveServerOsLogoKey({ family: 'linux', id: 'raspbian' }),
    'raspberry-pi-os',
  )
  assertEquals(resolveServerOsLogoKey({ family: 'linux', id: 'ubuntu' }), null)
})

test('parseServerOsMetadata accepts daemon hello os blocks', () => {
  assertEquals(
    parseServerOsMetadata({
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '13.5',
      codename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      architecture: 'aarch64',
    }),
    {
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '13.5',
      codename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      architecture: 'aarch64',
    },
  )
  assertEquals(parseServerOsMetadata({ family: 'solaris' }), undefined)
  assertEquals(parseServerOsMetadata('nope'), undefined)
})

test('parseServerHostResources accepts capacity totals', () => {
  assertEquals(
    parseServerHostResources({
      cpu: { coreCount: 4, threadCount: 8, socketCount: 1 },
      memory: { totalBytes: 16_384_000_000 },
      swap: { totalBytes: 0 },
    }),
    {
      cpu: { coreCount: 4, threadCount: 8, socketCount: 1 },
      memory: { totalBytes: 16_384_000_000 },
      swap: { totalBytes: 0 },
    },
  )
  assertEquals(parseServerHostResources({ cpu: { coreCount: 0 } }), undefined)
  assertEquals(parseServerHostResources({ cpu: { threadCount: 0 } }), undefined)
  assertEquals(
    parseServerHostResources({ memory: { totalBytes: -1 } }),
    undefined,
  )
  assertEquals(parseServerHostResources(null), undefined)
})

test('serverHostResourcesEquals compares field-wise', () => {
  const a = {
    cpu: { coreCount: 4, threadCount: 8 },
    memory: { totalBytes: 100 },
    swap: { totalBytes: 0 },
  }
  assertEquals(serverHostResourcesEquals(a, { ...a, cpu: { ...a.cpu } }), true)
  assertEquals(
    serverHostResourcesEquals(a, {
      ...a,
      cpu: { ...a.cpu, coreCount: 8 },
    }),
    false,
  )
  assertEquals(
    serverHostResourcesEquals(a, {
      ...a,
      cpu: { ...a.cpu, threadCount: 4 },
    }),
    false,
  )
  assertEquals(serverHostResourcesEquals(a, null), false)
})

test('serverOsMetadataEquals compares field-wise including variant', () => {
  const a = {
    family: 'linux' as const,
    id: 'debian',
    version: '13.5',
    variant: 'raspberry-pi-os' as const,
  }
  assertEquals(serverOsMetadataEquals(a, { ...a }), true)
  assertEquals(serverOsMetadataEquals(a, { ...a, variant: undefined }), false)
  assertEquals(serverOsMetadataEquals(a, null), false)
})

test('parseServerTimeSync accepts daemon time-sync blocks', () => {
  assertEquals(
    parseServerTimeSync({
      timezone: 'America/Chicago',
      ntpEnabled: true,
      ntpSynced: false,
      ntpServers: ['time.cloudflare.com', '  '],
      fallbackNtpServers: ['203.0.113.10'],
      capturedAt: '2020-01-01T00:00:00.000Z',
    }),
    {
      timezone: 'America/Chicago',
      ntpEnabled: true,
      ntpSynced: false,
      ntpServers: ['time.cloudflare.com'],
      fallbackNtpServers: ['203.0.113.10'],
      capturedAt: '2020-01-01T00:00:00.000Z',
    },
  )
  assertEquals(parseServerTimeSync({ timezone: '  ' }), undefined)
  assertEquals(parseServerTimeSync('nope'), undefined)
})

test('serverTimeSyncEquals ignores capturedAt', () => {
  const a = {
    timezone: 'UTC',
    ntpEnabled: true,
    ntpServers: ['time.cloudflare.com'],
    capturedAt: '2020-01-01T00:00:00.000Z',
  }
  assertEquals(
    serverTimeSyncEquals(a, {
      ...a,
      capturedAt: '2020-01-02T00:00:00.000Z',
    }),
    true,
  )
  assertEquals(
    serverTimeSyncEquals(a, { ...a, timezone: 'Europe/London' }),
    false,
  )
})

test('parseServerOptions and resolveEffectiveServerTimezone', () => {
  assertEquals(parseServerOptions({ timezone: 'UTC', cellGeneration: 2 }), {
    timezone: 'UTC',
    cellGeneration: 2,
  })
  assertEquals(parseServerOptions(null), null)
  assertEquals(parseServerOptions({}), {})

  assertEquals(
    resolveEffectiveServerTimezone(
      { timezone: 'America/Chicago' },
      { defaultServerTimezone: 'UTC', enforceServerTimezone: false },
    ),
    { timezone: 'America/Chicago', source: 'server' },
  )
  assertEquals(
    resolveEffectiveServerTimezone(
      { timezone: 'America/Chicago' },
      { defaultServerTimezone: 'UTC', enforceServerTimezone: true },
    ),
    { timezone: 'UTC', source: 'organization' },
  )
  assertEquals(
    resolveEffectiveServerTimezone({}, { defaultServerTimezone: 'UTC' }),
    { timezone: null, source: null },
  )
  assertEquals(resolveEffectiveServerTimezone({}, {}), {
    timezone: null,
    source: null,
  })
})

test('resolveEffectiveServerTimezone datacenter precedence matrix', () => {
  const server = { timezone: 'America/Chicago' }
  const org = { defaultServerTimezone: 'UTC', enforceServerTimezone: false }
  const orgEnforce = { defaultServerTimezone: 'UTC', enforceServerTimezone: true }
  const dc = { defaultServerTimezone: 'Europe/Berlin', enforceServerTimezone: false }
  const dcEnforce = { defaultServerTimezone: 'Europe/Berlin', enforceServerTimezone: true }

  assertEquals(resolveEffectiveServerTimezone(server, org, dcEnforce), {
    timezone: 'Europe/Berlin',
    source: 'datacenter',
  })
  assertEquals(resolveEffectiveServerTimezone(server, orgEnforce, dcEnforce), {
    timezone: 'Europe/Berlin',
    source: 'datacenter',
  })
  assertEquals(resolveEffectiveServerTimezone(server, orgEnforce, dc), {
    timezone: 'UTC',
    source: 'organization',
  })
  assertEquals(resolveEffectiveServerTimezone(server, org, dc), {
    timezone: 'America/Chicago',
    source: 'server',
  })
  assertEquals(resolveEffectiveServerTimezone({}, org, dc), {
    timezone: null,
    source: null,
  })
  assertEquals(resolveEffectiveServerTimezone({}, {}, dc), {
    timezone: null,
    source: null,
  })
})

test('resolveServerResponseTimezone falls back to daemon-reported zone', () => {
  assertEquals(
    resolveServerResponseTimezone(
      { timezone: null, source: null },
      'Europe/Berlin',
    ),
    { timezone: 'Europe/Berlin', source: null },
  )
  assertEquals(
    resolveServerResponseTimezone(
      { timezone: null, source: null },
      '  ',
    ),
    { timezone: null, source: null },
  )
  assertEquals(
    resolveServerResponseTimezone(
      { timezone: 'America/Chicago', source: 'server' },
      'Europe/Berlin',
    ),
    { timezone: 'America/Chicago', source: 'server' },
  )
  assertEquals(
    resolveServerResponseTimezone(
      resolveEffectiveServerTimezone(
        {},
        { defaultServerTimezone: 'UTC', enforceServerTimezone: false },
        { defaultServerTimezone: 'Europe/Berlin', enforceServerTimezone: false },
      ),
      'Europe/Berlin',
    ),
    { timezone: 'Europe/Berlin', source: null },
  )
})

test('parseServerIps and serverIpsEquals', () => {
  const ips = parseServerIps([
    { address: '10.0.0.1', version: 4, scope: 'private' },
    { address: '', version: 4, scope: 'private' },
    { address: '203.0.113.10', version: 4, scope: 'public' },
    { address: '2001:db8::1', version: 6, scope: 'public' },
  ])
  assertEquals(ips, [
    { address: '10.0.0.1', version: 4, scope: 'private' },
    { address: '2001:db8::1', version: 6, scope: 'public' },
    { address: '203.0.113.10', version: 4, scope: 'public' },
  ])
  assertEquals(parseServerIps([]), [])
  assertEquals(parseServerIps(undefined), undefined)
  assertEquals(
    parseServerIps([
      { address: '10.0.0.5', version: 4, scope: 'private', cidr: '10.0.0.5/24' },
    ]),
    [
      {
        address: '10.0.0.5',
        version: 4,
        scope: 'private',
        cidr: '10.0.0.0/24',
      },
    ],
  )
  assertEquals(serverIpsEquals(ips, ips), true)
  assertEquals(
    serverIpsEquals(ips, [
      ...(ips ?? []),
      { address: '203.0.113.11', version: 4, scope: 'public' },
    ]),
    false,
  )
})

test('ipsFromDaemonPresence prefers ips[] and maps legacy addresses', () => {
  const current = ipsFromDaemonPresence({
    ips: [{ address: '10.0.0.8', version: 4, scope: 'private' }],
    addresses: {
      privateIpv4: ['10.0.0.9'],
      privateIpv6: [],
      publicIpv4: [],
      publicIpv6: [],
    },
  })
  assertEquals(current, [
    { address: '10.0.0.8', version: 4, scope: 'private' },
  ])
  assertEquals(
    ipsFromDaemonPresence({
      addresses: {
        privateIpv4: ['10.0.0.5'],
        privateIpv6: [],
        publicIpv4: ['203.0.113.10'],
        publicIpv6: [],
      },
    }),
    [
      { address: '10.0.0.5', version: 4, scope: 'private' },
      { address: '203.0.113.10', version: 4, scope: 'public' },
    ],
  )
  assertEquals(ipsFromDaemonPresence({}), undefined)
})

test('resourcesFromDaemonPresence prefers resources and maps inventory', () => {
  assertEquals(
    resourcesFromDaemonPresence({
      resources: { cpu: { coreCount: 8, threadCount: 16 } },
      inventory: { cpuCores: 2, cpuThreads: 4 },
    }),
    { cpu: { coreCount: 8, threadCount: 16 } },
  )
  assertEquals(
    resourcesFromDaemonPresence({
      inventory: {
        cpuCores: 4,
        cpuThreads: 8,
        memoryTotalBytes: 1024,
        swapTotalBytes: 0,
      },
    }),
    {
      cpu: { coreCount: 4, threadCount: 8 },
      memory: { totalBytes: 1024 },
      swap: { totalBytes: 0 },
    },
  )
})
