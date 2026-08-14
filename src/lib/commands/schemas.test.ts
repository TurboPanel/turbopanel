import { assertEquals, assertThrows } from 'jsr:@std/assert'
import { encodeCommandEnvelope, parseCommandEnvelope } from './envelope.ts'
import {
  isSystemComponentKey,
  isValidNtpServer,
  parseCommandPayload,
  parseCommandResult,
  parseDeployComposeFiles,
  parseEnvironmentDeployPayload,
  parseEnvironmentDeployResult,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentLifecycleResult,
  parseEnvironmentStopPayload,
  parseEnvironmentStopResult,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
  parseHostnameSetPayload,
  parseHostnameSetResult,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedIngressReconcilePayload,
  parseManagedIngressReconcileResult,
  parseManagedLifecyclePayload,
  parseManagedLifecycleResult,
  parseManagedPromotePayload,
  parseManagedPromoteResult,
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
    assertThrows(
      () => parseRebootPayload(value),
      Error,
      'Invalid reboot payload',
    )
  }
})

test('parseHostnameSetPayload accepts valid hostname', () => {
  assertEquals(parseHostnameSetPayload({ hostname: 'web-01' }), {
    hostname: 'web-01',
  })
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
  'server.fabric.reconcile',
  'environment.deploy',
  'environment.lifecycle',
  'environment.stop',
  'managed.apply',
  'managed.lifecycle',
  'managed.destroy',
  'managed.backup',
  'managed.restore',
  'managed.promote',
  'managed.ingress.reconcile',
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
          role: 'service',
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
          role: 'service',
        },
      ],
    },
  )
  assertEquals(
    parseEnvironmentLifecycleResult({ projectName: 'tp-demo' }).containers,
    undefined,
  )
})

