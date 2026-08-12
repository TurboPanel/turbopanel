import { assertEquals } from 'jsr:@std/assert'
import {
  parseServerAddresses,
  serverAddressesEquals,
} from '../../server-addresses.ts'
import {
  formatServerOsDisplay,
  parseServerOptions,
  parseServerOsMetadata,
  parseServerHostInventory,
  parseServerTimeSync,
  resolveEffectiveServerTimezone,
  resolveServerResponseTimezone,
  resolveServerOsLogoKey,
  serverOsMetadataEquals,
  serverHostInventoryEquals,
  serverTimeSyncEquals,
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
      versionCodename: 'trixie',
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
      versionCodename: 'bookworm',
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
      versionCodename: 'bullseye',
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
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      arch: 'aarch64',
    }),
    {
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '13.5',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      arch: 'aarch64',
    },
  )
  assertEquals(parseServerOsMetadata({ family: 'solaris' }), undefined)
  assertEquals(parseServerOsMetadata('nope'), undefined)
})

test('parseServerHostInventory accepts capacity totals', () => {
  assertEquals(
    parseServerHostInventory({
      cpuCores: 4,
      cpuThreads: 8,
      memoryTotalBytes: 16_384_000_000,
      swapTotalBytes: 0,
    }),
    {
      cpuCores: 4,
      cpuThreads: 8,
      memoryTotalBytes: 16_384_000_000,
      swapTotalBytes: 0,
    },
  )
  assertEquals(parseServerHostInventory({ cpuCores: 0 }), undefined)
  assertEquals(parseServerHostInventory({ cpuThreads: 0 }), undefined)
  assertEquals(parseServerHostInventory({ memoryTotalBytes: -1 }), undefined)
  assertEquals(parseServerHostInventory(null), undefined)
})

test('serverHostInventoryEquals compares field-wise', () => {
  const a = {
    cpuCores: 4,
    cpuThreads: 8,
    memoryTotalBytes: 100,
    swapTotalBytes: 0,
  }
  assertEquals(serverHostInventoryEquals(a, { ...a }), true)
  assertEquals(serverHostInventoryEquals(a, { ...a, cpuCores: 8 }), false)
  assertEquals(serverHostInventoryEquals(a, { ...a, cpuThreads: 4 }), false)
  assertEquals(serverHostInventoryEquals(a, null), false)
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

test('parseServerAddresses and serverAddressesEquals', () => {
  const addresses = parseServerAddresses({
    privateIpv4: ['10.0.0.1', ''],
    privateIpv6: [],
    publicIpv4: ['203.0.113.10'],
    publicIpv6: ['2001:db8::1'],
  })
  assertEquals(addresses, {
    privateIpv4: ['10.0.0.1'],
    privateIpv6: [],
    publicIpv4: ['203.0.113.10'],
    publicIpv6: ['2001:db8::1'],
  })
  assertEquals(
    parseServerAddresses({
      privateIpv4: [],
      privateIpv6: [],
      publicIpv4: [],
      publicIpv6: [],
    }),
    {
      privateIpv4: [],
      privateIpv6: [],
      publicIpv4: [],
      publicIpv6: [],
    },
  )
  assertEquals(parseServerAddresses(undefined), undefined)
  assertEquals(serverAddressesEquals(addresses, addresses), true)
  assertEquals(
    serverAddressesEquals(addresses, {
      ...addresses!,
      publicIpv4: ['203.0.113.11'],
    }),
    false,
  )
})
