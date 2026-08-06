import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  encodeCommandEnvelope,
  parseCommandEnvelope,
} from './envelope.ts'
import {
  isSystemComponentKey,
  isValidNtpServer,
  parseCommandPayload,
  parseCommandResult,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentLifecycleResult,
  parseHostnameSetPayload,
  parseHostnameSetResult,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedLifecyclePayload,
  parseManagedLifecycleResult,
  parseManagedRestorePayload,
  parseManagedRestoreResult,
  parseNtpSetPayload,
  parseNtpSetResult,
  parsePingPayload,
  parsePingResult,
  parseRebootPayload,
  parseRebootResult,
  parseSystemReconcilePayload,
  parseSystemReconcileResult,
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
  'environment.lifecycle',
  'environment.stop',
  'managed.apply',
  'managed.lifecycle',
  'managed.destroy',
  'managed.backup',
  'managed.restore',
  'system.reconcile',
] as const

test('COMMAND_TYPES matches daemon contracts canonical order', () => {
  assertEquals([...COMMAND_TYPES], [...DAEMON_COMMAND_TYPES])
})

test('parseEnvironmentLifecyclePayload round-trips and rejects invalid shapes', () => {
  assertEquals(
    parseEnvironmentLifecyclePayload({
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      action: 'restart',
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      action: 'restart',
    },
  )
  assertThrows(
    () =>
      parseEnvironmentLifecyclePayload({
        environmentId: 'env-1',
        projectId: 'proj-1',
        projectName: 'tp-demo',
        action: 'down',
      }),
    Error,
    'Invalid environment.lifecycle payload',
  )
  assertThrows(
    () => parseEnvironmentLifecyclePayload(null),
    Error,
    'Invalid environment.lifecycle payload',
  )
  assertThrows(
    () =>
      parseEnvironmentLifecyclePayload({
        environmentId: '',
        projectId: 'proj-1',
        projectName: 'tp-demo',
        action: 'start',
      }),
    Error,
    'Invalid environment.lifecycle payload',
  )
})

test('parseEnvironmentLifecycleResult is lenient and passes containers through', () => {
  assertEquals(parseEnvironmentLifecycleResult(null), { projectName: '' })
  assertEquals(
    parseEnvironmentLifecycleResult({
      projectName: 'tp-demo',
      summary: 'ok',
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'cid-1',
          containerName: 'proj-web-1',
          status: 'running',
        },
      ],
    }),
    {
      projectName: 'tp-demo',
      summary: 'ok',
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'cid-1',
          containerName: 'proj-web-1',
          status: 'running',
        },
      ],
    },
  )
  assertEquals(
    parseEnvironmentLifecycleResult({ projectName: 'tp-demo' }).containers,
    undefined,
  )
})

test('parseSystemReconcilePayload round-trips and rejects invalid shapes', () => {
  const serviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const environmentId = '11111111-2222-3333-4444-555555555555'
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      action: 'restart',
      components: [
        {
          component: 'hosting-ingress',
          serviceId,
          composeServiceName: 'traefik',
          containerName: `${serviceId}-ingress`,
          role: 'ingress',
          desired: 'present',
        },
      ],
    }),
    {
      environmentId,
      action: 'restart',
      components: [
        {
          component: 'hosting-ingress',
          serviceId,
          composeServiceName: 'traefik',
          containerName: `${serviceId}-ingress`,
          role: 'ingress',
          desired: 'present',
        },
      ],
    },
  )
  // Default action when omitted.
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      components: [
        {
          component: 'hosting-ingress',
          serviceId,
          composeServiceName: 'traefik',
          containerName: `${serviceId}-ingress`,
          role: 'ingress',
          desired: 'absent',
        },
      ],
    }).action,
    'reconcile',
  )
  // Explicit stop (hosting-disable) is allowed.
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      action: 'stop',
      components: [
        {
          component: 'hosting-ingress',
          serviceId,
          composeServiceName: 'traefik',
          containerName: `${serviceId}-ingress`,
          role: 'ingress',
          desired: 'absent',
        },
      ],
    }).action,
    'stop',
  )

  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'not-allowlisted',
            serviceId,
            composeServiceName: 'traefik',
            containerName: `${serviceId}-ingress`,
            role: 'ingress',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'hosting-ingress',
            serviceId: 'not-a-uuid',
            composeServiceName: 'traefik',
            containerName: 'not-a-uuid-ingress',
            role: 'ingress',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'hosting-ingress',
            serviceId,
            composeServiceName: 'traefik',
            containerName: 'wrong-name',
            role: 'ingress',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: Array.from({ length: 9 }, (_, i) => ({
          component: 'hosting-ingress',
          serviceId: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${i}`,
          composeServiceName: 'traefik',
          containerName: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${i}-ingress`,
          role: 'ingress',
          desired: 'present',
        })),
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'hosting-ingress',
            serviceId,
            composeServiceName: 'traefik',
            containerName: `${serviceId}-ingress`,
            role: 'ingress',
            desired: 'maybe',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
})