test('parseEnvironmentDeployResult rejects omitted or invalid container roles', () => {
  const base = {
    composeServiceName: 'web',
    containerId: 'cid-1',
    containerName: 'proj-web-1',
    status: 'running',
  }
  // Removed legacy 'app', misspellings, and omitted role are contract drift —
  // drop the entry rather than accepting it as default 'service'.
  for (const role of ['app', 'workload'] as const) {
    assertEquals(
      parseEnvironmentDeployResult({
        projectName: 'tp-demo',
        containers: [{ ...base, role }],
      }).containers,
      [],
    )
  }
  assertEquals(
    parseEnvironmentDeployResult({
      projectName: 'tp-demo',
      containers: [base],
    }).containers,
    [],
  )
  // Allowlisted roles round-trip.
  for (const role of ['service', 'ingress', 'turbopanel'] as const) {
    assertEquals(
      parseEnvironmentDeployResult({
        projectName: 'tp-demo',
        containers: [{ ...base, role }],
      }).containers,
      [{ ...base, role }],
    )
  }
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
          containerName: `${serviceId}-in`,
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
          containerName: `${serviceId}-in`,
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
          containerName: `${serviceId}-in`,
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
          containerName: `${serviceId}-in`,
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
            containerName: `${serviceId}-in`,
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
          containerName: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${i}-in`,
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
            containerName: `${serviceId}-in`,
            role: 'ingress',
            desired: 'maybe',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
})

test('parseSystemReconcilePayload accepts the widened database/queue/analytics component keys with system role and bare serviceId containerName', () => {
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
            role: 'turbopanel',
            desired: 'present',
          },
        ],
      }).components[0],
      {
        component,
        serviceId,
        composeServiceName: component,
        containerName: serviceId,
        role: 'turbopanel',
        desired: 'present',
      },
    )
  }
})

test('parseSystemReconcilePayload accepts managed-ingress with system role and -sql containerName', () => {
  const serviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const environmentId = '11111111-2222-3333-4444-555555555555'
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      components: [
        {
          component: 'managed-ingress',
          serviceId,
          composeServiceName: 'proxysql',
          containerName: `${serviceId}-sql`,
          role: 'turbopanel',
          desired: 'present',
        },
      ],
    }).components[0],
    {
      component: 'managed-ingress',
      serviceId,
      composeServiceName: 'proxysql',
      containerName: `${serviceId}-sql`,
      role: 'turbopanel',
      desired: 'present',
    },
  )
})

test('parseSystemReconcilePayload rejects role/containerName mismatches across the system/ingress split', () => {
  const serviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const environmentId = '11111111-2222-3333-4444-555555555555'
  // hosting-ingress must be role: 'ingress' — declaring 'service' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'hosting-ingress',
            serviceId,
            composeServiceName: 'traefik',
            containerName: `${serviceId}-in`,
            role: 'service',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  // database must be role: 'turbopanel' — declaring 'ingress' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'database',
            serviceId,
            composeServiceName: 'database',
            containerName: `${serviceId}-in`,
            role: 'ingress',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  // database with role: 'turbopanel' but an ingress-shaped containerName is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'database',
            serviceId,
            composeServiceName: 'database',
            containerName: `${serviceId}-in`,
            role: 'turbopanel',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  // managed-ingress requires the -sql suffix — bare serviceId is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'managed-ingress',
            serviceId,
            composeServiceName: 'proxysql',
            containerName: serviceId,
            role: 'turbopanel',
            desired: 'present',
          },
        ],
      }),
    Error,
    'Invalid system.reconcile payload',
  )
  // managed-ingress must not use the hosting-ingress -in suffix.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: 'managed-ingress',
            serviceId,
            composeServiceName: 'proxysql',
            containerName: `${serviceId}-in`,
            role: 'turbopanel',
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
  assertEquals(
    parseSystemReconcileResult({ summary: 'ok' }).containers,
    undefined,
  )
  assertEquals(parseSystemReconcileResult({ containers: [] }).containers, [])
})

test('parseTimezoneSetPayload accepts valid IANA shapes', () => {
  assertEquals(parseTimezoneSetPayload({ timezone: 'America/Chicago' }), {
    timezone: 'America/Chicago',
  })
  assertEquals(parseTimezoneSetPayload({ timezone: 'UTC' }), {
    timezone: 'UTC',
  })
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
    {
      path: 'postgresql.conf',
      contents: "listen_addresses = '*'\n",
      mode: '0640',
    },
    {
      path: 'pg_hba.conf',
      contents: '# TurboPanel managed PostgreSQL — platform pg_hba\nlocal all all peer\n',
      mode: '0640',
    },
  ],
  volumes: [{ name: 'pgdata', target: '/var/lib/postgresql' }],
  exposure: { enabled: false, protocol: 'tcp' },
  memberId: '00000000-0000-4000-8000-0000000000aa',
  memberRole: 'primary',
  memberOrdinal: 1,
  readEligible: true,
  peers: [],
  credentials: [
    {
      principalId: '00000000-0000-4000-8000-000000000003',
      username: 'postgres',
      role: 'root',
      databases: ['postgres'],
      password: 'tpdaemon.v1.server.key.payload',
    },
  ],
} as const

test('parseCommandPayload and parseCommandResult dispatch by type', () => {
  assertEquals(parseCommandPayload('daemon.ping' as CommandType, {}), {})
  assertEquals(
    parseCommandPayload('server.hostname.set' as CommandType, {
      hostname: 'web-01',
    }),
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
  assertEquals(
    parseCommandResult('daemon.ping' as CommandType, { daemonHostname: 'x' }),
    {
      daemonHostname: 'x',
    },
  )
  assertEquals(
    parseCommandResult('server.hostname.set' as CommandType, {
      observedHostname: 'web-01',
    }),
    { observedHostname: 'web-01' },
  )
  assertEquals(
    parseCommandResult('server.timezone.set' as CommandType, {
      timezone: 'UTC',
    }),
    { timezone: 'UTC' },
  )
  assertEquals(
    parseCommandResult('server.ntp.set' as CommandType, { ntpServers: [] }),
    { ntpServers: [] },
  )
  assertEquals(
    parseCommandResult('server.reboot' as CommandType, {
      scheduled: true,
      summary: 'ok',
    }),
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
          role: 'service',
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
          role: 'service',
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
          role: 'service',
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
          role: 'service',
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
    parseCommandPayload('managed.lifecycle' as CommandType, {
      managedId: 'm1',
      action: 'stop',
      engine: 'mysql',
    }),
    { managedId: 'm1', action: 'stop', engine: 'mysql' },
  )
  assertEquals(
    parseCommandPayload('managed.promote' as CommandType, {
      managedId: '11111111-1111-1111-1111-111111111111',
      memberId: '22222222-2222-2222-2222-222222222222',
      engine: 'mariadb',
    }),
    {
      managedId: '11111111-1111-1111-1111-111111111111',
      memberId: '22222222-2222-2222-2222-222222222222',
      engine: 'mariadb',
    },
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
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        projectName: 'Bad Name!',
      }),
    Error,
    'Invalid managed.apply payload',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        containerName: '-bad',
      }),
    Error,
    'Invalid managed.apply payload',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        containerPort: 70000,
      }),
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

test('parseManagedApplyPayload enforces the engine image allowlist', () => {
  // The fixture's approved postgres:18-alpine image is unaffected.
  assertEquals(
    parseManagedApplyPayload(VALID_MANAGED_APPLY).image,
    VALID_MANAGED_APPLY.image,
  )

  // An old/EOL major version is syntactically a valid image ref but must still
  // be rejected — mirrors the settings-parser allowlist in `../managed/settings.ts`
  // so a replayed or forged command payload cannot bypass it.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        image: 'docker.io/library/postgres:17',
      }),
    Error,
    'Invalid managed.apply payload',
  )
  // Cross-engine image swap must also be rejected even though it is on the
  // MySQL allowlist — the payload's `engine` is postgres.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        image: 'docker.io/library/mysql:9.7',
      }),
    Error,
    'Invalid managed.apply payload',
  )
  // Approved MySQL / MariaDB images are accepted for their own engine.
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      engine: 'mysql',
      image: 'docker.io/library/mysql:9.7',
      credentials: [{
        ...VALID_MANAGED_APPLY.credentials[0],
        username: 'root',
      }],
    }).image,
    'docker.io/library/mysql:9.7',
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        engine: 'mariadb',
        image: 'docker.io/library/mariadb:11',
        credentials: [{
          ...VALID_MANAGED_APPLY.credentials[0],
          username: 'root',
        }],
      }),
    Error,
    'Invalid managed.apply payload',
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
  // publishedPort is ignored — ProxySQL owns protocol ports.
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      exposure: { enabled: true, protocol: 'tcp', publishedPort: 15432 },
    }).exposure,
    { enabled: true, protocol: 'tcp' },
  )
})

test('parseManagedApplyPayload accepts member fields and peers', () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    memberOrdinal: 2,
    memberRole: 'replica',
    containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-2',
    peers: [
      {
        memberId: '00000000-0000-4000-8000-0000000000bb',
        role: 'primary',
        readEligible: true,
        address: '203.0.113.10',
        transport: 'datacenter',
        port: 5432,
      },
    ],
  })
  assertEquals(payload.memberOrdinal, 2)
  assertEquals(payload.memberRole, 'replica')
  assertEquals(payload.peers.length, 1)
  assertEquals(payload.peers[0]?.address, '203.0.113.10')
})

test('parseManagedApplyPayload round-trips a fabric peer and rejects vpn', () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    peers: [
      {
        memberId: '00000000-0000-4000-8000-0000000000bb',
        role: 'replica',
        readEligible: true,
        address: '203.0.113.11',
        transport: 'fabric',
        port: 45001,
      },
    ],
  })
  assertEquals(payload.peers[0]?.transport, 'fabric')
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        peers: [
          {
            memberId: '00000000-0000-4000-8000-0000000000bb',
            role: 'replica',
            readEligible: true,
            address: '203.0.113.11',
            transport: 'vpn',
            port: 45001,
          },
        ],
      }),
    Error,
  )
})

test('parseManagedPromotePayload and result accept valid shapes', () => {
  assertEquals(
    parseManagedPromotePayload({
      managedId: '00000000-0000-4000-8000-000000000001',
      memberId: '00000000-0000-4000-8000-0000000000aa',
      demoteMemberId: '00000000-0000-4000-8000-0000000000bb',
    }),
    {
      managedId: '00000000-0000-4000-8000-000000000001',
      memberId: '00000000-0000-4000-8000-0000000000aa',
      demoteMemberId: '00000000-0000-4000-8000-0000000000bb',
    },
  )
  assertEquals(
    parseManagedPromoteResult({
      status: 'ready',
      role: 'primary',
      summary: 'ok',
      promotedMemberId: '00000000-0000-4000-8000-0000000000aa',
      demoted: true,
      demotedMemberId: '00000000-0000-4000-8000-0000000000bb',
    }),
    {
      status: 'ready',
      role: 'primary',
      summary: 'ok',
      promotedMemberId: '00000000-0000-4000-8000-0000000000aa',
      demoted: true,
      demotedMemberId: '00000000-0000-4000-8000-0000000000bb',
    },
  )
})

test('managed.promote is in COMMAND_TYPES', () => {
  assertEquals(COMMAND_TYPES.includes('managed.promote'), true)
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
        { path: 'pg_hba.conf', contents: 'local all all peer\n', mode: '0640' },
        { path: 'tls/server.crt', contents: 'cert\n', mode: '0640' },
        { path: 'tls/server.key', contents: 'key\n', mode: '0600' },
      ],
    }).configFiles.map((file) => file.path),
    ['postgresql.conf', 'pg_hba.conf', 'tls/server.crt', 'tls/server.key'],
  )
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      configFiles: [
        { path: 'my.cnf', contents: '[mysqld]\n', mode: '0640' },
        {
          path: 'initdb/00-turbopanel.sql',
          contents: 'SELECT 1;\n',
          mode: '0640',
        },
      ],
    }).configFiles.map((file) => file.path),
    ['my.cnf', 'initdb/00-turbopanel.sql'],
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

test('parseManagedApplyPayload admits orgTlsMaterial and rejects incomplete material', () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    orgTlsMaterial: {
      certificatePem: '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n',
      privateKeyEnvelope: 'tpdaemon.v1.server.key.ciphertext',
      caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n',
    },
  })
  assertEquals(
    payload.orgTlsMaterial?.caCertPem.includes('BEGIN CERTIFICATE'),
    true,
  )
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        orgTlsMaterial: {
          certificatePem: 'not-a-pem',
          privateKeyEnvelope: 'tpdaemon.v1.x',
          caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n',
        },
      }),
    Error,
    'Invalid managed.apply orgTlsMaterial',
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
  assertEquals(
    parseManagedRestorePayload(VALID_MANAGED_RESTORE),
    VALID_MANAGED_RESTORE,
  )
})

test('parseManagedRestorePayload rejects hostile or malformed input', () => {
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        backupId: '../../etc',
      }),
    Error,
    'Invalid managed.restore payload',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        checksum: 'not-hex',
      }),
    Error,
    'Invalid managed.restore payload',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        artifactExtension: 'sh',
      }),
    Error,
    'Invalid managed.restore payload',
  )
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        database: 'bad; name',
      }),
    Error,
    'Invalid managed.restore payload database',
  )
  assertThrows(
    () => parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, sizeBytes: -1 }),
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

test('parseCommandPayload accepts noCache on environment.deploy', () => {
  assertEquals(
    parseCommandPayload('environment.deploy' as CommandType, {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services:\n  api:\n    image: node:22\n',
      hostings: [],
      noCache: true,
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      projectName: 'tp-demo',
      composeYaml: 'services:\n  api:\n    image: node:22\n',
      hostings: [],
      noCache: true,
    },
  )
})

test('parseCommandPayload rejects non-boolean noCache on environment.deploy', () => {
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        environmentId: 'env-1',
        projectId: 'proj-1',
        organizationId: 'org-1',
        projectName: 'tp-demo',
        composeYaml: 'services: {}\n',
        hostings: [],
        noCache: 'yes',
      }),
    Error,
    'Invalid environment.deploy payload',
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
  for (
    const home of [
      'relative/path',
      '/tmp/../etc/passwd',
      '/home/with space',
      '/bad\0path',
    ]
  ) {
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

test('parseCommandPayload accepts fabricNetworks with subnet mtu and gateway', () => {
  assertEquals(
    parseEnvironmentDeployPayload({
      ...BASE_ENVIRONMENT_DEPLOY,
      fabricNetworks: [
        {
          name: 'tpn_net1',
          subnet: '203.0.113.0/24',
          mtu: 1420,
          gateway: '203.0.113.1',
        },
      ],
    }).fabricNetworks,
    [
      {
        name: 'tpn_net1',
        subnet: '203.0.113.0/24',
        mtu: 1420,
        gateway: '203.0.113.1',
      },
    ],
  )
})

test('parseCommandPayload rejects invalid fabricNetworks name', () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{ name: '-bad', subnet: '203.0.113.0/24' }],
      }),
    Error,
    'Invalid fabricNetworks name',
  )
})

test('parseCommandPayload rejects invalid fabricNetworks CIDR', () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{ name: 'tpn_net1', subnet: '203.0.113.0/99' }],
      }),
    Error,
    'Invalid fabricNetworks subnet',
  )
})

test('parseCommandPayload rejects fabricNetworks MTU out of range', () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{
          name: 'tpn_net1',
          subnet: '203.0.113.0/24',
          mtu: 1279,
        }],
      }),
    Error,
    'Invalid fabricNetworks mtu',
  )
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{
          name: 'tpn_net1',
          subnet: '203.0.113.0/24',
          mtu: 9001,
        }],
      }),
    Error,
    'Invalid fabricNetworks mtu',
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

test('parseCommandPayload accepts and dedupes managedNetworkServices', () => {
  const parsed = parseCommandPayload('environment.deploy' as CommandType, {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    composeYaml: 'services:\n  app:\n    image: node:22\n',
    hostings: [],
    managedNetworkServices: ['app', 'app'],
  }) as { managedNetworkServices?: string[] }
  assertEquals(parsed.managedNetworkServices, ['app'])
})

test('parseCommandPayload rejects invalid managedNetworkServices entries', () => {
  assertThrows(
    () =>
      parseCommandPayload('environment.deploy' as CommandType, {
        environmentId: 'env-1',
        projectId: 'proj-1',
        organizationId: 'org-1',
        projectName: 'tp-demo',
        composeYaml: 'services: {}\n',
        hostings: [],
        managedNetworkServices: [123],
      }),
    Error,
    'Invalid managedNetworkServices entry',
  )
})

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const DAEMON_PSK = 'tpdaemon.v1.server.key.payload'

test('parseFabricReconcilePayload skips extra fields when disabled', () => {
  assertEquals(
    parseFabricReconcilePayload({ enabled: false, address: 'not-a-cidr' }),
    { enabled: false },
  )
})

test('parseFabricReconcilePayload accepts enabled mesh material', () => {
  const payload = parseFabricReconcilePayload({
    enabled: true,
    fabricId: '550e8400-e29b-41d4-a716-446655440000',
    address: '10.250.0.11/32',
    prefix: '10.192.0.0/16',
    peers: [
      {
        publicKey: WG_PUBKEY,
        allowedIPs: ['10.250.0.12/32', '10.193.0.0/16'],
        endpoint: '203.0.113.1:51820',
        keepalive: 25,
        presharedKeyEnvelope: DAEMON_PSK,
      },
    ],
    mtu: 1420,
    networks: [
      {
        name: 'tpn_550e8400-e29b-41d4-a716-446655440000',
        subnet: '10.192.11.0/24',
        mtu: 1420,
        gateway: '10.192.11.1',
      },
    ],
  })
  assertEquals(payload.enabled, true)
  if (!payload.enabled) {
    throw new TypeError('expected enabled fabric payload')
  }
  assertEquals(payload.mtu, 1420)
  assertEquals(payload.peers[0]?.keepalive, 25)
  assertEquals(payload.peers[0]?.presharedKeyEnvelope, DAEMON_PSK)
  assertEquals(payload.networks?.[0]?.gateway, '10.192.11.1')
  assertEquals(payload.address, '10.250.0.11/32')
  assertEquals(
    parseCommandPayload('server.fabric.reconcile', { enabled: false }),
    { enabled: false },
  )
  assertEquals(
    parseCommandResult('server.fabric.reconcile', {
      summary: 'TurboFabric disabled',
      skipped: true,
    }),
    { summary: 'TurboFabric disabled', skipped: true },
  )
  assertEquals(
    parseCommandResult('server.fabric.reconcile', {
      summary: 'TurboFabric torn down',
    }),
    { summary: 'TurboFabric torn down' },
  )
})

test('parseFabricReconcileResult accepts skipped, reconciled, and teardown shapes', () => {
  assertEquals(
    parseFabricReconcileResult({
      summary: 'TurboFabric disabled',
      skipped: true,
    }),
    { summary: 'TurboFabric disabled', skipped: true },
  )
  assertEquals(
    parseFabricReconcileResult({
      summary: 'TurboFabric reconciled',
      publicKey: WG_PUBKEY,
      peers: [
        {
          publicKey: WG_PUBKEY,
          lastHandshakeAt: '2020-01-01T00:00:00.000Z',
          transferRx: 10,
          transferTx: 20,
        },
      ],
    }).peers?.[0]?.transferRx,
    10,
  )
  assertEquals(
    parseFabricReconcileResult({ summary: 'TurboFabric torn down' }),
    { summary: 'TurboFabric torn down' },
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
  assertThrows(
    () => parseCommandEnvelope('not-json'),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope(null),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: '',
        serverId: 's',
        type: 'daemon.ping',
        attempt: 1,
        queuedAt: 't',
      }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: 'c',
        serverId: 's',
        type: 'unknown',
        attempt: 1,
        queuedAt: 't',
      }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: 'c',
        serverId: 's',
        type: 'daemon.ping',
        attempt: 0,
        queuedAt: 't',
      }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: 'c',
        serverId: 's',
        type: 'daemon.ping',
        attempt: 1.5,
        queuedAt: 't',
      }),
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
  assertEquals(isSystemComponentKey('managed-ingress'), true)
  assertEquals(isSystemComponentKey('database'), true)
  assertEquals(isSystemComponentKey('not-a-component'), false)
})

const VALID_MANAGED_INGRESS_RECONCILE = {
  serverId: '00000000-0000-4000-8000-0000000000ab',
  bindAddress: '203.0.113.10',
  orgTlsMaterial: {
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    privateKeyEnvelope: 'tpdaemon.v1.server.key.payload',
    caCertPem: '-----BEGIN CERTIFICATE-----\nMIICaaaa\n-----END CERTIFICATE-----\n',
  },
  clusters: [
    {
      managedId: '00000000-0000-4000-8000-000000000001',
      engine: 'postgres',
      protocolPort: 5432,
      writerHostgroup: 0,
      readerHostgroup: 1,
      backends: [
        {
          memberId: '00000000-0000-4000-8000-0000000000aa',
          role: 'primary',
          readEligible: true,
          address: '203.0.113.20',
          port: 5432,
          transport: 'local',
        },
      ],
      users: [
        {
          username: 'app',
          role: 'user',
          password: 'tpdaemon.v1.server.key.payload',
          defaultDatabase: 'app',
        },
      ],
    },
  ],
} as const

test('parseManagedIngressReconcilePayload accepts a valid fixture', () => {
  const payload = parseManagedIngressReconcilePayload(
    VALID_MANAGED_INGRESS_RECONCILE,
  )
  assertEquals(payload.serverId, VALID_MANAGED_INGRESS_RECONCILE.serverId)
  assertEquals(payload.bindAddress, '203.0.113.10')
  assertEquals(payload.clusters.length, 1)
  assertEquals(payload.clusters[0]?.protocolPort, 5432)
  assertEquals(
    parseCommandPayload(
      'managed.ingress.reconcile' as CommandType,
      VALID_MANAGED_INGRESS_RECONCILE,
    ),
    payload,
  )
})

test('parseManagedIngressReconcilePayload admits fabric backends and sorted segments', () => {
  const netId = '00000000-0000-4000-8000-0000000000cc'
  const payload = parseManagedIngressReconcilePayload({
    ...VALID_MANAGED_INGRESS_RECONCILE,
    clusters: [
      {
        ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
        backends: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0]!.backends[0],
            transport: 'fabric',
          },
        ],
      },
    ],
    segments: [
      { name: `tpn_${netId}`, subnet: '203.0.113.0/24' },
      { name: `tpn_${netId}`, subnet: '203.0.113.0/24' },
    ],
  })
  assertEquals(payload.clusters[0]?.backends[0]?.transport, 'fabric')
  assertEquals(payload.segments, [
    { name: `tpn_${netId}`, subnet: '203.0.113.0/24' },
  ])
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
            backends: [
              {
                ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0]!.backends[0],
                transport: 'vpn',
              },
            ],
          },
        ],
      }),
    TypeError,
  )
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        segments: [{ name: 'not-tpn', subnet: '203.0.113.0/24' }],
      }),
    TypeError,
  )
})

test('parseManagedIngressReconcilePayload rejects incomplete or hostile input', () => {
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        serverId: 'not-a-uuid',
      }),
    TypeError,
    'Invalid managed.ingress.reconcile payload',
  )
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        orgTlsMaterial: {
          certificatePem: 'x',
          privateKeyEnvelope: 'y',
        },
      }),
    Error,
    'Invalid managed.apply orgTlsMaterial',
  )
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
            protocolPort: 9999,
          },
        ],
      }),
    TypeError,
  )
})

test('parseManagedIngressReconcileResult accepts applied counts and containers', () => {
  assertEquals(
    parseManagedIngressReconcileResult({
      summary: 'ok',
      appliedUsers: ['app'],
      appliedBackends: ['00000000-0000-4000-8000-0000000000aa'],
      restarted: false,
    }),
    {
      summary: 'ok',
      appliedUsers: ['app'],
      appliedBackends: ['00000000-0000-4000-8000-0000000000aa'],
      restarted: false,
    },
  )
  assertEquals(
    parseCommandResult('managed.ingress.reconcile' as CommandType, {
      summary: 'restarted',
      appliedUsers: [],
      appliedBackends: [],
      restarted: true,
    }),
    {
      summary: 'restarted',
      appliedUsers: [],
      appliedBackends: [],
      restarted: true,
    },
  )
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
          role: 'service',
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
          role: 'service',
        },
      ],
    },
  )
  assertEquals(parseManagedApplyResult({}), { host: '', port: 0 })
})

const BASE_ENVIRONMENT_DEPLOY = {
  environmentId: 'env-1',
  projectId: 'proj-1',
  organizationId: 'org-1',
  projectName: 'tp-demo',
  composeYaml: 'services: {}\n',
  hostings: [] as unknown[],
}

const INGRESS_SERVICE_ID = '00000000-0000-4000-8000-000000000099'

test('isValidNtpServer accepts IPv6 literals and rejects invalid shapes', () => {
  assertEquals(isValidNtpServer('2001:db8::1'), true)
  assertEquals(isValidNtpServer('::1'), true)
  assertEquals(isValidNtpServer('203.0.113.256'), false)
  assertEquals(isValidNtpServer('time.example.com '), false)
  assertEquals(isValidNtpServer('a'.repeat(254)), false)
  assertEquals(isValidNtpServer(123), false)
})

test('parseTimezoneSetPayload rejects non-object payloads', () => {
  assertThrows(
    () => parseTimezoneSetPayload(null),
    Error,
    'Invalid timezone set payload',
  )
})

test('parseTimezoneSetResult rejects missing timezone', () => {
  assertThrows(
    () => parseTimezoneSetResult({}),
    Error,
    'Invalid timezone set result',
  )
  assertThrows(
    () => parseTimezoneSetResult(null),
    Error,
    'Invalid timezone set result',
  )
})

test('parseNtpSetPayload rejects non-boolean enabled', () => {
  assertThrows(
    () => parseNtpSetPayload({ enabled: 'yes' }),
    TypeError,
    'enabled must be a boolean',
  )
})

test('parseNtpSetResult keeps optional summary', () => {
  assertEquals(
    parseNtpSetResult({ ntpServers: [], summary: 'applied' }),
    { ntpServers: [], summary: 'applied' },
  )
})

test('parsePingResult keeps lifecycle hop timestamps', () => {
  assertEquals(
    parsePingResult({
      apiAcceptedAt: '2020-01-01T00:00:00.000Z',
      queuedAt: '2020-01-01T00:00:01.000Z',
      consumerReceivedAt: '2020-01-01T00:00:02.000Z',
      cellEnqueuedAt: '2020-01-01T00:00:03.000Z',
      cellDispatchedAt: '2020-01-01T00:00:04.000Z',
      daemonReceivedAt: '2020-01-01T00:00:05.000Z',
      daemonRespondedAt: '2020-01-01T00:00:06.000Z',
      resultRecordedAt: '2020-01-01T00:00:07.000Z',
    }),
    {
      apiAcceptedAt: '2020-01-01T00:00:00.000Z',
      queuedAt: '2020-01-01T00:00:01.000Z',
      consumerReceivedAt: '2020-01-01T00:00:02.000Z',
      cellEnqueuedAt: '2020-01-01T00:00:03.000Z',
      cellDispatchedAt: '2020-01-01T00:00:04.000Z',
      daemonReceivedAt: '2020-01-01T00:00:05.000Z',
      daemonRespondedAt: '2020-01-01T00:00:06.000Z',
      resultRecordedAt: '2020-01-01T00:00:07.000Z',
    },
  )
})

test('parseEnvironmentDeployPayload parses rich hostings and optional material', () => {
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    hostings: [
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
        pathPrefix: '/api',
        targetPort: 8080,
        tlsId: null,
        bindAddress: '203.0.113.10',
        proxy: { forceHttps: true, gzip: true, stripPrefix: '/api' },
        web: { env: { APP_ENV: 'prod', ignored: 1 }, php: { version: '8.4' } },
      },
      {
        hostingId: 'h2',
        serviceId: 's2',
        composeServiceName: 'db',
        hostnames: [],
        protocol: 'tcp',
        ports: [{ published: 5432, target: 5432 }],
      },
    ],
    tlsMaterial: [{
      tlsId: 'tls-1',
      certificatePem: 'CERT',
      privateKeyEnvelope: 'enc:key',
    }],
    variableMaterial: [{
      key: 'FOO',
      valueEnvelope: 'enc:val',
      forBuild: true,
      isLiteral: true,
    }],
    envFile: 'web__PORT=3000\n',
    secretPlan: [{
      key: 'TOKEN',
      composeServiceName: 'web',
      source: 'web_token',
      target: 'TOKEN',
      relativePath: 'web--TOKEN',
      forBuild: false,
      forRuntime: true,
    }],
    storageMaterial: [{
      storageId: 'st1',
      locationId: 'loc1',
      kind: 'volume',
      name: 'data',
      provider: 'docker',
      serverId: 'srv1',
      volumeName: '01936b3e-8c7a-7b2d-a1f0-123456789abc',
      mounts: [],
    }],
    serviceHooks: [{
      composeServiceName: 'web',
      preDeployCommand: '/bin/true',
      buildDisableCache: true,
    }],
    ingressServices: [{
      serviceId: INGRESS_SERVICE_ID,
      composeServiceName: 'db',
      containerName: `${INGRESS_SERVICE_ID}-in`,
    }],
  })
  assertEquals(result.hostings[0]?.pathPrefix, '/api')
  assertEquals(result.hostings[0]?.tlsId, null)
  assertEquals(result.hostings[0]?.bindAddress, '203.0.113.10')
  assertEquals(result.hostings[0]?.proxy, {
    forceHttps: true,
    gzip: true,
    stripPrefix: '/api',
  })
  assertEquals(result.hostings[0]?.web, {
    env: { APP_ENV: 'prod' },
    php: { version: '8.4' },
  })
  assertEquals(result.hostings[1]?.protocol, 'tcp')
  assertEquals(result.hostings[1]?.ports, [{ published: 5432, target: 5432 }])
  assertEquals(result.tlsMaterial?.length, 1)
  assertEquals(result.variableMaterial?.[0]?.forBuild, true)
  assertEquals(result.envFile, 'web__PORT=3000\n')
  assertEquals(result.secretPlan?.[0]?.relativePath, 'web--TOKEN')
  assertEquals(
    result.storageMaterial?.[0]?.volumeName,
    '01936b3e-8c7a-7b2d-a1f0-123456789abc',
  )
  assertEquals(result.serviceHooks?.[0]?.preDeployCommand, '/bin/true')
  assertEquals(
    result.ingressServices?.[0]?.containerName,
    `${INGRESS_SERVICE_ID}-in`,
  )
})

test('parseEnvironmentDeployPayload round-trips composeFiles in caller order', () => {
  const composeFiles = [
    {
      filename: 'docker-compose.yml',
      role: 'project' as const,
      content: 'services:\n  web:\n    image: nginx\n',
    },
    {
      filename: 'docker-compose.prod.yml',
      role: 'environment' as const,
      source: 'inline' as const,
      content: 'services:\n  web:\n    restart: always\n',
    },
    {
      filename: 'docker-compose.turbopanel.yml',
      role: 'platform' as const,
      content: 'services:\n  web:\n    container_name: abc\n',
    },
  ]
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    composeFiles,
  })
  assertEquals(result.composeFiles, composeFiles)
  // Optional source omitted stays omitted
  assertEquals(result.composeFiles?.[0]?.source, undefined)
  // Order preserved (must not sort by filename)
  assertEquals(
    result.composeFiles?.map((f) => f.filename),
    [
      'docker-compose.yml',
      'docker-compose.prod.yml',
      'docker-compose.turbopanel.yml',
    ],
  )
})

test('parseEnvironmentDeployPayload accepts legacy payloads without composeFiles', () => {
  const result = parseEnvironmentDeployPayload(BASE_ENVIRONMENT_DEPLOY)
  assertEquals(result.composeFiles, undefined)
})

test('parseEnvironmentDeployPayload parses repository source with valid path', () => {
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    composeFiles: [
      {
        filename: 'docker-compose.yml',
        role: 'project' as const,
        source: 'repository' as const,
        path: 'deploy/docker-compose.yml',
        content: 'services:\n  web:\n    image: nginx\n',
      },
    ],
  })
  assertEquals(result.composeFiles?.[0]?.source, 'repository')
  assertEquals(result.composeFiles?.[0]?.path, 'deploy/docker-compose.yml')
})

test('parseDeployComposeFiles rejects a path with traversal or a leading slash', () => {
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: 'docker-compose.yml',
          role: 'project',
          source: 'repository',
          path: '../evil/docker-compose.yml',
          content: 'a',
        },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: 'docker-compose.yml',
          role: 'project',
          source: 'repository',
          path: '/etc/docker-compose.yml',
          content: 'a',
        },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: 'docker-compose.yml',
          role: 'project',
          source: 'repository',
          path: '',
          content: 'a',
        },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
})

test('parseDeployComposeFiles rejects invalid entries', () => {
  assertThrows(
    () => parseDeployComposeFiles([]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: '../evil.yml', role: 'project', content: 'x' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: 'nested/file.yml', role: 'project', content: 'x' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: 'compose.txt', role: 'project', content: 'x' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: 'docker-compose.yml', role: 'project', content: 'a' },
        { filename: 'docker-compose.yml', role: 'environment', content: 'b' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: 'docker-compose.yml', role: 'unknown', content: 'a' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: 'docker-compose.yml',
          role: 'project',
          source: 'git',
          content: 'a',
        },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: 'docker-compose.yml', role: 'project', content: '' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: 'docker-compose.turbopanel.yml',
          role: 'platform',
          content: 'p',
        },
        { filename: 'docker-compose.yml', role: 'project', content: 'a' },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: 'docker-compose.yml', role: 'project', content: 'a' },
        {
          filename: 'docker-compose.platform.yml',
          role: 'platform',
          content: 'p1',
        },
        {
          filename: 'docker-compose.turbopanel.yml',
          role: 'platform',
          content: 'p2',
        },
      ]),
    Error,
    'Invalid environment.deploy payload',
  )
})

test('parseEnvironmentDeployPayload rejects invalid hosting protocol and bindAddress', () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [{
          hostingId: 'h1',
          serviceId: 's1',
          composeServiceName: 'web',
          hostnames: [],
          protocol: 'ftp',
        }],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [{
          hostingId: 'h1',
          serviceId: 's1',
          composeServiceName: 'web',
          hostnames: ['app.example.com'],
          bindAddress: 'not-an-ip',
        }],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [{
          hostingId: 'h1',
          serviceId: 's1',
          composeServiceName: 'web',
          hostnames: [],
          protocol: 'tcp',
          ports: [{ published: 0, target: 5432 }],
        }],
      }),
    Error,
    'Invalid environment.deploy payload',
  )
})

test('parseEnvironmentDeployResult keeps services list', () => {
  assertEquals(
    parseEnvironmentDeployResult({
      projectName: 'tp-demo',
      services: ['web', 'api'],
    }),
    { projectName: 'tp-demo', services: ['web', 'api'] },
  )
})

test('parseEnvironmentStopPayload accepts and validates ingressServices', () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      ingressServices: [{ serviceId: INGRESS_SERVICE_ID }],
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      ingressServices: [{ serviceId: INGRESS_SERVICE_ID }],
    },
  )
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: 'env-1',
        projectId: 'proj-1',
        projectName: 'tp-demo',
        ingressServices: [{ serviceId: 'not-a-uuid' }],
      }),
    Error,
    'Invalid environment.stop ingressServices entry',
  )
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: 'env-1',
        projectId: 'proj-1',
        projectName: 'tp-demo',
        ingressServices: 'bad',
      }),
    TypeError,
    'ingressServices must be an array',
  )
})

test('parseEnvironmentStopPayload round-trips tpn_ fabricNetworks and rejects other names', () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      fabricNetworks: ['tpn_net1'],
    }),
    {
      environmentId: 'env-1',
      projectId: 'proj-1',
      projectName: 'tp-demo',
      fabricNetworks: ['tpn_net1'],
    },
  )
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: 'env-1',
        projectId: 'proj-1',
        projectName: 'tp-demo',
        fabricNetworks: ['bridge_net1'],
      }),
    Error,
    'Invalid environment.stop fabricNetworks name',
  )
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: 'env-1',
        projectId: 'proj-1',
        projectName: 'tp-demo',
        fabricNetworks: 'tpn_net1',
      }),
    TypeError,
    'fabricNetworks must be an array',
  )
})

test('parseEnvironmentStopResult round-trips summary and containers', () => {
  assertEquals(
    parseEnvironmentStopResult({
      projectName: 'tp-demo',
      summary: 'stopped',
      containers: [],
    }),
    { projectName: 'tp-demo', summary: 'stopped', containers: [] },
  )
  assertEquals(parseEnvironmentStopResult(null), { projectName: '' })
})
