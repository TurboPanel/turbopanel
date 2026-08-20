import { assertEquals } from '@std/assert'
import {
  ipsFromDaemonPresence,
  parseServerIps,
  serverIpsEquals,
} from '../../server-addresses.ts'
import {
  formatServerOsDisplay,
  osColumnsFromMetadata,
  osMetadataFromColumns,
  parseNtpServersColumn,
  parseServerDockerMetadata,
  parseServerHostResources,
  parseServerOptions,
  parseServerOsMetadata,
  parseServerTimeSync,
  resolveEffectiveServerTimezone,
  resolveServerOsLogoKey,
  resolveServerResponseTimezone,
  resourcesFromDaemonPresence,
  serverDockerMetadataEquals,
  serverHostResourcesEquals,
  serverOsMetadataEquals,
  serverTimeSyncEquals,
  timeSyncColumnPatch,
  timeSyncFromColumns,
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
      cpus: [
        {
          vendorId: 'GenuineIntel',
          cores: { total: 4 },
          threads: { total: 8 },
        },
      ],
      memory: { totalBytes: 16_384_000_000 },
      swap: { totalBytes: 0 },
    }),
    {
      cpus: [
        {
          vendorId: 'GenuineIntel',
          cores: { total: 4 },
          threads: { total: 8 },
        },
      ],
      memory: { totalBytes: 16_384_000_000 },
      swap: { totalBytes: 0 },
    },
  )
  assertEquals(
    parseServerHostResources({ memory: { totalBytes: -1 } }),
    undefined,
  )
  assertEquals(parseServerHostResources(null), undefined)
})

test('parseServerHostResources accepts gpus', () => {
  assertEquals(
    parseServerHostResources({
      gpus: [
        {
          vendorId: '0x10de',
          name: 'NVIDIA GeForce RTX 5060 Ti',
          memoryBytes: 16 * 1024 * 1024 * 1024,
          driver: 'nvidia',
          pciId: '10de:2d04',
          pciSlot: '0000:01:00.0',
        },
      ],
    }),
    {
      gpus: [
        {
          vendorId: '0x10de',
          name: 'NVIDIA GeForce RTX 5060 Ti',
          memoryBytes: 16 * 1024 * 1024 * 1024,
          driver: 'nvidia',
          pciId: '10de:2d04',
          pciSlot: '0000:01:00.0',
        },
      ],
    },
  )
})

test('serverHostResourcesEquals compares field-wise', () => {
  const a = {
    cpus: [{ cores: { total: 4 }, threads: { total: 8 } }],
    memory: { totalBytes: 100 },
    swap: { totalBytes: 0 },
  }
  assertEquals(
    serverHostResourcesEquals(a, { ...a, cpus: [{ ...a.cpus[0] }] }),
    true,
  )
  assertEquals(
    serverHostResourcesEquals(a, {
      ...a,
      cpus: [{ cores: { total: 8 }, threads: { total: 8 } }],
    }),
    false,
  )
  assertEquals(
    serverHostResourcesEquals(a, {
      ...a,
      cpus: [{ cores: { total: 4 }, threads: { total: 4 } }],
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
    }),
    {
      timezone: 'America/Chicago',
      ntpEnabled: true,
      ntpSynced: false,
      ntpServers: ['time.cloudflare.com'],
      fallbackNtpServers: ['203.0.113.10'],
    },
  )
  assertEquals(parseServerTimeSync({ timezone: '  ' }), undefined)
  assertEquals(parseServerTimeSync('nope'), undefined)
})

test('serverTimeSyncEquals compares field-wise', () => {
  const a = {
    timezone: 'UTC',
    ntpEnabled: true,
    ntpServers: ['time.cloudflare.com'],
  }
  assertEquals(
    serverTimeSyncEquals(a, { ...a, ntpSynced: true }),
    false,
  )
  assertEquals(
    serverTimeSyncEquals(a, { ...a, timezone: 'Europe/London' }),
    false,
  )
})

test('parseServerDockerMetadata accepts daemon docker blocks', () => {
  assertEquals(
    parseServerDockerMetadata({
      version: '28.3.3',
      composeVersion: 'v2.39.1',
    }),
    { version: '28.3.3', composeVersion: '2.39.1' },
  )
  assertEquals(
    parseServerDockerMetadata({ version: '28.3.3' }),
    { version: '28.3.3' },
  )
  assertEquals(
    parseServerDockerMetadata({ composeVersion: '2.39.1-desktop.1' }),
    { composeVersion: '2.39.1-desktop.1' },
  )
  assertEquals(parseServerDockerMetadata({}), undefined)
  assertEquals(
    parseServerDockerMetadata({ version: 'not a version' }),
    undefined,
  )
  assertEquals(parseServerDockerMetadata('nope'), undefined)
})

test('serverDockerMetadataEquals compares field-wise', () => {
  const a = { version: '28.3.3', composeVersion: '2.39.1' }
  assertEquals(serverDockerMetadataEquals(a, { ...a }), true)
  assertEquals(
    serverDockerMetadataEquals(a, { version: '28.3.3' }),
    false,
  )
  assertEquals(serverDockerMetadataEquals(a, null), false)
  assertEquals(serverDockerMetadataEquals(undefined, undefined), true)
})