test('parseSystemReconcilePayload accepts the widened database/queue/analytics component keys with app role and bare serviceId containerName', () => {
  const serviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const environmentId = '11111111-2222-3333-4444-555555555555'
  for (const component of ['database', 'queue', 'analytics'] as const) {
    assertEquals(
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component,
            serviceId,
            composeServiceName: component,
            containerName: serviceId,
            role: 'app',
            desired: 'present',
          },
        ],
      }).components[0],
      {
        component,
        serviceId,
        composeServiceName: component,
        containerName: serviceId,
        role: 'app',
        desired: 'present',
      },
    )
  }
})

test('parseSystemReconcilePayload rejects role/containerName mismatches across the app/ingress split', () => {
  const serviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const environmentId = '11111111-2222-3333-4444-555555555555'
  // hosting-ingress must be role: 'ingress' — declaring 'app' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'hosting-ingress',
            serviceId,
            composeServiceName: 'traefik',
            containerName: `${serviceId}-ingress`,
            role: 'app',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  // database must be role: 'app' — declaring 'ingress' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'database',
            serviceId,
            composeServiceName: 'database',
            containerName: `${serviceId}-ingress`,
            role: 'ingress',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  // database with role: 'app' but an ingress-shaped containerName is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'database',
            serviceId,
            composeServiceName: 'database',
            containerName: `${serviceId}-ingress`,
            role: 'app',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
})

