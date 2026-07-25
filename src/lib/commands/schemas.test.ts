import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  encodeCommandEnvelope,
  parseCommandEnvelope,
} from './envelope.ts'
import {
  parseCommandPayload,
  parseCommandResult,
  parseHostnameSetPayload,
  parseHostnameSetResult,
  parseNtpSetPayload,
  parseNtpSetResult,
  parsePingPayload,
  parsePingResult,
  parseRebootPayload,
  parseRebootResult,
  parseTimezoneSetPayload,
  parseTimezoneSetResult,
  parseWireguardApplyPayload,
  parseWireguardApplyResult,
} from './schemas.ts'
import { COMMAND_TYPES, type CommandType } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parsePingPayload accepts empty object', () => {
  assertEquals(parsePingPayload({}), {})
})

test('parsePingPayload rejects non-object values', () => {
  for (const value of [null, [], 'x']) {
    assertThrows(() => parsePingPayload(value), Error, 'Invalid ping payload')
  }
})

test('parseRebootPayload accepts empty object', () => {
  assertEquals(parseRebootPayload({}), {})
})

test('parseRebootPayload rejects non-object values', () => {
  for (const value of [null, [], 'x']) {
    assertThrows(() => parseRebootPayload(value), Error, 'Invalid reboot payload')
  }
})

test('parseHostnameSetPayload accepts valid hostname', () => {
  assertEquals(parseHostnameSetPayload({ hostname: 'web-01' }), { hostname: 'web-01' })
})

test('parseHostnameSetPayload rejects invalid hostnames', () => {
  for (const hostname of [undefined, '', 'a b', 'a;b']) {
    assertThrows(
      () => parseHostnameSetPayload({ hostname }),
      Error,
      'Invalid hostname set payload',
    )
  }
  assertThrows(
    () => parseHostnameSetPayload(null),
    Error,
    'Invalid hostname set payload',
  )
})

test('parsePingResult keeps only valid string hop fields', () => {
  assertEquals(parsePingResult(null), {})
  assertEquals(
    parsePingResult({
      daemonReceivedAt: '2020-01-01T00:00:00.000Z',
      daemonRespondedAt: '2020-01-01T00:00:01.000Z',
      daemonHostname: 'web-01',
      daemonBuild: {
        commit: 'abc',
        buildId: 'build-1',
        builtAt: '2020-01-01T00:00:00.000Z',
        channel: 'trunk',
        extra: 1,
      },
      bogus: 123,
    }),
    {
      daemonReceivedAt: '2020-01-01T00:00:00.000Z',
      daemonRespondedAt: '2020-01-01T00:00:01.000Z',
      daemonHostname: 'web-01',
      daemonBuild: {
        commit: 'abc',
        buildId: 'build-1',
        builtAt: '2020-01-01T00:00:00.000Z',
        channel: 'trunk',
      },
    },
  )
  assertEquals(parsePingResult({ daemonBuild: {} }), {})
})

test('parseRebootResult returns default for non-records and round-trips valid results', () => {
  assertEquals(parseRebootResult(null), { scheduled: false })
  assertEquals(parseRebootResult({ scheduled: true, summary: 'ok' }), {
    scheduled: true,
    summary: 'ok',
  })
  assertEquals(parseRebootResult({ scheduled: true }), { scheduled: true })
})

test('parseHostnameSetResult round-trips valid results', () => {
  assertEquals(
    parseHostnameSetResult({ observedHostname: 'web-01', summary: 'ok' }),
    { observedHostname: 'web-01', summary: 'ok' },
  )
  assertEquals(
    parseHostnameSetResult({ observedHostname: 'web-01' }),
    { observedHostname: 'web-01' },
  )
})

test('parseHostnameSetResult rejects missing or empty observedHostname', () => {
  for (const value of [{}, { observedHostname: '' }, { observedHostname: 1 }]) {
    assertThrows(
      () => parseHostnameSetResult(value),
      Error,
      'Invalid hostname set result',
    )
  }
})

/** Keep byte-identical order with daemon `src/instance/commands/contracts.ts`. */
const DAEMON_COMMAND_TYPES = [
  'daemon.ping',
  'server.hostname.set',
  'server.ntp.set',
  'server.reboot',
  'server.timezone.set',
  'server.wireguard.apply',
  'environment.deploy',
  'environment.stop',
] as const

test('COMMAND_TYPES matches daemon contracts canonical order', () => {
  assertEquals([...COMMAND_TYPES], [...DAEMON_COMMAND_TYPES])
})

test('parseTimezoneSetPayload accepts valid IANA shapes', () => {
  assertEquals(parseTimezoneSetPayload({ timezone: 'America/Chicago' }), {
    timezone: 'America/Chicago',
  })
  assertEquals(parseTimezoneSetPayload({ timezone: 'UTC' }), { timezone: 'UTC' })
})

test('parseTimezoneSetPayload rejects invalid timezones', () => {
  for (const timezone of [undefined, '', 'a b', 'a;b', 'Etc/GMT+0 ']) {
    assertThrows(
      () => parseTimezoneSetPayload({ timezone }),
      Error,
      'Invalid timezone set payload',
    )
  }
})