test('parseServerOptions and resolveEffectiveServerTimezone', () => {
  assertEquals(parseServerOptions({ timezone: 'UTC', cellGeneration: 2 }), {
    timezone: 'UTC',
    cellGeneration: 2,
  })
  assertEquals(
    parseServerOptions({
      sshPort: 2222,
      ntp: { enabled: true, servers: ['pool.ntp.org'] },
    }),
    {
      sshPort: 2222,
      ntp: { enabled: true, servers: ['pool.ntp.org'] },
    },
  )
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
  const orgEnforce = {
    defaultServerTimezone: 'UTC',
    enforceServerTimezone: true,
  }
  const dc = {
    defaultServerTimezone: 'Europe/Berlin',
    enforceServerTimezone: false,
  }
  const dcEnforce = {
    defaultServerTimezone: 'Europe/Berlin',
    enforceServerTimezone: true,
  }

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
        {
          defaultServerTimezone: 'Europe/Berlin',
          enforceServerTimezone: false,
        },
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
      {
        address: '10.0.0.5',
        version: 4,
        scope: 'private',
        cidr: '10.0.0.5/24',
      },
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

test('ipsFromDaemonPresence reads resources.ips only', () => {
  assertEquals(
    ipsFromDaemonPresence({
      resources: {
        ips: [{
          address: '10.0.0.4',
          version: 4,
          scope: 'private',
          interface: 'eth0',
        }],
      },
    }),
    [
      { address: '10.0.0.4', version: 4, scope: 'private', interface: 'eth0' },
    ],
  )
  assertEquals(ipsFromDaemonPresence({}), undefined)
  assertEquals(ipsFromDaemonPresence({ ips: [] }), undefined)
})

test('resourcesFromDaemonPresence reads resources only', () => {
  assertEquals(
    resourcesFromDaemonPresence({
      resources: {
        cpus: [{ cores: { total: 8 }, threads: { total: 16 } }],
      },
      inventory: { cpuCores: 2, cpuThreads: 4 },
    }),
    { cpus: [{ cores: { total: 8 }, threads: { total: 16 } }] },
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
    undefined,
  )
  assertEquals(
    resourcesFromDaemonPresence({
      resources: {
        cpus: [{ cores: { total: 2 } }],
        ips: [{ address: '10.0.0.8', version: 4, scope: 'private' }],
      },
      ips: [{ address: '203.0.113.10', version: 4, scope: 'public' }],
    }),
    {
      cpus: [{ cores: { total: 2 } }],
      ips: [{ address: '10.0.0.8', version: 4, scope: 'private' }],
    },
  )
})

test('os columns round-trip Raspberry Pi OS onto os_id', () => {
  const columns = osColumnsFromMetadata({
    family: 'linux',
    id: 'debian',
    variant: 'raspberry-pi-os',
    version: '12.11',
    architecture: 'aarch64',
  })
  assertEquals(columns.osId, 'raspberry-pi-os')
  assertEquals(osMetadataFromColumns(columns), {
    family: 'linux',
    id: 'raspberry-pi-os',
    variant: 'raspberry-pi-os',
    version: '12.11',
    architecture: 'aarch64',
  })
})

test('os columns map raspbian ID onto os_id raspberry-pi-os', () => {
  const columns = osColumnsFromMetadata({
    family: 'linux',
    id: 'raspbian',
    version: '11',
  })
  assertEquals(columns.osId, 'raspberry-pi-os')
  assertEquals(osMetadataFromColumns(columns)?.variant, 'raspberry-pi-os')
})

test('parseNtpServersColumn accepts object arrays and string arrays', () => {
  assertEquals(
    parseNtpServersColumn([
      { host: 'time.cloudflare.com' },
      { host: 'pool.ntp.org', fallback: true },
    ]),
    [
      { host: 'time.cloudflare.com' },
      { host: 'pool.ntp.org', fallback: true },
    ],
  )
  assertEquals(parseNtpServersColumn(['a.example', 'b.example']), [
    { host: 'a.example' },
    { host: 'b.example' },
  ])
})

test('timeSyncColumnPatch does not rewrite last-sync on every synced heartbeat', () => {
  const current = {
    timezone: 'UTC',
    isTimeSyncEnabled: true,
    ntpServers: [{ host: 'a.example' }],
    ntpLastSyncedAt: '2026-01-01T00:00:00.000Z',
  }
  assertEquals(
    timeSyncColumnPatch(
      { timezone: 'UTC', ntpEnabled: true, ntpSynced: true },
      current,
      '2026-08-17T12:00:00.000Z',
    ),
    null,
  )
  assertEquals(
    timeSyncColumnPatch(
      { ntpSynced: false },
      current,
      '2026-08-17T12:00:00.000Z',
    ),
    { ntpLastSyncedAt: null },
  )
  assertEquals(
    timeSyncFromColumns({
      timezone: 'UTC',
      isTimeSyncEnabled: true,
      ntpServers: [{ host: 'a.example' }, {
        host: 'b.example',
        fallback: true,
      }],
      ntpLastSyncedAt: '2026-01-01T00:00:00.000Z',
    }),
    {
      timezone: 'UTC',
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ['a.example'],
      fallbackNtpServers: ['b.example'],
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    },
  )
})

test('parseServerHostResources keeps ips including interface', () => {
  assertEquals(
    parseServerHostResources({
      cpus: [{ cores: { total: 2 } }],
      ips: [
        {
          address: '10.0.0.5',
          version: 4,
          scope: 'private',
          interface: 'enp1s0',
        },
      ],
    }),
    {
      cpus: [{ cores: { total: 2 } }],
      ips: [
        {
          address: '10.0.0.5',
          version: 4,
          scope: 'private',
          interface: 'enp1s0',
        },
      ],
    },
  )
})