test('parseSystemReconcileResult is lenient and passes containers through', () => {
  assertEquals(parseSystemReconcileResult(null), {})
  assertEquals(
    parseSystemReconcileResult({
      summary: 'ok',
      containers: [
        {
          composeServiceName: 'traefik',
          containerId: 'cid-1',
          containerName: 'svc-ingress',
          status: 'running',
          role: 'ingress',
        },
      ],
    }),
    {
      summary: 'ok',
      containers: [
        {
          composeServiceName: 'traefik',
          containerId: 'cid-1',
          containerName: 'svc-ingress',
          status: 'running',
          role: 'ingress',
        },
      ],
    },
  )
  assertEquals(parseSystemReconcileResult({ summary: 'ok' }).containers, undefined)
  assertEquals(parseSystemReconcileResult({ containers: [] }).containers, [])
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

const VALID_MANAGED_APPLY = {
  managedId: '00000000-0000-4000-8000-000000000001',
  environmentId: '00000000-0000-4000-8000-000000000002',
  engine: 'postgres',
  projectName: 'tp-managed-pg',
  containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-1',
  image: 'docker.io/library/postgres:18-alpine',
  containerPort: 5432,
  composeYaml: 'services:\n  postgres:\n    image: postgres:18-alpine\n',
  configFiles: [
    { path: 'postgresql.conf', contents: "listen_addresses = '*'\n", mode: '0640' },
  ],
  volumes: [{ name: 'pgdata', target: '/var/lib/postgresql' }],
  exposure: { enabled: false, protocol: 'tcp' },
  credentials: [
    {
      principalId: '00000000-0000-4000-8000-000000000003',
      username: 'postgres',
      role: 'root',
      databases: ['postgres'],
      password: 'denc.server.key.1.payload',
    },
  ],
} as const

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
  assertEquals(
    parseCommandPayload('environment.lifecycle' as CommandType, {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      action: 'stop',
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      action: 'stop',
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
  assertEquals(
    parseCommandResult('environment.lifecycle' as CommandType, {
      projectName: 'tp-demo',
      summary: 'Lifecycle stop',
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'abc',
          containerName: 'proj-web-1',
          status: 'exited',
        },
      ],
    }),
    {
      projectName: 'tp-demo',
      summary: 'Lifecycle stop',
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'abc',
          containerName: 'proj-web-1',
          status: 'exited',
        },
      ],
    },
  )
  assertEquals(
    parseCommandPayload('managed.apply' as CommandType, VALID_MANAGED_APPLY),
    parseManagedApplyPayload(VALID_MANAGED_APPLY),
  )
  assertEquals(
    parseCommandPayload('managed.lifecycle' as CommandType, {
      managedId: 'm1',
      action: 'restart',
    }),
    { managedId: 'm1', action: 'restart' },
  )
  assertEquals(
    parseCommandPayload('managed.destroy' as CommandType, {
      managedId: 'm1',
      removeVolumes: true,
    }),
    { managedId: 'm1', removeVolumes: true },
  )
  assertEquals(
    parseCommandResult('managed.apply' as CommandType, {
      host: '203.0.113.10',
      port: 5432,
      summary: 'ready',
    }),
    { host: '203.0.113.10', port: 5432, summary: 'ready' },
  )
  assertEquals(
    parseCommandResult('managed.lifecycle' as CommandType, {
      status: 'ready',
    }),
    { status: 'ready' },
  )
  assertEquals(
    parseCommandResult('managed.destroy' as CommandType, {
      status: 'stopped',
      containers: [],
      summary: 'removed',
    }),
    { status: 'stopped', containers: [], summary: 'removed' },
  )
  assertEquals(
    parseCommandPayload('managed.backup' as CommandType, {
      managedId: 'm1',
      engine: 'postgres',
      action: 'create',
      backupId: 'bk_1',
      artifactExtension: 'dump',
      scope: 'database',
      database: 'appdb',
    }),
    {
      managedId: 'm1',
      engine: 'postgres',
      action: 'create',
      backupId: 'bk_1',
      artifactExtension: 'dump',
      scope: 'database',
      database: 'appdb',
    },
  )
  assertEquals(
    parseCommandResult('managed.backup' as CommandType, {
      backupId: 'bk_1',
      path: '/var/lib/turbopanel/managed/m1/backups/bk_1.dump',
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
      completedAt: '2020-01-01T00:00:00.000Z',
      database: 'appdb',
      pruned: ['bk_0'],
    }),
    {
      backupId: 'bk_1',
      path: '/var/lib/turbopanel/managed/m1/backups/bk_1.dump',
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
      completedAt: '2020-01-01T00:00:00.000Z',
      database: 'appdb',
      pruned: ['bk_0'],
    },
  )
  assertEquals(
    parseCommandPayload('managed.restore' as CommandType, {
      managedId: 'm1',
      engine: 'postgres',
      backupId: 'bk_1',
      artifactExtension: 'dump',
      database: 'appdb',
      checksum: 'a'.repeat(64),
    }),
    {
      managedId: 'm1',
      engine: 'postgres',
      backupId: 'bk_1',
      artifactExtension: 'dump',
      database: 'appdb',
      checksum: 'a'.repeat(64),
    },
  )
  assertEquals(
    parseCommandResult('managed.restore' as CommandType, {
      backupId: 'bk_1',
      status: 'ready',
      restoredAt: '2020-01-01T00:00:00.000Z',
      database: 'appdb',
    }),
    {
      backupId: 'bk_1',
      status: 'ready',
      restoredAt: '2020-01-01T00:00:00.000Z',
      database: 'appdb',
    },
  )
})