test('parseTimezoneSetResult round-trips', () => {
  assertEquals(
    parseTimezoneSetResult({ timezone: 'UTC', summary: 'ok' }),
    { timezone: 'UTC', summary: 'ok' },
  )
})

test('parseNtpSetPayload accepts enabled and server lists', () => {
  assertEquals(
    parseNtpSetPayload({
      enabled: true,
      servers: ['time.cloudflare.com', '203.0.113.10'],
      fallbackServers: ['2001:db8::1'],
    }),
    {
      enabled: true,
      servers: ['time.cloudflare.com', '203.0.113.10'],
      fallbackServers: ['2001:db8::1'],
    },
  )
  assertEquals(parseNtpSetPayload({ enabled: false }), { enabled: false })
})

test('parseNtpSetPayload rejects invalid NTP servers and empty payloads', () => {
  assertThrows(
    () => parseNtpSetPayload({ servers: ['999.999.999.999'] }),
    Error,
    'Invalid NTP server',
  )
  assertThrows(
    () => parseNtpSetPayload({}),
    Error,
    'ntp payload must include enabled',
  )
  assertThrows(
    () => parseNtpSetPayload({ servers: [] }),
    Error,
    'must not be empty',
  )
})

test('parseNtpSetResult keeps server lists', () => {
  assertEquals(
    parseNtpSetResult({
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ['time.cloudflare.com'],
      fallbackNtpServers: ['203.0.113.10'],
    }),
    {
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ['time.cloudflare.com'],
      fallbackNtpServers: ['203.0.113.10'],
    },
  )
})

test('parseNtpSetResult rejects missing or malformed ntpServers', () => {
  assertThrows(
    () => parseNtpSetResult({ ntpEnabled: true }),
    TypeError,
    'ntpServers must be an array',
  )
  assertThrows(
    () => parseNtpSetResult({ ntpServers: 'time.cloudflare.com' }),
    TypeError,
    'ntpServers must be an array',
  )
  assertThrows(
    () => parseNtpSetResult({ ntpServers: [123] }),
    Error,
    'Invalid NTP server in ntpServers',
  )
  assertThrows(
    () =>
      parseNtpSetResult({
        ntpServers: ['time.cloudflare.com'],
        fallbackNtpServers: '203.0.113.10',
      }),
    TypeError,
    'fallbackNtpServers must be an array',
  )
})

test('parseCommandPayload and parseCommandResult dispatch by type', () => {
  assertEquals(parseCommandPayload('daemon.ping' as CommandType, {}), {})
  assertEquals(
    parseCommandPayload('server.hostname.set' as CommandType, { hostname: 'web-01' }),
    { hostname: 'web-01' },
  )
  assertEquals(
    parseCommandPayload('server.timezone.set' as CommandType, {
      timezone: 'UTC',
    }),
    { timezone: 'UTC' },
  )
  assertEquals(
    parseCommandPayload('server.ntp.set' as CommandType, { enabled: true }),
    { enabled: true },
  )
  assertEquals(parseCommandPayload('server.reboot' as CommandType, {}), {})
  assertEquals(
    parseCommandPayload('environment.deploy' as CommandType, {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services: {}\n',
      hostings: [],
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services: {}\n',
      hostings: [],
    },
  )
  assertEquals(
    parseCommandPayload('environment.stop' as CommandType, {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
    },
  )
  assertEquals(parseCommandResult('daemon.ping' as CommandType, { daemonHostname: 'x' }), {
    daemonHostname: 'x',
  })
  assertEquals(
    parseCommandResult('server.hostname.set' as CommandType, { observedHostname: 'web-01' }),
    { observedHostname: 'web-01' },
  )
  assertEquals(
    parseCommandResult('server.timezone.set' as CommandType, { timezone: 'UTC' }),
    { timezone: 'UTC' },
  )
  assertEquals(
    parseCommandResult('server.ntp.set' as CommandType, { ntpServers: [] }),
    { ntpServers: [] },
  )
  assertEquals(
    parseCommandResult('server.reboot' as CommandType, { scheduled: true, summary: 'ok' }),
    { scheduled: true, summary: 'ok' },
  )
  assertEquals(
    parseCommandResult('environment.deploy' as CommandType, {
      projectName: 'tp-demo',
      summary: 'up',
    }),
    { projectName: 'tp-demo', summary: 'up' },
  )
  assertEquals(
    parseCommandResult('environment.deploy' as CommandType, {
      projectName: 'tp-demo',
      summary: 'scaled to zero',
      containers: [],
    }),
    { projectName: 'tp-demo', summary: 'scaled to zero', containers: [] },
  )
  assertEquals(
    parseCommandResult('environment.deploy' as CommandType, {
      projectName: 'tp-demo',
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'abc',
          containerName: 'proj-web-1',
          status: 'running',
          serviceId: '00000000-0000-4000-8000-000000000099',
        },
      ],
    }),
    {
      projectName: 'tp-demo',
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'abc',
          containerName: 'proj-web-1',
          status: 'running',
          serviceId: '00000000-0000-4000-8000-000000000099',
        },
      ],
    },
  )
  assertEquals(
    parseCommandResult('environment.stop' as CommandType, {
      projectName: 'tp-demo',
      summary: 'stopped',
      containers: [],
    }),
    { projectName: 'tp-demo', summary: 'stopped', containers: [] },
  )
})