test('parseManagedApplyPayload accepts a valid fixture', () => {
  const payload = parseManagedApplyPayload(VALID_MANAGED_APPLY)
  assertEquals(payload.engine, 'postgres')
  assertEquals(payload.projectName, 'tp-managed-pg')
  assertEquals(payload.credentials.length, 1)
  assertEquals(payload.configFiles[0]?.mode, '0640')
})

test('parseManagedApplyPayload rejects unsafe or incomplete input', () => {
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, projectName: 'Bad Name!' }),
    Error,
    'Invalid managed.apply payload',
  )
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, containerName: '-bad' }),
    Error,
    'Invalid managed.apply payload',
  )
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, containerPort: 70000 }),
    Error,
    'Invalid managed.apply payload',
  )
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, credentials: [] }),
    Error,
    'Invalid managed.apply credentials',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: '../etc/passwd', contents: 'x', mode: '0640' },
        ],
      }),
    Error,
    'Invalid managed.apply configFiles entry',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        credentials: [
          {
            ...VALID_MANAGED_APPLY.credentials[0],
            password: 'plaintext-not-allowed',
          },
        ],
      }),
    Error,
    'Invalid managed.apply credentials entry',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: { privileged: true },
      }),
    Error,
    'Invalid managed.apply dockerOptions',
  )
})

test('parseManagedApplyPayload rejects nested dockerOptions and enabled exposure without port', () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: { restart: 'invalid-policy' },
      }),
    Error,
    'Invalid managed.apply dockerOptions',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: {
          ulimits: { nofile: { soft: 2048, hard: 1024 } },
        },
      }),
    Error,
    'Invalid managed.apply dockerOptions',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: {
          labels: { 'traefik.enable': 'true' },
        },
      }),
    Error,
    'Invalid managed.apply dockerOptions',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        exposure: { enabled: true, protocol: 'tcp' },
      }),
    Error,
    'Invalid managed.apply exposure',
  )
  const VALID_INGRESS = {
    serviceId: '00000000-0000-4000-8000-000000000099',
    composeServiceName: 'postgres-ingress',
    containerName: '00000000-0000-4000-8000-000000000099-ingress',
  }
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      exposure: { enabled: true, protocol: 'tcp', publishedPort: 15432 },
      ingress: VALID_INGRESS,
    }).exposure.publishedPort,
    15432,
  )
})

test('parseManagedApplyPayload requires ingress iff exposure.enabled', () => {
  const VALID_INGRESS = {
    serviceId: '00000000-0000-4000-8000-000000000099',
    composeServiceName: 'postgres-ingress',
    containerName: '00000000-0000-4000-8000-000000000099-ingress',
  }
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        exposure: { enabled: true, protocol: 'tcp', publishedPort: 15432 },
      }),
    Error,
    'Invalid managed.apply ingress',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        exposure: { enabled: false, protocol: 'tcp' },
        ingress: VALID_INGRESS,
      }),
    Error,
    'Invalid managed.apply ingress',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        exposure: { enabled: true, protocol: 'tcp', publishedPort: 15432 },
        ingress: { ...VALID_INGRESS, containerName: '-bad' },
      }),
    Error,
    'Invalid managed.apply ingress',
  )
  const accepted = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    exposure: { enabled: true, protocol: 'tcp', publishedPort: 15432 },
    ingress: VALID_INGRESS,
  })
  assertEquals(accepted.ingress, VALID_INGRESS)
})

test('parseManagedApplyPayload rejects dockerOptions.extraEnv overriding postgres-reserved env keys', () => {
  for (
    const [key, value] of [
      ['POSTGRES_PASSWORD', 'hunter2'],
      ['POSTGRES_USER', 'root'],
      ['POSTGRES_DB', 'postgres'],
      ['POSTGRES_INITDB_ARGS', '--data-checksums'],
      ['POSTGRES_HOST_AUTH_METHOD', 'trust'],
      ['PGDATA', '/var/lib/postgresql/evil'],
    ] as const
  ) {
    assertThrows(
      () =>
        parseManagedApplyPayload({
          ...VALID_MANAGED_APPLY,
          dockerOptions: { extraEnv: { [key]: value } },
        }),
      Error,
      'Invalid managed.apply dockerOptions',
    )
  }
})

test('parseManagedApplyPayload accepts dockerOptions.extraEnv with harmless keys', () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    dockerOptions: { extraEnv: { TZ: 'UTC' } },
  })
  assertEquals(payload.dockerOptions?.extraEnv, { TZ: 'UTC' })
})

test('parseManagedApplyPayload admits allowlisted config paths and rejects unexpected relative names', () => {
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      configFiles: [
        { path: 'postgresql.conf', contents: 'x\n', mode: '0640' },
        { path: 'tls/server.crt', contents: 'cert\n', mode: '0640' },
        { path: 'tls/server.key', contents: 'key\n', mode: '0600' },
      ],
    }).configFiles.map((file) => file.path),
    ['postgresql.conf', 'tls/server.crt', 'tls/server.key'],
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: 'unexpected.conf', contents: 'x\n', mode: '0640' },
        ],
      }),
    Error,
    'Invalid managed.apply configFiles entry',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: 'nested/postgresql.conf', contents: 'x\n', mode: '0640' },
        ],
      }),
    Error,
    'Invalid managed.apply configFiles entry',
  )
})

test('parseManagedApplyPayload admits tlsMaterial and rejects hostile cert paths', () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    tlsMaterial: {
      selfSigned: true,
      commonName: 'managed-postgres',
      certPath: 'tls/server.crt',
      keyPath: 'tls/server.key',
    },
  })
  assertEquals(payload.tlsMaterial?.commonName, 'managed-postgres')
  assertEquals(payload.tlsMaterial?.certPath, 'tls/server.crt')
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        tlsMaterial: {
          selfSigned: true,
          commonName: 'managed-postgres',
          certPath: '../etc/passwd',
          keyPath: 'tls/server.key',
        },
      }),
    Error,
    'Invalid managed.apply tlsMaterial',
  )
})

test('parseManagedLifecycleResult and parseManagedDestroyResult project observed status', () => {
  assertEquals(parseManagedLifecycleResult({ status: 'ready' }), {
    status: 'ready',
  })
  assertEquals(parseManagedLifecycleResult({ status: 'stopped' }), {
    status: 'stopped',
  })
  assertEquals(
    parseManagedLifecycleResult({ status: 'failed', summary: 'compose down' }),
    { status: 'failed', summary: 'compose down' },
  )
  assertEquals(
    parseManagedDestroyResult({
      status: 'stopped',
      containers: [],
      summary: 'removed',
    }),
    { status: 'stopped', containers: [], summary: 'removed' },
  )
  assertEquals(parseManagedDestroyResult({ status: 'failed' }), {
    status: 'failed',
    containers: [],
  })
  assertEquals(parseManagedDestroyResult(null), {
    status: '',
    containers: [],
  })
})

test('parseManagedLifecyclePayload accepts valid actions and rejects others', () => {
  assertEquals(
    parseManagedLifecyclePayload({ managedId: 'm1', action: 'start' }),
    { managedId: 'm1', action: 'start' },
  )
  assertThrows(
    () => parseManagedLifecyclePayload({ managedId: 'm1', action: 'pause' }),
    Error,
    'Invalid managed.lifecycle payload',
  )
})

test('parseManagedDestroyPayload requires removeVolumes', () => {
  assertEquals(
    parseManagedDestroyPayload({ managedId: 'm1', removeVolumes: false }),
    { managedId: 'm1', removeVolumes: false },
  )
  assertThrows(
    () => parseManagedDestroyPayload({ managedId: 'm1' }),
    Error,
    'Invalid managed.destroy payload',
  )
})