test('parseCommandPayload accepts traditionalWebSites and dockerExternalNetworks', () => {
  assertEquals(
    parseCommandPayload('environment.deploy' as CommandType, {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services:\n  api:\n    image: node:22\n',
      hostings: [],
      dockerExternalNetworks: ['zeta-net', 'alpha-net', 'alpha-net'],
      traditionalWebSites: [
        {
          composeServiceName: 'web',
          engine: 'apache',
          root: 'public',
          listenPort: 18080,
          webEnv: { APP_ENV: 'prod' },
          php: { version: '8.4', memoryLimit: '256M', maxExecutionTime: 30 },
        },
      ],
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services:\n  api:\n    image: node:22\n',
      hostings: [],
      dockerExternalNetworks: ['alpha-net', 'zeta-net'],
      traditionalWebSites: [
        {
          composeServiceName: 'web',
          engine: 'apache',
          root: 'public',
          listenPort: 18080,
          webEnv: { APP_ENV: 'prod' },
          php: { version: '8.4', memoryLimit: '256M', maxExecutionTime: 30 },
        },
      ],
    },
  )
})

test('parseCommandPayload rejects invalid dockerExternalNetworks names', () => {
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        environmentId: 'env-1',
        projectId: 'proj-1',
        organizationId: 'org-1',
        projectName: 'tp-demo',
        composeYaml: 'services: {}\n',
        hostings: [],
        dockerExternalNetworks: ['-bad'],
      }),
    Error,
    'Invalid dockerExternalNetworks entry',
  )
})

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('parseWireguardApplyPayload accepts valid mesh material', () => {
  const payload = parseWireguardApplyPayload({
    vpnId: '550e8400-e29b-41d4-a716-446655440000',
    peerId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    interfaceName: 'tpwg550e8400',
    address: '203.0.113.10/32',
    listenPort: 51820,
    peers: [
      {
        peerId: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
        publicKey: WG_PUBKEY,
        allowedIps: ['203.0.113.11/32'],
        endpoint: '203.0.113.1:51820',
      },
    ],
  })
  assertEquals(payload.interfaceName, 'tpwg550e8400')
})

test('parseWireguardApplyPayload rejects invalid wireguard material', () => {
  const base = {
    vpnId: '550e8400-e29b-41d4-a716-446655440000',
    peerId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    interfaceName: 'tpwg550e8400',
    address: '203.0.113.10/32',
    peers: [{ peerId: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', publicKey: WG_PUBKEY, allowedIps: ['203.0.113.11/32'] }],
  }
  assertThrows(
    () => parseWireguardApplyPayload({ ...base, peers: [{ ...base.peers[0], publicKey: 'bad' }] }),
    Error,
    'Invalid wireguard peer publicKey',
  )
  assertThrows(
    () => parseWireguardApplyPayload({ ...base, interfaceName: 'INVALID!' }),
    Error,
    'Invalid WireGuard interface name',
  )
  assertThrows(
    () => parseWireguardApplyPayload({
      ...base,
      peers: [{ ...base.peers[0], allowedIps: ['203.0.113.11'] }],
    }),
    Error,
    'Invalid wireguard peer allowedIps',
  )
  assertThrows(
    () => parseWireguardApplyPayload({ ...base, listenPort: 70000 }),
    Error,
    'Invalid wireguard apply listenPort',
  )
})

test('parseWireguardApplyResult round-trips applied flag', () => {
  assertEquals(
    parseWireguardApplyResult({
      interfaceName: 'tpwg550e8400',
      publicKey: WG_PUBKEY,
      applied: true,
      listenPort: 51820,
    }).applied,
    true,
  )
})

test('encodeCommandEnvelope round-trips through parseCommandEnvelope', () => {
  const envelope = {
    commandId: 'cmd-1',
    serverId: 'srv-1',
    type: 'daemon.ping' as CommandType,
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
    correlationId: 'corr-1',
  }
  assertEquals(parseCommandEnvelope(encodeCommandEnvelope(envelope)), envelope)
  assertEquals(parseCommandEnvelope(envelope), envelope)
})

test('parseCommandEnvelope rejects invalid envelopes', () => {
  assertThrows(() => parseCommandEnvelope('not-json'), Error, 'Invalid command envelope')
  assertThrows(() => parseCommandEnvelope(null), Error, 'Invalid command envelope')
  assertThrows(
    () => parseCommandEnvelope({ commandId: '', serverId: 's', type: 'daemon.ping', attempt: 1, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope({ commandId: 'c', serverId: 's', type: 'unknown', attempt: 1, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope({ commandId: 'c', serverId: 's', type: 'daemon.ping', attempt: 0, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope({ commandId: 'c', serverId: 's', type: 'daemon.ping', attempt: 1.5, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
})