test('parseManagedDestroyPayload accepts and preserves the deleteAfterDestroy marker', () => {
  assertEquals(
    parseManagedDestroyPayload({
      managedId: 'm1',
      removeVolumes: true,
      deleteAfterDestroy: true,
    }),
    { managedId: 'm1', removeVolumes: true, deleteAfterDestroy: true },
  )
  // Omitted marker stays omitted — a future "destroy runtime only" action
  // must be able to send this payload shape and never trigger row cleanup.
  assertEquals(
    parseManagedDestroyPayload({ managedId: 'm1', removeVolumes: true }),
    { managedId: 'm1', removeVolumes: true },
  )
  assertThrows(
    () =>
      parseManagedDestroyPayload({
        managedId: 'm1',
        removeVolumes: true,
        deleteAfterDestroy: 'yes',
      }),
    Error,
    'Invalid managed.destroy payload',
  )
})

const VALID_MANAGED_BACKUP_CREATE = {
  managedId: 'm1',
  engine: 'postgres',
  action: 'create',
  backupId: 'bk_1700000000000',
  artifactExtension: 'dump',
  scope: 'database',
  database: 'appdb',
} as const

test('parseManagedBackupPayload accepts a valid create fixture', () => {
  assertEquals(
    parseManagedBackupPayload(VALID_MANAGED_BACKUP_CREATE),
    VALID_MANAGED_BACKUP_CREATE,
  )
})

test('parseManagedBackupPayload accepts delete action and optional retentionKeep', () => {
  assertEquals(
    parseManagedBackupPayload({
      ...VALID_MANAGED_BACKUP_CREATE,
      action: 'delete',
      retentionKeep: 7,
    }),
    { ...VALID_MANAGED_BACKUP_CREATE, action: 'delete', retentionKeep: 7 },
  )
})

test('parseManagedBackupPayload rejects hostile or malformed input', () => {
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        backupId: '../etc/passwd',
      }),
    Error,
    'Invalid managed.backup payload',
  )
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        backupId: 'bk_1; rm -rf /',
      }),
    Error,
    'Invalid managed.backup payload',
  )
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        artifactExtension: 'exe',
      }),
    Error,
    'Invalid managed.backup payload',
  )
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        action: 'destroy',
      }),
    Error,
    'Invalid managed.backup payload',
  )
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        database: 'bad; name',
      }),
    Error,
    'Invalid managed.backup payload database',
  )
  assertThrows(
    () => {
      const { database: _database, ...rest } = VALID_MANAGED_BACKUP_CREATE
      return parseManagedBackupPayload(rest)
    },
    Error,
    'scope database requires database',
  )
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        retentionKeep: 0,
      }),
    Error,
    'Invalid managed.backup payload retentionKeep',
  )
  assertThrows(
    () => parseManagedBackupPayload(null),
    Error,
    'Invalid managed.backup payload',
  )
})

test('parseManagedBackupResult is lenient and never carries dump contents', () => {
  assertEquals(parseManagedBackupResult(null), { backupId: '' })
  assertEquals(
    parseManagedBackupResult({
      backupId: 'bk_1',
      path: '/var/lib/turbopanel/managed/m1/backups/bk_1.dump',
      sizeBytes: 2048,
      checksum: 'b'.repeat(64),
      completedAt: '2020-01-01T00:00:00.000Z',
      pruned: ['bk_0', 'bk_-1'],
      dumpContents: 'should never be parsed through',
    }),
    {
      backupId: 'bk_1',
      path: '/var/lib/turbopanel/managed/m1/backups/bk_1.dump',
      sizeBytes: 2048,
      checksum: 'b'.repeat(64),
      completedAt: '2020-01-01T00:00:00.000Z',
      pruned: ['bk_0', 'bk_-1'],
    },
  )
  // Malformed checksum is dropped rather than accepted.
  assertEquals(
    parseManagedBackupResult({ backupId: 'bk_1', checksum: 'not-hex' }),
    { backupId: 'bk_1' },
  )
})

const VALID_MANAGED_RESTORE = {
  managedId: 'm1',
  engine: 'postgres',
  backupId: 'bk_1700000000000',
  artifactExtension: 'dump',
  database: 'appdb',
  checksum: 'c'.repeat(64),
} as const

test('parseManagedRestorePayload accepts a valid fixture', () => {
  assertEquals(parseManagedRestorePayload(VALID_MANAGED_RESTORE), VALID_MANAGED_RESTORE)
})

test('parseManagedRestorePayload rejects hostile or malformed input', () => {
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, backupId: '../../etc' }),
    Error,
    'Invalid managed.restore payload',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, checksum: 'not-hex' }),
    Error,
    'Invalid managed.restore payload',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, artifactExtension: 'sh' }),
    Error,
    'Invalid managed.restore payload',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, database: 'bad; name' }),
    Error,
    'Invalid managed.restore payload database',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, sizeBytes: -1 }),
    Error,
    'Invalid managed.restore payload sizeBytes',
  )
  assertThrows(
    () => parseManagedRestorePayload(null),
    Error,
    'Invalid managed.restore payload',
  )
})

test('parseManagedRestoreResult is lenient and never carries dump contents', () => {
  assertEquals(parseManagedRestoreResult(null), { backupId: '' })
  assertEquals(
    parseManagedRestoreResult({
      backupId: 'bk_1',
      status: 'ready',
      restoredAt: '2020-01-01T00:00:00.000Z',
      database: 'appdb',
      summary: 'restored',
      dumpContents: 'should never be parsed through',
    }),
    {
      backupId: 'bk_1',
      status: 'ready',
      restoredAt: '2020-01-01T00:00:00.000Z',
      database: 'appdb',
      summary: 'restored',
    },
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
          principal: {
            principalId: '00000000-0000-4000-8000-000000000099',
            username: 'site_user',
            uid: 10001,
            gid: 10001,
          },
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
          principal: {
            principalId: '00000000-0000-4000-8000-000000000099',
            username: 'site_user',
            uid: 10001,
            gid: 10001,
          },
        },
      ],
    },
  )
})

test('parseCommandPayload accepts principalMaterial with and without uid/gid', () => {
  assertEquals(
    parseCommandPayload('environment.deploy' as CommandType, {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services: {}\n',
      hostings: [],
      principalMaterial: [
        {
          principalId: '00000000-0000-4000-8000-000000000001',
          username: 'appuser',
          home: '/srv/users/appuser',
          shell: '/usr/sbin/nologin',
        },
        {
          principalId: '00000000-0000-4000-8000-000000000002',
          username: 'webuser',
          uid: 10001,
          gid: 10001,
          home: '/srv/users/webuser',
        },
      ],
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services: {}\n',
      hostings: [],
      principalMaterial: [
        {
          principalId: '00000000-0000-4000-8000-000000000001',
          username: 'appuser',
          home: '/srv/users/appuser',
          shell: '/usr/sbin/nologin',
        },
        {
          principalId: '00000000-0000-4000-8000-000000000002',
          username: 'webuser',
          uid: 10001,
          gid: 10001,
          home: '/srv/users/webuser',
        },
      ],
    },
  )
})

test('parseCommandPayload rejects negative or non-integer principal ids', () => {
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        environmentId: 'env-1',
        projectId: 'proj-1',
        organizationId: 'org-1',
        projectName: 'tp-demo',
        composeYaml: 'services: {}\n',
        hostings: [],
        principalMaterial: [
          {
            principalId: '00000000-0000-4000-8000-000000000001',
            username: 'appuser',
            uid: -1,
            gid: 10001,
          },
        ],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        environmentId: 'env-1',
        projectId: 'proj-1',
        organizationId: 'org-1',
        projectName: 'tp-demo',
        composeYaml: 'services: {}\n',
        hostings: [],
        traditionalWebSites: [
          {
            composeServiceName: 'web',
            engine: 'nginx',
            root: 'public',
            listenPort: 18080,
            principal: {
              principalId: '00000000-0000-4000-8000-000000000099',
              username: 'site_user',
              uid: 1.5,
              gid: 10001,
            },
          },
        ],
      }),
    Error,
    'Invalid traditionalWebSites.principal entry',
  )
})

test('parseCommandPayload rejects overlong, unsafe, or empty principal material fields', () => {
  const baseDeploy = {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    composeYaml: 'services: {}\n',
    hostings: [] as unknown[],
  }
  const overlongUsername = `u${'x'.repeat(32)}` // 33 chars
  assertEquals(overlongUsername.length, 33)

  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        ...baseDeploy,
        principalMaterial: [
          {
            principalId: '00000000-0000-4000-8000-000000000001',
            username: overlongUsername,
          },
        ],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        ...baseDeploy,
        principalMaterial: [
          {
            principalId: '00000000-0000-4000-8000-000000000001',
            username: 'bad user',
          },
        ],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        ...baseDeploy,
        principalMaterial: [
          {
            principalId: '',
            username: 'appuser',
          },
        ],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
  for (const home of ['relative/path', '/tmp/../etc/passwd', '/home/with space', '/bad\0path']) {
    assertThrows(
      () =>
        parseCommandPayload('environment.deploy' as CommandType, {
          ...baseDeploy,
          principalMaterial: [
            {
              principalId: '00000000-0000-4000-8000-000000000001',
              username: 'appuser',
              home,
            },
          ],
        }),
      Error,
      'Invalid environment.deploy payload',
    )
  }

  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        ...baseDeploy,
        traditionalWebSites: [
          {
            composeServiceName: 'web',
            engine: 'nginx',
            root: 'public',
            listenPort: 18080,
            principal: {
              principalId: '00000000-0000-4000-8000-000000000099',
              username: overlongUsername,
            },
          },
        ],
      }),
    Error,
    'Invalid traditionalWebSites.principal entry',
  )
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        ...baseDeploy,
        traditionalWebSites: [
          {
            composeServiceName: 'web',
            engine: 'nginx',
            root: 'public',
            listenPort: 18080,
            principal: {
              principalId: '00000000-0000-4000-8000-000000000099',
              username: 'bad;user',
            },
          },
        ],
      }),
    Error,
    'Invalid traditionalWebSites.principal entry',
  )
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        ...baseDeploy,
        traditionalWebSites: [
          {
            composeServiceName: 'web',
            engine: 'nginx',
            root: 'public',
            listenPort: 18080,
            principal: {
              principalId: '',
              username: 'site_user',
            },
          },
        ],
      }),
    Error,
    'Invalid traditionalWebSites.principal entry',
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

test('parseCommandEnvelope omits empty correlationId', () => {
  const envelope = parseCommandEnvelope({
    commandId: 'c',
    serverId: 's',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: 't',
    correlationId: '',
  })
  assertEquals(envelope.correlationId, undefined)
})

test('isValidNtpServer accepts hostnames and literals', () => {
  assertEquals(isValidNtpServer('time.example.com'), true)
  assertEquals(isValidNtpServer('203.0.113.10'), true)
  assertEquals(isValidNtpServer(''), false)
  assertEquals(isValidNtpServer('bad;host'), false)
})

test('isSystemComponentKey accepts only system component keys', () => {
  assertEquals(isSystemComponentKey('hosting-ingress'), true)
  assertEquals(isSystemComponentKey('database'), true)
  assertEquals(isSystemComponentKey('not-a-component'), false)
})

test('parseManagedApplyResult projects host, port, and containers', () => {
  assertEquals(
    parseManagedApplyResult({
      host: '127.0.0.1',
      port: 5432,
      containers: [
        {
          composeServiceName: 'postgres',
          containerId: 'abc',
          containerName: 'proj-postgres-1',
          status: 'running',
        },
      ],
    }),
    {
      host: '127.0.0.1',
      port: 5432,
      containers: [
        {
          composeServiceName: 'postgres',
          containerId: 'abc',
          containerName: 'proj-postgres-1',
          status: 'running',
        },
      ],
    },
  )
  assertEquals(parseManagedApplyResult({}), { host: '', port: 0 })
})
