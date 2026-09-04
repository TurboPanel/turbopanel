import { assertEquals, assertThrows } from "@std/assert";
import { encodeCommandEnvelope, parseCommandEnvelope } from "./envelope.ts";
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
} from "./schemas.ts";
import { COMMAND_TYPES, type CommandType } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parsePingPayload accepts empty object", () => {
  assertEquals(parsePingPayload({}), {});
});

test("parsePingPayload rejects non-object values", () => {
  for (const value of [null, [], "x"]) {
    assertThrows(() => parsePingPayload(value), Error, "Invalid ping payload");
  }
});

test("parseRebootPayload accepts empty object", () => {
  assertEquals(parseRebootPayload({}), {});
});

test("parseRebootPayload rejects non-object values", () => {
  for (const value of [null, [], "x"]) {
    assertThrows(
      () => parseRebootPayload(value),
      Error,
      "Invalid reboot payload",
    );
  }
});

test("parseHostnameSetPayload accepts valid hostname", () => {
  assertEquals(parseHostnameSetPayload({ hostname: "web-01" }), {
    hostname: "web-01",
  });
});

test("parseHostnameSetPayload rejects invalid hostnames", () => {
  for (const hostname of [undefined, "", "a b", "a;b"]) {
    assertThrows(
      () => parseHostnameSetPayload({ hostname }),
      Error,
      "Invalid hostname set payload",
    );
  }
  assertThrows(
    () => parseHostnameSetPayload(null),
    Error,
    "Invalid hostname set payload",
  );
});

test("parsePingResult keeps only valid string hop fields", () => {
  assertEquals(parsePingResult(null), {});
  assertEquals(
    parsePingResult({
      daemonReceivedAt: "2020-01-01T00:00:00.000Z",
      daemonRespondedAt: "2020-01-01T00:00:01.000Z",
      daemonHostname: "web-01",
      daemonBuild: {
        commit: "abc",
        buildId: "build-1",
        builtAt: "2020-01-01T00:00:00.000Z",
        channel: "trunk",
        extra: 1,
      },
      bogus: 123,
    }),
    {
      daemonReceivedAt: "2020-01-01T00:00:00.000Z",
      daemonRespondedAt: "2020-01-01T00:00:01.000Z",
      daemonHostname: "web-01",
      daemonBuild: {
        commit: "abc",
        buildId: "build-1",
        builtAt: "2020-01-01T00:00:00.000Z",
        channel: "trunk",
      },
    },
  );
  assertEquals(parsePingResult({ daemonBuild: {} }), {});
});

test("parseRebootResult returns default for non-records and round-trips valid results", () => {
  assertEquals(parseRebootResult(null), { scheduled: false });
  assertEquals(parseRebootResult({ scheduled: true, summary: "ok" }), {
    scheduled: true,
    summary: "ok",
  });
  assertEquals(parseRebootResult({ scheduled: true }), { scheduled: true });
});

test("parseHostnameSetResult round-trips valid results", () => {
  assertEquals(
    parseHostnameSetResult({ observedHostname: "web-01", summary: "ok" }),
    { observedHostname: "web-01", summary: "ok" },
  );
  assertEquals(
    parseHostnameSetResult({ observedHostname: "web-01" }),
    { observedHostname: "web-01" },
  );
});

test("parseHostnameSetResult rejects missing or empty observedHostname", () => {
  for (const value of [{}, { observedHostname: "" }, { observedHostname: 1 }]) {
    assertThrows(
      () => parseHostnameSetResult(value),
      Error,
      "Invalid hostname set result",
    );
  }
});

/** Keep byte-identical order with daemon `src/instance/commands/contracts.ts`. */
const DAEMON_COMMAND_TYPES = [
  "daemon.ping",
  "server.hostname.set",
  "server.ntp.set",
  "server.reboot",
  "server.timezone.set",
  "server.fabric.reconcile",
  "server.tls.trust.reconcile",
  "server.principals.reconcile",
  "environment.deploy",
  "environment.lifecycle",
  "environment.stop",
  "managed.apply",
  "managed.lifecycle",
  "managed.destroy",
  "managed.backup",
  "managed.restore",
  "managed.promote",
  "managed.ingress.reconcile",
  "managed.ha.reconcile",
  "managed.ha.failover",
  "system.reconcile",
] as const;

test("COMMAND_TYPES matches daemon contracts canonical order", () => {
  assertEquals([...COMMAND_TYPES], [...DAEMON_COMMAND_TYPES]);
});

test("parseEnvironmentLifecyclePayload round-trips and rejects invalid shapes", () => {
  assertEquals(
    parseEnvironmentLifecyclePayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      action: "restart",
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      action: "restart",
    },
  );
  assertThrows(
    () =>
      parseEnvironmentLifecyclePayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        action: "down",
      }),
    Error,
    "Invalid environment.lifecycle payload",
  );
  assertThrows(
    () => parseEnvironmentLifecyclePayload(null),
    Error,
    "Invalid environment.lifecycle payload",
  );
  assertThrows(
    () =>
      parseEnvironmentLifecyclePayload({
        environmentId: "",
        projectId: "proj-1",
        projectName: "tp-demo",
        action: "start",
      }),
    Error,
    "Invalid environment.lifecycle payload",
  );
});

test("parseEnvironmentLifecycleResult is lenient and passes containers through", () => {
  assertEquals(parseEnvironmentLifecycleResult(null), { projectName: "" });
  assertEquals(
    parseEnvironmentLifecycleResult({
      projectName: "tp-demo",
      summary: "ok",
      containers: [
        {
          composeServiceName: "web",
          containerId: "cid-1",
          containerName: "proj-web-1",
          status: "running",
          role: "service",
        },
      ],
    }),
    {
      projectName: "tp-demo",
      summary: "ok",
      containers: [
        {
          composeServiceName: "web",
          containerId: "cid-1",
          containerName: "proj-web-1",
          status: "running",
          role: "service",
        },
      ],
    },
  );
  assertEquals(
    parseEnvironmentLifecycleResult({ projectName: "tp-demo" }).containers,
    undefined,
  );
});

test("parseEnvironmentDeployResult rejects omitted or invalid container roles", () => {
  const base = {
    composeServiceName: "web",
    containerId: "cid-1",
    containerName: "proj-web-1",
    status: "running",
  };
  // Removed legacy 'app', misspellings, and omitted role are contract drift —
  // drop the entry rather than accepting it as default 'service'.
  for (const role of ["app", "workload"] as const) {
    assertEquals(
      parseEnvironmentDeployResult({
        projectName: "tp-demo",
        containers: [{ ...base, role }],
      }).containers,
      [],
    );
  }
  assertEquals(
    parseEnvironmentDeployResult({
      projectName: "tp-demo",
      containers: [base],
    }).containers,
    [],
  );
  // Allowlisted roles round-trip.
  for (const role of ["service", "ingress", "turbopanel"] as const) {
    assertEquals(
      parseEnvironmentDeployResult({
        projectName: "tp-demo",
        containers: [{ ...base, role }],
      }).containers,
      [{ ...base, role }],
    );
  }
});

test("parseSystemReconcilePayload round-trips and rejects invalid shapes", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const environmentId = "11111111-2222-3333-4444-555555555555";
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      action: "restart",
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "present",
        },
      ],
    }),
    {
      environmentId,
      action: "restart",
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "present",
        },
      ],
    },
  );
  // Default action when omitted.
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "absent",
        },
      ],
    }).action,
    "reconcile",
  );
  // Explicit stop (hosting-disable) is allowed.
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      action: "stop",
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "absent",
        },
      ],
    }).action,
    "stop",
  );

  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "not-allowlisted",
            serviceId,
            composeServiceName: "traefik",
            containerName: `${serviceId}-in`,
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "hosting-ingress",
            serviceId: "not-a-uuid",
            composeServiceName: "traefik",
            containerName: "not-a-uuid-ingress",
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "hosting-ingress",
            serviceId,
            composeServiceName: "traefik",
            containerName: "wrong-name",
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: Array.from({ length: 9 }, (_, i) => ({
          component: "hosting-ingress",
          serviceId: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${i}`,
          composeServiceName: "traefik",
          containerName: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${i}-in`,
          role: "ingress",
          desired: "present",
        })),
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "hosting-ingress",
            serviceId,
            composeServiceName: "traefik",
            containerName: `${serviceId}-in`,
            role: "ingress",
            desired: "maybe",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
});

test("parseSystemReconcilePayload accepts the widened database/queue component keys with system role and bare serviceId containerName", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const environmentId = "11111111-2222-3333-4444-555555555555";
  for (const component of ["database", "queue"] as const) {
    assertEquals(
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component,
            serviceId,
            composeServiceName: component,
            containerName: serviceId,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }).components[0],
      {
        component,
        serviceId,
        composeServiceName: component,
        containerName: serviceId,
        role: "turbopanel",
        desired: "present",
      },
    );
  }
});

test("parseSystemReconcilePayload accepts managed-ingress with ingress role and -in containerName", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const environmentId = "11111111-2222-3333-4444-555555555555";
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      components: [
        {
          component: "managed-ingress",
          serviceId,
          composeServiceName: "proxysql",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "present",
        },
      ],
    }).components[0],
    {
      component: "managed-ingress",
      serviceId,
      composeServiceName: "proxysql",
      containerName: `${serviceId}-in`,
      role: "ingress",
      desired: "present",
    },
  );
});

test("parseSystemReconcilePayload rejects role/containerName mismatches across the system/ingress split", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const environmentId = "11111111-2222-3333-4444-555555555555";
  // hosting-ingress must be role: 'ingress' — declaring 'service' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "hosting-ingress",
            serviceId,
            composeServiceName: "traefik",
            containerName: `${serviceId}-in`,
            role: "service",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  // database must be role: 'turbopanel' — declaring 'ingress' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "database",
            serviceId,
            composeServiceName: "database",
            containerName: `${serviceId}-in`,
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  // database with role: 'turbopanel' but an ingress-shaped containerName is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "database",
            serviceId,
            composeServiceName: "database",
            containerName: `${serviceId}-in`,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  // managed-ingress requires the -in suffix — bare serviceId is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "managed-ingress",
            serviceId,
            composeServiceName: "proxysql",
            containerName: serviceId,
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  // managed-ingress must not use the retired -sql suffix.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "managed-ingress",
            serviceId,
            composeServiceName: "proxysql",
            containerName: `${serviceId}-sql`,
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
  // managed-ingress must be role: 'ingress' — declaring 'turbopanel' is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "managed-ingress",
            serviceId,
            composeServiceName: "proxysql",
            containerName: `${serviceId}-in`,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }),
    Error,
    "Invalid system.reconcile payload",
  );
});

test("parseSystemReconcileResult is lenient and passes containers through", () => {
  assertEquals(parseSystemReconcileResult(null), {});
  assertEquals(
    parseSystemReconcileResult({
      summary: "ok",
      containers: [
        {
          composeServiceName: "traefik",
          containerId: "cid-1",
          containerName: "svc-ingress",
          status: "running",
          role: "ingress",
        },
      ],
    }),
    {
      summary: "ok",
      containers: [
        {
          composeServiceName: "traefik",
          containerId: "cid-1",
          containerName: "svc-ingress",
          status: "running",
          role: "ingress",
        },
      ],
    },
  );
  assertEquals(
    parseSystemReconcileResult({ summary: "ok" }).containers,
    undefined,
  );
  assertEquals(parseSystemReconcileResult({ containers: [] }).containers, []);
});

test("parseTimezoneSetPayload accepts valid IANA shapes", () => {
  assertEquals(parseTimezoneSetPayload({ timezone: "America/Chicago" }), {
    timezone: "America/Chicago",
  });
  assertEquals(parseTimezoneSetPayload({ timezone: "UTC" }), {
    timezone: "UTC",
  });
});

test("parseTimezoneSetPayload rejects invalid timezones", () => {
  for (const timezone of [undefined, "", "a b", "a;b", "Etc/GMT+0 "]) {
    assertThrows(
      () => parseTimezoneSetPayload({ timezone }),
      Error,
      "Invalid timezone set payload",
    );
  }
});

test("parseTimezoneSetResult round-trips", () => {
  assertEquals(
    parseTimezoneSetResult({ timezone: "UTC", summary: "ok" }),
    { timezone: "UTC", summary: "ok" },
  );
});

test("parseNtpSetPayload accepts enabled and server lists", () => {
  assertEquals(
    parseNtpSetPayload({
      enabled: true,
      servers: ["time.cloudflare.com", "203.0.113.10"],
      fallbackServers: ["2001:db8::1"],
    }),
    {
      enabled: true,
      servers: ["time.cloudflare.com", "203.0.113.10"],
      fallbackServers: ["2001:db8::1"],
    },
  );
  assertEquals(parseNtpSetPayload({ enabled: false }), { enabled: false });
});

test("parseNtpSetPayload rejects invalid NTP servers and empty payloads", () => {
  assertThrows(
    () => parseNtpSetPayload({ servers: ["999.999.999.999"] }),
    Error,
    "Invalid NTP server",
  );
  assertThrows(
    () => parseNtpSetPayload({}),
    Error,
    "ntp payload must include enabled",
  );
  assertThrows(
    () => parseNtpSetPayload({ servers: [] }),
    Error,
    "must not be empty",
  );
});

test("parseNtpSetResult keeps server lists", () => {
  assertEquals(
    parseNtpSetResult({
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ["time.cloudflare.com"],
      fallbackNtpServers: ["203.0.113.10"],
    }),
    {
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ["time.cloudflare.com"],
      fallbackNtpServers: ["203.0.113.10"],
    },
  );
});

test("parseNtpSetResult rejects missing or malformed ntpServers", () => {
  assertThrows(
    () => parseNtpSetResult({ ntpEnabled: true }),
    TypeError,
    "ntpServers must be an array",
  );
  assertThrows(
    () => parseNtpSetResult({ ntpServers: "time.cloudflare.com" }),
    TypeError,
    "ntpServers must be an array",
  );
  assertThrows(
    () => parseNtpSetResult({ ntpServers: [123] }),
    Error,
    "Invalid NTP server in ntpServers",
  );
  assertThrows(
    () =>
      parseNtpSetResult({
        ntpServers: ["time.cloudflare.com"],
        fallbackNtpServers: "203.0.113.10",
      }),
    TypeError,
    "fallbackNtpServers must be an array",
  );
});

/** Org-wide managed Docker network name — a `network.kind='managed'` row id. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

const VALID_MANAGED_APPLY = {
  managedId: "00000000-0000-4000-8000-000000000001",
  environmentId: "00000000-0000-4000-8000-000000000002",
  engine: "postgres",
  projectName: "tp-managed-pg",
  containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  managedNetwork: MANAGED_NETWORK,
  image: "docker.io/library/postgres:18-alpine",
  containerPort: 5432,
  composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
  configFiles: [
    {
      path: "postgresql.conf",
      contents: "listen_addresses = '*'\n",
      mode: "0640",
    },
    {
      path: "pg_hba.conf",
      contents:
        "# TurboPanel managed PostgreSQL — platform pg_hba\nlocal all all peer\n",
      mode: "0640",
    },
  ],
  volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
  exposure: { enabled: false, protocol: "tcp" },
  memberId: "00000000-0000-4000-8000-0000000000aa",
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: true,
  peers: [],
  credentials: [
    {
      principalId: "00000000-0000-4000-8000-000000000003",
      username: "postgres",
      role: "root",
      databases: ["postgres"],
      password: "tpdaemon.v1.server.key.payload",
    },
  ],
} as const;

test("parseCommandPayload and parseCommandResult dispatch by type", () => {
  assertEquals(parseCommandPayload("daemon.ping" as CommandType, {}), {});
  assertEquals(
    parseCommandPayload("server.hostname.set" as CommandType, {
      hostname: "web-01",
    }),
    { hostname: "web-01" },
  );
  assertEquals(
    parseCommandPayload("server.timezone.set" as CommandType, {
      timezone: "UTC",
    }),
    { timezone: "UTC" },
  );
  assertEquals(
    parseCommandPayload("server.ntp.set" as CommandType, { enabled: true }),
    { enabled: true },
  );
  assertEquals(parseCommandPayload("server.reboot" as CommandType, {}), {});
  assertEquals(
    parseCommandPayload("server.tls.trust.reconcile" as CommandType, {
      bundlePem:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      fingerprint: "a".repeat(64),
    }),
    {
      bundlePem:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      fingerprint: "a".repeat(64),
    },
  );
  assertEquals(
    parseCommandResult("server.tls.trust.reconcile" as CommandType, {
      applied: true,
      fingerprint: "a".repeat(64),
    }),
    { applied: true, fingerprint: "a".repeat(64) },
  );
  assertEquals(
    parseCommandPayload("environment.deploy" as CommandType, {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
      hostings: [],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
      hostings: [],
    },
  );
  assertEquals(
    parseCommandPayload("environment.stop" as CommandType, {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
    },
  );
  assertEquals(
    parseCommandPayload("environment.lifecycle" as CommandType, {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      action: "stop",
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      action: "stop",
    },
  );
  assertEquals(
    parseCommandResult("daemon.ping" as CommandType, { daemonHostname: "x" }),
    {
      daemonHostname: "x",
    },
  );
  assertEquals(
    parseCommandResult("server.hostname.set" as CommandType, {
      observedHostname: "web-01",
    }),
    { observedHostname: "web-01" },
  );
  assertEquals(
    parseCommandResult("server.timezone.set" as CommandType, {
      timezone: "UTC",
    }),
    { timezone: "UTC" },
  );
  assertEquals(
    parseCommandResult("server.ntp.set" as CommandType, { ntpServers: [] }),
    { ntpServers: [] },
  );
  assertEquals(
    parseCommandResult("server.reboot" as CommandType, {
      scheduled: true,
      summary: "ok",
    }),
    { scheduled: true, summary: "ok" },
  );
  assertEquals(
    parseCommandResult("environment.deploy" as CommandType, {
      projectName: "tp-demo",
      summary: "up",
    }),
    { projectName: "tp-demo", summary: "up" },
  );
  assertEquals(
    parseCommandResult("environment.deploy" as CommandType, {
      projectName: "tp-demo",
      summary: "scaled to zero",
      containers: [],
    }),
    { projectName: "tp-demo", summary: "scaled to zero", containers: [] },
  );
  assertEquals(
    parseCommandResult("environment.deploy" as CommandType, {
      projectName: "tp-demo",
      containers: [
        {
          composeServiceName: "web",
          containerId: "abc",
          containerName: "proj-web-1",
          status: "running",
          serviceId: "00000000-0000-4000-8000-000000000099",
          role: "service",
        },
      ],
    }),
    {
      projectName: "tp-demo",
      containers: [
        {
          composeServiceName: "web",
          containerId: "abc",
          containerName: "proj-web-1",
          status: "running",
          serviceId: "00000000-0000-4000-8000-000000000099",
          role: "service",
        },
      ],
    },
  );
  assertEquals(
    parseCommandResult("environment.stop" as CommandType, {
      projectName: "tp-demo",
      summary: "stopped",
      containers: [],
    }),
    { projectName: "tp-demo", summary: "stopped", containers: [] },
  );
  assertEquals(
    parseCommandResult("environment.lifecycle" as CommandType, {
      projectName: "tp-demo",
      summary: "Lifecycle stop",
      containers: [
        {
          composeServiceName: "web",
          containerId: "abc",
          containerName: "proj-web-1",
          status: "exited",
          role: "service",
        },
      ],
    }),
    {
      projectName: "tp-demo",
      summary: "Lifecycle stop",
      containers: [
        {
          composeServiceName: "web",
          containerId: "abc",
          containerName: "proj-web-1",
          status: "exited",
          role: "service",
        },
      ],
    },
  );
  assertEquals(
    parseCommandPayload("managed.apply" as CommandType, VALID_MANAGED_APPLY),
    parseManagedApplyPayload(VALID_MANAGED_APPLY),
  );
  assertEquals(
    parseCommandPayload("managed.lifecycle" as CommandType, {
      managedId: "m1",
      action: "restart",
    }),
    { managedId: "m1", action: "restart" },
  );
  assertEquals(
    parseCommandPayload("managed.lifecycle" as CommandType, {
      managedId: "m1",
      action: "stop",
      engine: "mysql",
    }),
    { managedId: "m1", action: "stop", engine: "mysql" },
  );
  assertEquals(
    parseCommandPayload("managed.promote" as CommandType, {
      managedId: "11111111-1111-1111-1111-111111111111",
      memberId: "22222222-2222-2222-2222-222222222222",
      engine: "mariadb",
    }),
    {
      managedId: "11111111-1111-1111-1111-111111111111",
      memberId: "22222222-2222-2222-2222-222222222222",
      engine: "mariadb",
    },
  );
  assertEquals(
    parseCommandPayload("managed.destroy" as CommandType, {
      managedId: "m1",
      removeVolumes: true,
    }),
    { managedId: "m1", removeVolumes: true },
  );
  assertEquals(
    parseCommandResult("managed.apply" as CommandType, {
      host: "203.0.113.10",
      port: 5432,
      summary: "ready",
    }),
    { host: "203.0.113.10", port: 5432, summary: "ready" },
  );
  assertEquals(
    parseCommandResult("managed.lifecycle" as CommandType, {
      status: "ready",
    }),
    { status: "ready" },
  );
  assertEquals(
    parseCommandResult("managed.destroy" as CommandType, {
      status: "stopped",
      containers: [],
      summary: "removed",
    }),
    { status: "stopped", containers: [], summary: "removed" },
  );
  assertEquals(
    parseCommandPayload("managed.backup" as CommandType, {
      managedId: "m1",
      engine: "postgres",
      action: "create",
      backupId: "bk_1",
      artifactExtension: "dump",
      scope: "database",
      database: "appdb",
    }),
    {
      managedId: "m1",
      engine: "postgres",
      action: "create",
      backupId: "bk_1",
      artifactExtension: "dump",
      scope: "database",
      database: "appdb",
    },
  );
  assertEquals(
    parseCommandResult("managed.backup" as CommandType, {
      backupId: "bk_1",
      path: "/var/lib/turbopanel/managed/m1/backups/bk_1.dump",
      sizeBytes: 1024,
      checksum: "a".repeat(64),
      completedAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
      pruned: ["bk_0"],
    }),
    {
      backupId: "bk_1",
      path: "/var/lib/turbopanel/managed/m1/backups/bk_1.dump",
      sizeBytes: 1024,
      checksum: "a".repeat(64),
      completedAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
      pruned: ["bk_0"],
    },
  );
  assertEquals(
    parseCommandPayload("managed.restore" as CommandType, {
      managedId: "m1",
      engine: "postgres",
      backupId: "bk_1",
      artifactExtension: "dump",
      database: "appdb",
      checksum: "a".repeat(64),
    }),
    {
      managedId: "m1",
      engine: "postgres",
      backupId: "bk_1",
      artifactExtension: "dump",
      database: "appdb",
      checksum: "a".repeat(64),
    },
  );
  assertEquals(
    parseCommandResult("managed.restore" as CommandType, {
      backupId: "bk_1",
      status: "ready",
      restoredAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
    }),
    {
      backupId: "bk_1",
      status: "ready",
      restoredAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
    },
  );
});

test("parseManagedApplyPayload accepts a valid fixture", () => {
  const payload = parseManagedApplyPayload(VALID_MANAGED_APPLY);
  assertEquals(payload.managedNetwork, MANAGED_NETWORK);
  assertEquals(payload.engine, "postgres");
  assertEquals(payload.projectName, "tp-managed-pg");
  assertEquals(payload.credentials.length, 1);
  assertEquals(payload.configFiles[0]?.mode, "0640");
});

test("parseManagedApplyPayload rejects unsafe or incomplete input", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        projectName: "Bad Name!",
      }),
    Error,
    "Invalid managed.apply payload",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        containerName: "-bad",
      }),
    Error,
    "Invalid managed.apply payload",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        containerPort: 70000,
      }),
    Error,
    "Invalid managed.apply payload",
  );
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, credentials: [] }),
    Error,
    "Invalid managed.apply credentials",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: "../etc/passwd", contents: "x", mode: "0640" },
        ],
      }),
    Error,
    "Invalid managed.apply configFiles entry",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        credentials: [
          {
            ...VALID_MANAGED_APPLY.credentials[0],
            password: "plaintext-not-allowed",
          },
        ],
      }),
    Error,
    "Invalid managed.apply credentials entry",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: { privileged: true },
      }),
    Error,
    "Invalid managed.apply dockerOptions",
  );
});

test("parseManagedApplyPayload enforces the engine image allowlist", () => {
  // The fixture's approved postgres:18-alpine image is unaffected.
  assertEquals(
    parseManagedApplyPayload(VALID_MANAGED_APPLY).image,
    VALID_MANAGED_APPLY.image,
  );

  // An EOL major absent from the release catalog is syntactically a valid image
  // ref but must still be rejected — mirrors the settings-parser allowlist in
  // `../managed/settings.ts` so a replayed or forged command payload cannot
  // bypass it.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        image: "docker.io/library/postgres:14",
      }),
    Error,
    "Invalid managed.apply payload",
  );
  // Cross-engine image swap must also be rejected even though it is on the
  // MySQL allowlist — the payload's `engine` is postgres.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        image: "docker.io/library/mysql:9.7",
      }),
    Error,
    "Invalid managed.apply payload",
  );
  // Approved MySQL / MariaDB images are accepted for their own engine.
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      engine: "mysql",
      image: "docker.io/library/mysql:9.7",
      credentials: [{
        ...VALID_MANAGED_APPLY.credentials[0],
        username: "root",
      }],
    }).image,
    "docker.io/library/mysql:9.7",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        engine: "mariadb",
        image: "docker.io/library/mariadb:11",
        credentials: [{
          ...VALID_MANAGED_APPLY.credentials[0],
          username: "root",
        }],
      }),
    Error,
    "Invalid managed.apply payload",
  );
});

test("parseManagedApplyPayload rejects nested dockerOptions and enabled exposure without port", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: { restart: "invalid-policy" },
      }),
    Error,
    "Invalid managed.apply dockerOptions",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: {
          ulimits: { nofile: { soft: 2048, hard: 1024 } },
        },
      }),
    Error,
    "Invalid managed.apply dockerOptions",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: {
          labels: { "traefik.enable": "true" },
        },
      }),
    Error,
    "Invalid managed.apply dockerOptions",
  );
  // publishedPort is ignored — ProxySQL owns protocol ports.
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      exposure: { enabled: true, protocol: "tcp", publishedPort: 15432 },
    }).exposure,
    { enabled: true, protocol: "tcp" },
  );
});

test("parseManagedApplyPayload accepts member fields and peers", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    memberOrdinal: 2,
    memberRole: "replica",
    containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-2",
    peers: [
      {
        memberId: "00000000-0000-4000-8000-0000000000bb",
        role: "primary",
        readEligible: true,
        address: "203.0.113.10",
        transport: "datacenter",
        port: 5432,
      },
    ],
  });
  assertEquals(payload.memberOrdinal, 2);
  assertEquals(payload.memberRole, "replica");
  assertEquals(payload.peers.length, 1);
  assertEquals(payload.peers[0]?.address, "203.0.113.10");
});

test("parseManagedApplyPayload round-trips a fabric peer and rejects vpn", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    peers: [
      {
        memberId: "00000000-0000-4000-8000-0000000000bb",
        role: "replica",
        readEligible: true,
        address: "203.0.113.11",
        transport: "fabric",
        port: 45001,
      },
    ],
  });
  assertEquals(payload.peers[0]?.transport, "fabric");
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      peers: [
        {
          memberId: "00000000-0000-4000-8000-0000000000bb",
          role: "replica",
          readEligible: true,
          address: "203.0.113.11",
          transport: "public",
          port: 45001,
        },
      ],
    }).peers[0]?.transport,
    "public",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        peers: [
          {
            memberId: "00000000-0000-4000-8000-0000000000bb",
            role: "replica",
            readEligible: true,
            address: "203.0.113.11",
            transport: "vpn",
            port: 45001,
          },
        ],
      }),
    Error,
  );
});

test("parseManagedApplyPayload tags an optional privateListener transport", () => {
  const untagged = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    privateListener: { address: "203.0.113.50", port: 45001 },
  });
  // Omitted stays omitted so pre-transport daemons keep the old semantics.
  assertEquals(untagged.privateListener?.transport, undefined);

  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      privateListener: {
        address: "203.0.113.50",
        port: 45001,
        transport: "public",
      },
    }).privateListener?.transport,
    "public",
  );

  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        privateListener: {
          address: "203.0.113.50",
          port: 45001,
          transport: "vpn",
        },
      }),
    Error,
    "Invalid managed.apply privateListener",
  );
});

test("parseManagedPromotePayload and result accept valid shapes", () => {
  assertEquals(
    parseManagedPromotePayload({
      managedId: "00000000-0000-4000-8000-000000000001",
      memberId: "00000000-0000-4000-8000-0000000000aa",
      demoteMemberId: "00000000-0000-4000-8000-0000000000bb",
    }),
    {
      managedId: "00000000-0000-4000-8000-000000000001",
      memberId: "00000000-0000-4000-8000-0000000000aa",
      demoteMemberId: "00000000-0000-4000-8000-0000000000bb",
    },
  );
  assertEquals(
    parseManagedPromoteResult({
      status: "ready",
      role: "primary",
      summary: "ok",
      promotedMemberId: "00000000-0000-4000-8000-0000000000aa",
      demoted: true,
      demotedMemberId: "00000000-0000-4000-8000-0000000000bb",
    }),
    {
      status: "ready",
      role: "primary",
      summary: "ok",
      promotedMemberId: "00000000-0000-4000-8000-0000000000aa",
      demoted: true,
      demotedMemberId: "00000000-0000-4000-8000-0000000000bb",
    },
  );
});

test("managed.promote is in COMMAND_TYPES", () => {
  assertEquals(COMMAND_TYPES.includes("managed.promote"), true);
});

test("parseManagedApplyPayload rejects dockerOptions.extraEnv overriding postgres-reserved env keys", () => {
  for (
    const [key, value] of [
      ["POSTGRES_PASSWORD", "hunter2"],
      ["POSTGRES_USER", "root"],
      ["POSTGRES_DB", "postgres"],
      ["POSTGRES_INITDB_ARGS", "--data-checksums"],
      ["POSTGRES_HOST_AUTH_METHOD", "trust"],
      ["PGDATA", "/var/lib/postgresql/evil"],
    ] as const
  ) {
    assertThrows(
      () =>
        parseManagedApplyPayload({
          ...VALID_MANAGED_APPLY,
          dockerOptions: { extraEnv: { [key]: value } },
        }),
      Error,
      "Invalid managed.apply dockerOptions",
    );
  }
});

test("parseManagedApplyPayload accepts dockerOptions.extraEnv with harmless keys", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    dockerOptions: { extraEnv: { TZ: "UTC" } },
  });
  assertEquals(payload.dockerOptions?.extraEnv, { TZ: "UTC" });
});

test("parseManagedApplyPayload admits allowlisted config paths and rejects unexpected relative names", () => {
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      configFiles: [
        { path: "postgresql.conf", contents: "x\n", mode: "0640" },
        { path: "pg_hba.conf", contents: "local all all peer\n", mode: "0640" },
        { path: "tls/server.crt", contents: "cert\n", mode: "0640" },
        { path: "tls/server.key", contents: "key\n", mode: "0600" },
      ],
    }).configFiles.map((file) => file.path),
    ["postgresql.conf", "pg_hba.conf", "tls/server.crt", "tls/server.key"],
  );
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      configFiles: [
        { path: "my.cnf", contents: "[mysqld]\n", mode: "0640" },
        {
          path: "initdb/00-turbopanel.sql",
          contents: "SELECT 1;\n",
          mode: "0640",
        },
      ],
    }).configFiles.map((file) => file.path),
    ["my.cnf", "initdb/00-turbopanel.sql"],
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: "unexpected.conf", contents: "x\n", mode: "0640" },
        ],
      }),
    Error,
    "Invalid managed.apply configFiles entry",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: "nested/postgresql.conf", contents: "x\n", mode: "0640" },
        ],
      }),
    Error,
    "Invalid managed.apply configFiles entry",
  );
});

test("parseManagedApplyPayload admits tlsMaterial and rejects hostile cert paths", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    tlsMaterial: {
      selfSigned: true,
      commonName: "managed-postgres",
      certPath: "tls/server.crt",
      keyPath: "tls/server.key",
    },
  });
  assertEquals(payload.tlsMaterial?.commonName, "managed-postgres");
  assertEquals(payload.tlsMaterial?.certPath, "tls/server.crt");
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        tlsMaterial: {
          selfSigned: true,
          commonName: "managed-postgres",
          certPath: "../etc/passwd",
          keyPath: "tls/server.key",
        },
      }),
    Error,
    "Invalid managed.apply tlsMaterial",
  );
});

test("parseManagedApplyPayload admits orgTlsMaterial and rejects incomplete material", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    orgTlsMaterial: {
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
      privateKeyEnvelope: "tpdaemon.v1.server.key.ciphertext",
      caCertPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    },
  });
  assertEquals(
    payload.orgTlsMaterial?.caCertPem.includes("BEGIN CERTIFICATE"),
    true,
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        orgTlsMaterial: {
          certificatePem: "not-a-pem",
          privateKeyEnvelope: "tpdaemon.v1.x",
          caCertPem:
            "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
        },
      }),
    Error,
    "Invalid managed.apply orgTlsMaterial",
  );
});

test("parseManagedLifecycleResult and parseManagedDestroyResult project observed status", () => {
  assertEquals(parseManagedLifecycleResult({ status: "ready" }), {
    status: "ready",
  });
  assertEquals(parseManagedLifecycleResult({ status: "stopped" }), {
    status: "stopped",
  });
  assertEquals(
    parseManagedLifecycleResult({ status: "failed", summary: "compose down" }),
    { status: "failed", summary: "compose down" },
  );
  assertEquals(
    parseManagedDestroyResult({
      status: "stopped",
      containers: [],
      summary: "removed",
    }),
    { status: "stopped", containers: [], summary: "removed" },
  );
  assertEquals(parseManagedDestroyResult({ status: "failed" }), {
    status: "failed",
    containers: [],
  });
  assertEquals(parseManagedDestroyResult(null), {
    status: "",
    containers: [],
  });
});

test("parseManagedLifecyclePayload accepts valid actions and rejects others", () => {
  assertEquals(
    parseManagedLifecyclePayload({ managedId: "m1", action: "start" }),
    { managedId: "m1", action: "start" },
  );
  assertThrows(
    () => parseManagedLifecyclePayload({ managedId: "m1", action: "pause" }),
    Error,
    "Invalid managed.lifecycle payload",
  );
});

test("parseManagedDestroyPayload requires removeVolumes", () => {
  assertEquals(
    parseManagedDestroyPayload({ managedId: "m1", removeVolumes: false }),
    { managedId: "m1", removeVolumes: false },
  );
  assertThrows(
    () => parseManagedDestroyPayload({ managedId: "m1" }),
    Error,
    "Invalid managed.destroy payload",
  );
});

test("parseManagedDestroyPayload accepts and preserves the deleteAfterDestroy marker", () => {
  assertEquals(
    parseManagedDestroyPayload({
      managedId: "m1",
      removeVolumes: true,
      deleteAfterDestroy: true,
    }),
    { managedId: "m1", removeVolumes: true, deleteAfterDestroy: true },
  );
  // Omitted marker stays omitted — a future "destroy runtime only" action
  // must be able to send this payload shape and never trigger row cleanup.
  assertEquals(
    parseManagedDestroyPayload({ managedId: "m1", removeVolumes: true }),
    { managedId: "m1", removeVolumes: true },
  );
  assertThrows(
    () =>
      parseManagedDestroyPayload({
        managedId: "m1",
        removeVolumes: true,
        deleteAfterDestroy: "yes",
      }),
    Error,
    "Invalid managed.destroy payload",
  );
});

const VALID_MANAGED_BACKUP_CREATE = {
  managedId: "m1",
  engine: "postgres",
  action: "create",
  backupId: "bk_1700000000000",
  artifactExtension: "dump",
  scope: "database",
  database: "appdb",
} as const;

test("parseManagedBackupPayload accepts a valid create fixture", () => {
  assertEquals(
    parseManagedBackupPayload(VALID_MANAGED_BACKUP_CREATE),
    VALID_MANAGED_BACKUP_CREATE,
  );
});

test("parseManagedBackupPayload accepts delete action and optional retentionKeep", () => {
  assertEquals(
    parseManagedBackupPayload({
      ...VALID_MANAGED_BACKUP_CREATE,
      action: "delete",
      retentionKeep: 7,
    }),
    { ...VALID_MANAGED_BACKUP_CREATE, action: "delete", retentionKeep: 7 },
  );
});

test("parseManagedBackupPayload rejects hostile or malformed input", () => {
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        backupId: "../etc/passwd",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        backupId: "bk_1; rm -rf /",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        artifactExtension: "exe",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        action: "destroy",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        database: "bad; name",
      }),
    Error,
    "Invalid managed.backup payload database",
  );
  assertThrows(
    () => {
      const { database: _database, ...rest } = VALID_MANAGED_BACKUP_CREATE;
      return parseManagedBackupPayload(rest);
    },
    Error,
    "scope database requires database",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        retentionKeep: 0,
      }),
    Error,
    "Invalid managed.backup payload retentionKeep",
  );
  assertThrows(
    () => parseManagedBackupPayload(null),
    Error,
    "Invalid managed.backup payload",
  );
});

test("parseManagedBackupResult is lenient and never carries dump contents", () => {
  assertEquals(parseManagedBackupResult(null), { backupId: "" });
  assertEquals(
    parseManagedBackupResult({
      backupId: "bk_1",
      path: "/var/lib/turbopanel/managed/m1/backups/bk_1.dump",
      sizeBytes: 2048,
      checksum: "b".repeat(64),
      completedAt: "2020-01-01T00:00:00.000Z",
      pruned: ["bk_0", "bk_-1"],
      dumpContents: "should never be parsed through",
    }),
    {
      backupId: "bk_1",
      path: "/var/lib/turbopanel/managed/m1/backups/bk_1.dump",
      sizeBytes: 2048,
      checksum: "b".repeat(64),
      completedAt: "2020-01-01T00:00:00.000Z",
      pruned: ["bk_0", "bk_-1"],
    },
  );
  // Malformed checksum is dropped rather than accepted.
  assertEquals(
    parseManagedBackupResult({ backupId: "bk_1", checksum: "not-hex" }),
    { backupId: "bk_1" },
  );
});

const VALID_MANAGED_RESTORE = {
  managedId: "m1",
  engine: "postgres",
  backupId: "bk_1700000000000",
  artifactExtension: "dump",
  database: "appdb",
  checksum: "c".repeat(64),
} as const;

test("parseManagedRestorePayload accepts a valid fixture", () => {
  assertEquals(
    parseManagedRestorePayload(VALID_MANAGED_RESTORE),
    VALID_MANAGED_RESTORE,
  );
});

test("parseManagedRestorePayload rejects hostile or malformed input", () => {
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        backupId: "../../etc",
      }),
    Error,
    "Invalid managed.restore payload",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        checksum: "not-hex",
      }),
    Error,
    "Invalid managed.restore payload",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        artifactExtension: "sh",
      }),
    Error,
    "Invalid managed.restore payload",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        database: "bad; name",
      }),
    Error,
    "Invalid managed.restore payload database",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, sizeBytes: -1 }),
    Error,
    "Invalid managed.restore payload sizeBytes",
  );
  assertThrows(
    () => parseManagedRestorePayload(null),
    Error,
    "Invalid managed.restore payload",
  );
});

test("parseManagedRestoreResult is lenient and never carries dump contents", () => {
  assertEquals(parseManagedRestoreResult(null), { backupId: "" });
  assertEquals(
    parseManagedRestoreResult({
      backupId: "bk_1",
      status: "ready",
      restoredAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
      summary: "restored",
      dumpContents: "should never be parsed through",
    }),
    {
      backupId: "bk_1",
      status: "ready",
      restoredAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
      summary: "restored",
    },
  );
});

test("parseCommandPayload accepts sites and dockerExternalNetworks", () => {
  assertEquals(
    parseCommandPayload("environment.deploy" as CommandType, {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services:\\n  api:\\n    image: node:22\\n" }],
      hostings: [],
      dockerExternalNetworks: ["zeta-net", "alpha-net", "alpha-net"],
      sites: [
        {
          composeServiceName: "web",
          engine: "apache",
          root: "public",
          listenPort: 18080,
          webEnv: { APP_ENV: "prod" },
          php: {
            version: "8.4",
            settings: { memory_limit: "256M", max_execution_time: "30" },
          },
          principal: {
            principalId: "00000000-0000-4000-8000-000000000099",
            username: "site_user",
            uid: 10001,
            gid: 10001,
          },
        },
      ],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services:\\n  api:\\n    image: node:22\\n" }],
      hostings: [],
      dockerExternalNetworks: ["alpha-net", "zeta-net"],
      sites: [
        {
          composeServiceName: "web",
          engine: "apache",
          root: "public",
          listenPort: 18080,
          webEnv: { APP_ENV: "prod" },
          php: {
            version: "8.4",
            settings: { memory_limit: "256M", max_execution_time: "30" },
          },
          principal: {
            principalId: "00000000-0000-4000-8000-000000000099",
            username: "site_user",
            uid: 10001,
            gid: 10001,
          },
        },
      ],
    },
  );
});

test("parseCommandPayload accepts noCache on environment.deploy", () => {
  assertEquals(
    parseCommandPayload("environment.deploy" as CommandType, {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services:\\n  api:\\n    image: node:22\\n" }],
      hostings: [],
      noCache: true,
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services:\\n  api:\\n    image: node:22\\n" }],
      hostings: [],
      noCache: true,
    },
  );
});

test("parseCommandPayload rejects non-boolean noCache on environment.deploy", () => {
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo",
        composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
        hostings: [],
        noCache: "yes",
      }),
    Error,
    "Invalid environment.deploy payload",
  );
});

function deployPayloadWithPrincipal(runtimes: unknown) {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}\n",
    }],
    hostings: [],
    principalMaterial: [{
      principalId: "00000000-0000-4000-8000-000000000001",
      username: "appuser",
      runtimes,
    }],
  };
}

test("parseCommandPayload round-trips principal runtime entitlements", () => {
  const parsed = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithPrincipal([
      { runtime: "php", series: "8.4" },
      { runtime: "node", series: "24" },
    ]),
  ) as { principalMaterial: { runtimes?: unknown }[] };
  assertEquals(parsed.principalMaterial[0]?.runtimes, [
    { runtime: "php", series: "8.4" },
    { runtime: "node", series: "24" },
  ]);
});

test("parseCommandPayload rejects a malformed runtime entitlement", () => {
  // Rejected rather than dropped: the daemon reconciles group membership from
  // exactly this list, so silently discarding it would REVOKE every
  // entitlement the principal should have held.
  for (
    const bad of [
      [{ runtime: "php" }],
      [{ runtime: "php", series: "8.4.1" }],
      [{ runtime: "php", series: "latest" }],
      "php",
    ]
  ) {
    assertThrows(
      () =>
        parseCommandPayload(
          "environment.deploy" as CommandType,
          deployPayloadWithPrincipal(bad),
        ),
      Error,
      "Invalid environment.deploy payload",
    );
  }
});

test("parseCommandPayload accepts principalMaterial with and without uid/gid", () => {
  assertEquals(
    parseCommandPayload("environment.deploy" as CommandType, {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
      hostings: [],
      principalMaterial: [
        {
          principalId: "00000000-0000-4000-8000-000000000001",
          username: "appuser",
          home: "/srv/users/appuser",
          shell: "/usr/sbin/nologin",
        },
        {
          principalId: "00000000-0000-4000-8000-000000000002",
          username: "webuser",
          uid: 10001,
          gid: 10001,
          home: "/srv/users/webuser",
        },
      ],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
      hostings: [],
      principalMaterial: [
        {
          principalId: "00000000-0000-4000-8000-000000000001",
          username: "appuser",
          home: "/srv/users/appuser",
          shell: "/usr/sbin/nologin",
        },
        {
          principalId: "00000000-0000-4000-8000-000000000002",
          username: "webuser",
          uid: 10001,
          gid: 10001,
          home: "/srv/users/webuser",
        },
      ],
    },
  );
});

test("parseCommandPayload round-trips a principal password hash and rejects junk", () => {
  const passwordHash = `$6$rounds=100000$saltstring$${"a".repeat(86)}`;
  const base = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
    hostings: [],
  };
  const parsed = parseCommandPayload("environment.deploy" as CommandType, {
    ...base,
    principalMaterial: [{
      principalId: "00000000-0000-4000-8000-000000000001",
      username: "appuser",
      passwordHash,
    }],
  }) as { principalMaterial: { passwordHash?: string }[] };
  assertEquals(parsed.principalMaterial[0]?.passwordHash, passwordHash);

  // Reject-don't-drop, same rule as sshKeys: only a well-formed sha512-crypt
  // hash may head toward a host's /etc/shadow.
  for (
    const bad of ["hunter2", `$6$saltstring$${"a".repeat(86)}:x`, 42]
  ) {
    assertThrows(() =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...base,
        principalMaterial: [{
          principalId: "00000000-0000-4000-8000-000000000001",
          username: "appuser",
          passwordHash: bad,
        }],
      })
    );
  }
});

test("parseCommandPayload rejects negative or non-integer principal ids", () => {
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo",
        composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
        hostings: [],
        principalMaterial: [
          {
            principalId: "00000000-0000-4000-8000-000000000001",
            username: "appuser",
            uid: -1,
            gid: 10001,
          },
        ],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo",
        composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
        hostings: [],
        sites: [
          {
            composeServiceName: "web",
            engine: "nginx",
            root: "public",
            listenPort: 18080,
            principal: {
              principalId: "00000000-0000-4000-8000-000000000099",
              username: "site_user",
              uid: 1.5,
              gid: 10001,
            },
          },
        ],
      }),
    Error,
    "Invalid sites.principal entry",
  );
});

test("parseCommandPayload rejects overlong, unsafe, or empty principal material fields", () => {
  const baseDeploy = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
    hostings: [] as unknown[],
  };
  const overlongUsername = `u${"x".repeat(32)}`; // 33 chars
  assertEquals(overlongUsername.length, 33);

  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...baseDeploy,
        principalMaterial: [
          {
            principalId: "00000000-0000-4000-8000-000000000001",
            username: overlongUsername,
          },
        ],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...baseDeploy,
        principalMaterial: [
          {
            principalId: "00000000-0000-4000-8000-000000000001",
            username: "bad user",
          },
        ],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...baseDeploy,
        principalMaterial: [
          {
            principalId: "",
            username: "appuser",
          },
        ],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  for (
    const home of [
      "relative/path",
      "/tmp/../etc/passwd",
      "/home/with space",
      "/bad\0path",
    ]
  ) {
    assertThrows(
      () =>
        parseCommandPayload("environment.deploy" as CommandType, {
          ...baseDeploy,
          principalMaterial: [
            {
              principalId: "00000000-0000-4000-8000-000000000001",
              username: "appuser",
              home,
            },
          ],
        }),
      Error,
      "Invalid environment.deploy payload",
    );
  }

  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...baseDeploy,
        sites: [
          {
            composeServiceName: "web",
            engine: "nginx",
            root: "public",
            listenPort: 18080,
            principal: {
              principalId: "00000000-0000-4000-8000-000000000099",
              username: overlongUsername,
            },
          },
        ],
      }),
    Error,
    "Invalid sites.principal entry",
  );
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...baseDeploy,
        sites: [
          {
            composeServiceName: "web",
            engine: "nginx",
            root: "public",
            listenPort: 18080,
            principal: {
              principalId: "00000000-0000-4000-8000-000000000099",
              username: "bad;user",
            },
          },
        ],
      }),
    Error,
    "Invalid sites.principal entry",
  );
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        ...baseDeploy,
        sites: [
          {
            composeServiceName: "web",
            engine: "nginx",
            root: "public",
            listenPort: 18080,
            principal: {
              principalId: "",
              username: "site_user",
            },
          },
        ],
      }),
    Error,
    "Invalid sites.principal entry",
  );
});

test("parseCommandPayload accepts fabricNetworks with subnet mtu and gateway", () => {
  assertEquals(
    parseEnvironmentDeployPayload({
      ...BASE_ENVIRONMENT_DEPLOY,
      fabricNetworks: [
        {
          name: "tpn_net1",
          subnet: "203.0.113.0/24",
          mtu: 1420,
          gateway: "203.0.113.1",
        },
      ],
    }).fabricNetworks,
    [
      {
        name: "tpn_net1",
        subnet: "203.0.113.0/24",
        mtu: 1420,
        gateway: "203.0.113.1",
      },
    ],
  );
});

test("parseCommandPayload rejects invalid fabricNetworks name", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{ name: "-bad", subnet: "203.0.113.0/24" }],
      }),
    Error,
    "Invalid fabricNetworks name",
  );
});

test("parseCommandPayload rejects invalid fabricNetworks CIDR", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{ name: "tpn_net1", subnet: "203.0.113.0/99" }],
      }),
    Error,
    "Invalid fabricNetworks subnet",
  );
});

test("parseCommandPayload rejects fabricNetworks MTU out of range", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{
          name: "tpn_net1",
          subnet: "203.0.113.0/24",
          mtu: 1279,
        }],
      }),
    Error,
    "Invalid fabricNetworks mtu",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        fabricNetworks: [{
          name: "tpn_net1",
          subnet: "203.0.113.0/24",
          mtu: 9001,
        }],
      }),
    Error,
    "Invalid fabricNetworks mtu",
  );
});

test("parseCommandPayload rejects invalid dockerExternalNetworks names", () => {
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo",
        composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
        hostings: [],
        dockerExternalNetworks: ["-bad"],
      }),
    Error,
    "Invalid dockerExternalNetworks entry",
  );
});

test("parseCommandPayload accepts and dedupes managedNetworkServices", () => {
  const parsed = parseCommandPayload("environment.deploy" as CommandType, {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services:\\n  app:\\n    image: node:22\\n" }],
    hostings: [],
    managedNetworkServices: ["app", "app"],
    managedNetwork: MANAGED_NETWORK,
  }) as { managedNetworkServices?: string[]; managedNetwork?: string };
  assertEquals(parsed.managedNetworkServices, ["app"]);
  assertEquals(parsed.managedNetwork, MANAGED_NETWORK);
});

test("parseEnvironmentDeployPayload pairs managedNetwork with its services", () => {
  // Nothing joins the network — carrying a name for it would be dead weight
  // the daemon could act on, so it is rejected rather than dropped.
  assertEquals(
    (parseEnvironmentDeployPayload(BASE_ENVIRONMENT_DEPLOY) as {
      managedNetwork?: string;
    }).managedNetwork,
    undefined,
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        managedNetwork: MANAGED_NETWORK,
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        managedNetworkServices: ["app"],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        managedNetworkServices: ["app"],
        managedNetwork: "not a docker name",
      }),
    Error,
    "Invalid environment.deploy payload",
  );
});

test("parseManagedApplyPayload rejects a non-Docker managedNetwork", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        managedNetwork: "not a docker name",
      }),
    Error,
    "Invalid managed.apply payload",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        managedNetwork: undefined,
      }),
    Error,
    "Invalid managed.apply payload",
  );
});

test("parseManagedIngressReconcilePayload rejects a non-Docker managedNetwork", () => {
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        managedNetwork: "not a docker name",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile payload",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        managedNetwork: undefined,
      }),
    TypeError,
    "Invalid managed.ingress.reconcile payload",
  );
});

test("parseCommandPayload rejects invalid managedNetworkServices entries", () => {
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo",
        composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
        hostings: [],
        managedNetworkServices: [123],
      }),
    Error,
    "Invalid managedNetworkServices entry",
  );
  // Compose service keys never contain spaces — kept explicit so the daemon
  // contracts parser (`parseManagedNetworkServiceName`) cannot drift wider.
  assertThrows(
    () =>
      parseCommandPayload("environment.deploy" as CommandType, {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo",
        composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
        hostings: [],
        managedNetworkServices: ["bad name"],
        managedNetwork: MANAGED_NETWORK,
      }),
    Error,
    "Invalid managedNetworkServices entry",
  );
});

const WG_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAEMON_PSK = "tpdaemon.v1.server.key.payload";

test("parseFabricReconcilePayload skips extra fields when disabled", () => {
  assertEquals(
    parseFabricReconcilePayload({ enabled: false, address: "not-a-cidr" }),
    { enabled: false },
  );
});

test("parseFabricReconcilePayload accepts enabled mesh material", () => {
  const payload = parseFabricReconcilePayload({
    enabled: true,
    fabricId: "550e8400-e29b-41d4-a716-446655440000",
    address: "10.250.0.11/32",
    prefix: "10.192.0.0/16",
    peers: [
      {
        publicKey: WG_PUBKEY,
        allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"],
        endpoint: "203.0.113.1:51820",
        keepalive: 25,
        presharedKeyEnvelope: DAEMON_PSK,
        pathKind: "gateway",
        viaServerId: "550e8400-e29b-41d4-a716-446655440001",
      },
    ],
    mtu: 1420,
    gateway: true,
    networks: [
      {
        name: "tpn_550e8400-e29b-41d4-a716-446655440000",
        subnet: "10.192.11.0/24",
        mtu: 1420,
        gateway: "10.192.11.1",
      },
    ],
  });
  assertEquals(payload.enabled, true);
  if (!payload.enabled) {
    throw new TypeError("expected enabled fabric payload");
  }
  assertEquals(payload.mtu, 1420);
  assertEquals(payload.peers[0]?.keepalive, 25);
  assertEquals(payload.peers[0]?.presharedKeyEnvelope, DAEMON_PSK);
  assertEquals(payload.peers[0]?.pathKind, "gateway");
  assertEquals(
    payload.peers[0]?.viaServerId,
    "550e8400-e29b-41d4-a716-446655440001",
  );
  assertEquals(payload.gateway, true);
  assertEquals(payload.networks?.[0]?.gateway, "10.192.11.1");
  assertEquals(payload.address, "10.250.0.11/32");
  assertEquals(
    parseCommandPayload("server.fabric.reconcile", { enabled: false }),
    { enabled: false },
  );
  assertEquals(
    parseCommandResult("server.fabric.reconcile", {
      summary: "TurboFabric disabled",
      skipped: true,
    }),
    { summary: "TurboFabric disabled", skipped: true },
  );
  assertEquals(
    parseCommandResult("server.fabric.reconcile", {
      summary: "TurboFabric torn down",
    }),
    { summary: "TurboFabric torn down" },
  );
});

test("parseFabricReconcileResult accepts skipped, reconciled, and teardown shapes", () => {
  assertEquals(
    parseFabricReconcileResult({
      summary: "TurboFabric disabled",
      skipped: true,
    }),
    { summary: "TurboFabric disabled", skipped: true },
  );
  assertEquals(
    parseFabricReconcileResult({
      summary: "TurboFabric reconciled",
      publicKey: WG_PUBKEY,
      peers: [
        {
          publicKey: WG_PUBKEY,
          lastHandshakeAt: "2020-01-01T00:00:00.000Z",
          transferRx: 10,
          transferTx: 20,
          endpoint: "203.0.113.50:48172",
          health: "healthy",
        },
      ],
    }).peers?.[0]?.transferRx,
    10,
  );
  assertEquals(
    parseFabricReconcileResult({ summary: "TurboFabric torn down" }),
    { summary: "TurboFabric torn down" },
  );
});

test("encodeCommandEnvelope round-trips through parseCommandEnvelope", () => {
  const envelope = {
    commandId: "cmd-1",
    serverId: "srv-1",
    type: "daemon.ping" as CommandType,
    attempt: 1,
    queuedAt: "2020-01-01T00:00:00.000Z",
    correlationId: "corr-1",
  };
  assertEquals(parseCommandEnvelope(encodeCommandEnvelope(envelope)), envelope);
  assertEquals(parseCommandEnvelope(envelope), envelope);
});

test("parseCommandEnvelope rejects invalid envelopes", () => {
  assertThrows(
    () => parseCommandEnvelope("not-json"),
    Error,
    "Invalid command envelope",
  );
  assertThrows(
    () => parseCommandEnvelope(null),
    Error,
    "Invalid command envelope",
  );
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: "",
        serverId: "s",
        type: "daemon.ping",
        attempt: 1,
        queuedAt: "t",
      }),
    Error,
    "Invalid command envelope",
  );
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: "c",
        serverId: "s",
        type: "unknown",
        attempt: 1,
        queuedAt: "t",
      }),
    Error,
    "Invalid command envelope",
  );
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: "c",
        serverId: "s",
        type: "daemon.ping",
        attempt: 0,
        queuedAt: "t",
      }),
    Error,
    "Invalid command envelope",
  );
  assertThrows(
    () =>
      parseCommandEnvelope({
        commandId: "c",
        serverId: "s",
        type: "daemon.ping",
        attempt: 1.5,
        queuedAt: "t",
      }),
    Error,
    "Invalid command envelope",
  );
});

test("parseCommandEnvelope omits empty correlationId", () => {
  const envelope = parseCommandEnvelope({
    commandId: "c",
    serverId: "s",
    type: "daemon.ping",
    attempt: 1,
    queuedAt: "t",
    correlationId: "",
  });
  assertEquals(envelope.correlationId, undefined);
});

test("isValidNtpServer accepts hostnames and literals", () => {
  assertEquals(isValidNtpServer("time.example.com"), true);
  assertEquals(isValidNtpServer("203.0.113.10"), true);
  assertEquals(isValidNtpServer(""), false);
  assertEquals(isValidNtpServer("bad;host"), false);
});

test("isSystemComponentKey accepts only system component keys", () => {
  assertEquals(isSystemComponentKey("hosting-ingress"), true);
  assertEquals(isSystemComponentKey("managed-ingress"), true);
  assertEquals(isSystemComponentKey("database"), true);
  assertEquals(isSystemComponentKey("not-a-component"), false);
});

const VALID_MANAGED_INGRESS_RECONCILE = {
  serverId: "00000000-0000-4000-8000-0000000000ab",
  managedNetwork: MANAGED_NETWORK,
  bindAddresses: ["203.0.113.10"],
  orgTlsMaterial: {
    certificatePem:
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    privateKeyEnvelope: "tpdaemon.v1.server.key.payload",
    caCertPem:
      "-----BEGIN CERTIFICATE-----\nMIICaaaa\n-----END CERTIFICATE-----\n",
  },
  clusters: [
    {
      managedId: "00000000-0000-4000-8000-000000000001",
      engine: "postgres",
      protocolPort: 5432,
      family: "pgsql",
      writerHostgroup: 0,
      readerHostgroup: 1,
      backends: [
        {
          memberId: "00000000-0000-4000-8000-0000000000aa",
          role: "primary",
          readEligible: true,
          address: "203.0.113.20",
          port: 5432,
          transport: "local",
        },
      ],
      users: [
        {
          username: "app",
          role: "user",
          password: "tpdaemon.v1.server.key.payload",
          defaultDatabase: "app",
        },
      ],
    },
  ],
} as const;

test("parseManagedIngressReconcilePayload accepts a valid fixture", () => {
  const payload = parseManagedIngressReconcilePayload(
    VALID_MANAGED_INGRESS_RECONCILE,
  );
  assertEquals(payload.serverId, VALID_MANAGED_INGRESS_RECONCILE.serverId);
  assertEquals(payload.managedNetwork, MANAGED_NETWORK);
  assertEquals(payload.bindAddresses, ["203.0.113.10"]);
  assertEquals(payload.clusters.length, 1);
  assertEquals(payload.clusters[0]?.protocolPort, 5432);
  assertEquals(
    parseCommandPayload(
      "managed.ingress.reconcile" as CommandType,
      VALID_MANAGED_INGRESS_RECONCILE,
    ),
    payload,
  );
});

test("parseManagedIngressReconcilePayload admits fabric backends and sorted segments", () => {
  const netId = "00000000-0000-4000-8000-0000000000cc";
  const payload = parseManagedIngressReconcilePayload({
    ...VALID_MANAGED_INGRESS_RECONCILE,
    clusters: [
      {
        ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
        backends: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0]!.backends[0],
            transport: "fabric",
          },
        ],
      },
    ],
    segments: [
      { name: `tpn_${netId}`, subnet: "203.0.113.0/24" },
      { name: `tpn_${netId}`, subnet: "203.0.113.0/24" },
    ],
  });
  assertEquals(payload.clusters[0]?.backends[0]?.transport, "fabric");
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [
        {
          ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
          backends: [
            {
              ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0]!.backends[0],
              transport: "public",
            },
          ],
        },
      ],
    }).clusters[0]?.backends[0]?.transport,
    "public",
  );
  assertEquals(payload.segments, [
    { name: `tpn_${netId}`, subnet: "203.0.113.0/24" },
  ]);
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
                transport: "vpn",
              },
            ],
          },
        ],
      }),
    TypeError,
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        segments: [{ name: "not-tpn", subnet: "203.0.113.0/24" }],
      }),
    TypeError,
  );
});

test("parseManagedIngressReconcilePayload rejects incomplete or hostile input", () => {
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        serverId: "not-a-uuid",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile payload",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        orgTlsMaterial: {
          certificatePem: "x",
          privateKeyEnvelope: "y",
        },
      }),
    Error,
    "Invalid managed.apply orgTlsMaterial",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
            protocolPort: 6032,
          },
        ],
      }),
    TypeError,
  );
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [
        {
          ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
          protocolPort: 15432,
        },
      ],
    }).clusters[0]?.protocolPort,
    15432,
  );
  // Teardown still names the network — the field is unconditional on the wire.
  const teardown = parseManagedIngressReconcilePayload({
    serverId: VALID_MANAGED_INGRESS_RECONCILE.serverId,
    managedNetwork: MANAGED_NETWORK,
    clusters: [],
  });
  assertEquals(teardown.clusters, []);
  assertEquals(teardown.managedNetwork, MANAGED_NETWORK);
  assertEquals(teardown.orgTlsMaterial, undefined);
  assertEquals(teardown.identity, undefined);
});

test("parseManagedIngressReconcilePayload round-trips ProxySQL identity", () => {
  const serviceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const payload = parseManagedIngressReconcilePayload({
    ...VALID_MANAGED_INGRESS_RECONCILE,
    identity: {
      serviceId,
      composeServiceName: "proxysql",
      containerName: `${serviceId}-in`,
    },
  });
  assertEquals(payload.identity?.containerName, `${serviceId}-in`);
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        identity: {
          serviceId,
          composeServiceName: "proxysql",
          containerName: serviceId,
        },
      }),
    TypeError,
    "Invalid managed.ingress.reconcile identity",
  );
});

test("parseManagedIngressReconcileResult accepts applied counts and containers", () => {
  assertEquals(
    parseManagedIngressReconcileResult({
      summary: "ok",
      appliedUsers: ["app"],
      appliedBackends: ["00000000-0000-4000-8000-0000000000aa"],
      restarted: false,
    }),
    {
      summary: "ok",
      appliedUsers: ["app"],
      appliedBackends: ["00000000-0000-4000-8000-0000000000aa"],
      restarted: false,
    },
  );
  assertEquals(
    parseCommandResult("managed.ingress.reconcile" as CommandType, {
      summary: "restarted",
      appliedUsers: [],
      appliedBackends: [],
      restarted: true,
    }),
    {
      summary: "restarted",
      appliedUsers: [],
      appliedBackends: [],
      restarted: true,
    },
  );
});

test("parseManagedApplyResult projects host, port, and containers", () => {
  assertEquals(
    parseManagedApplyResult({
      host: "127.0.0.1",
      port: 5432,
      containers: [
        {
          composeServiceName: "postgres",
          containerId: "abc",
          containerName: "proj-postgres-1",
          status: "running",
          role: "service",
        },
      ],
    }),
    {
      host: "127.0.0.1",
      port: 5432,
      containers: [
        {
          composeServiceName: "postgres",
          containerId: "abc",
          containerName: "proj-postgres-1",
          status: "running",
          role: "service",
        },
      ],
    },
  );
  assertEquals(parseManagedApplyResult({}), { host: "", port: 0 });
});

const BASE_ENVIRONMENT_DEPLOY = {
  environmentId: "env-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "tp-demo",
  composeFiles: [{ filename: "compose.yaml", role: "runtime" as const, content: "services: {}\\n" }],
  hostings: [] as unknown[],
};

const INGRESS_SERVICE_ID = "00000000-0000-4000-8000-000000000099";

test("isValidNtpServer accepts IPv6 literals and rejects invalid shapes", () => {
  assertEquals(isValidNtpServer("2001:db8::1"), true);
  assertEquals(isValidNtpServer("::1"), true);
  assertEquals(isValidNtpServer("203.0.113.256"), false);
  assertEquals(isValidNtpServer("time.example.com "), false);
  assertEquals(isValidNtpServer("a".repeat(254)), false);
  assertEquals(isValidNtpServer(123), false);
});

test("parseTimezoneSetPayload rejects non-object payloads", () => {
  assertThrows(
    () => parseTimezoneSetPayload(null),
    Error,
    "Invalid timezone set payload",
  );
});

test("parseTimezoneSetResult rejects missing timezone", () => {
  assertThrows(
    () => parseTimezoneSetResult({}),
    Error,
    "Invalid timezone set result",
  );
  assertThrows(
    () => parseTimezoneSetResult(null),
    Error,
    "Invalid timezone set result",
  );
});

test("parseNtpSetPayload rejects non-boolean enabled", () => {
  assertThrows(
    () => parseNtpSetPayload({ enabled: "yes" }),
    TypeError,
    "enabled must be a boolean",
  );
});

test("parseNtpSetResult keeps optional summary", () => {
  assertEquals(
    parseNtpSetResult({ ntpServers: [], summary: "applied" }),
    { ntpServers: [], summary: "applied" },
  );
});

test("parsePingResult keeps lifecycle hop timestamps", () => {
  assertEquals(
    parsePingResult({
      apiAcceptedAt: "2020-01-01T00:00:00.000Z",
      queuedAt: "2020-01-01T00:00:01.000Z",
      consumerReceivedAt: "2020-01-01T00:00:02.000Z",
      cellEnqueuedAt: "2020-01-01T00:00:03.000Z",
      cellDispatchedAt: "2020-01-01T00:00:04.000Z",
      daemonReceivedAt: "2020-01-01T00:00:05.000Z",
      daemonRespondedAt: "2020-01-01T00:00:06.000Z",
      resultRecordedAt: "2020-01-01T00:00:07.000Z",
    }),
    {
      apiAcceptedAt: "2020-01-01T00:00:00.000Z",
      queuedAt: "2020-01-01T00:00:01.000Z",
      consumerReceivedAt: "2020-01-01T00:00:02.000Z",
      cellEnqueuedAt: "2020-01-01T00:00:03.000Z",
      cellDispatchedAt: "2020-01-01T00:00:04.000Z",
      daemonReceivedAt: "2020-01-01T00:00:05.000Z",
      daemonRespondedAt: "2020-01-01T00:00:06.000Z",
      resultRecordedAt: "2020-01-01T00:00:07.000Z",
    },
  );
});

test("parseEnvironmentDeployPayload parses rich hostings and optional material", () => {
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    // Required whenever hostings are present — the `hosting-ingress` system
    // component's allocated serviceId, not a readable literal.
    hostingIngressNetwork: '00000000-0000-4000-8000-0000000000bb',
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        pathPrefix: "/api",
        targetPort: 8080,
        tlsId: null,
        bindAddress: "203.0.113.10",
        proxy: { forceHttps: true, gzip: true, stripPrefix: "/api" },
        web: { env: { APP_ENV: "prod", ignored: 1 }, php: { version: "8.4" } },
      },
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "db",
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
      },
    ],
    tlsMaterial: [{
      tlsId: "tls-1",
      certificatePem: "CERT",
      privateKeyEnvelope: "enc:key",
    }],
    variableMaterial: [{
      key: "FOO",
      valueEnvelope: "enc:val",
      forBuild: true,
      isLiteral: true,
    }],
    envFile: "web__PORT=3000\n",
    secretPlan: [{
      key: "TOKEN",
      composeServiceName: "web",
      source: "web_token",
      target: "TOKEN",
      relativePath: "web--TOKEN",
      forBuild: false,
      forRuntime: true,
    }],
    storageMaterial: [{
      storageId: "st1",
      locationId: "loc1",
      kind: "volume",
      name: "data",
      provider: "docker",
      serverId: "srv1",
      volumeName: "01936b3e-8c7a-7b2d-a1f0-123456789abc",
      mounts: [],
    }],
    serviceHooks: [{
      composeServiceName: "web",
      preDeployCommand: "/bin/true",
      buildDisableCache: true,
    }],
    ingressServices: [{
      serviceId: INGRESS_SERVICE_ID,
      composeServiceName: "db",
      containerName: `${INGRESS_SERVICE_ID}-in`,
    }],
  });
  assertEquals(result.hostings[0]?.pathPrefix, "/api");
  assertEquals(result.hostings[0]?.tlsId, null);
  assertEquals(result.hostings[0]?.bindAddress, "203.0.113.10");
  assertEquals(result.hostings[0]?.proxy, {
    forceHttps: true,
    gzip: true,
    stripPrefix: "/api",
  });
  assertEquals(result.hostings[0]?.web, {
    env: { APP_ENV: "prod" },
    php: { version: "8.4" },
  });
  assertEquals(result.hostings[1]?.protocol, "tcp");
  assertEquals(result.hostings[1]?.ports, [{ published: 5432, target: 5432 }]);
  assertEquals(result.tlsMaterial?.length, 1);
  assertEquals(result.variableMaterial?.[0]?.forBuild, true);
  assertEquals(result.envFile, "web__PORT=3000\n");
  assertEquals(result.secretPlan?.[0]?.relativePath, "web--TOKEN");
  assertEquals(
    result.storageMaterial?.[0]?.volumeName,
    "01936b3e-8c7a-7b2d-a1f0-123456789abc",
  );
  assertEquals(result.serviceHooks?.[0]?.preDeployCommand, "/bin/true");
  assertEquals(
    result.ingressServices?.[0]?.containerName,
    `${INGRESS_SERVICE_ID}-in`,
  );
});

test("parseEnvironmentDeployPayload parses hostingIngress for shared HTTP Traefik", () => {
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    hostingIngress: {
      serviceId: INGRESS_SERVICE_ID,
      composeServiceName: "traefik",
      containerName: `${INGRESS_SERVICE_ID}-in`,
    },
  });
  assertEquals(result.hostingIngress, {
    serviceId: INGRESS_SERVICE_ID,
    composeServiceName: "traefik",
    containerName: `${INGRESS_SERVICE_ID}-in`,
  });
});

test("parseEnvironmentDeployPayload rejects hostingIngress that is not traefik", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostingIngress: {
          serviceId: INGRESS_SERVICE_ID,
          composeServiceName: "web",
          containerName: `${INGRESS_SERVICE_ID}-in`,
        },
      }),
    Error,
    "Invalid environment.deploy hostingIngress",
  );
});

test("parseEnvironmentDeployPayload ties hostingIngressNetwork to the hostingIngress serviceId", () => {
  const hosting = {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.com"],
  };
  const hostingIngress = {
    serviceId: INGRESS_SERVICE_ID,
    composeServiceName: "traefik",
    containerName: `${INGRESS_SERVICE_ID}-in`,
  };
  // The shared hosting-ingress network *is* the component's compose project,
  // so both must be the same allocated serviceId.
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    hostings: [hosting],
    hostingIngress,
    hostingIngressNetwork: INGRESS_SERVICE_ID,
  });
  assertEquals(result.hostingIngressNetwork, INGRESS_SERVICE_ID);

  // A skewed payload would persist one identity and deploy the network /
  // compose project under another.
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [hosting],
        hostingIngress,
        hostingIngressNetwork: "00000000-0000-4000-8000-0000000000bb",
      }),
    Error,
    "Invalid environment.deploy payload",
  );
});

test("parseEnvironmentDeployPayload rejects a Compose-invalid hostingIngressNetwork", () => {
  const hosting = {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.com"],
  };
  // Accepted by the Docker resource rule but rejected by the daemon's Compose
  // `name:` guard (uppercase, `.`, leading `-`, empty, over 64 chars) — reject
  // here so the deploy never dies at render time instead.
  for (
    const network of [
      "Ingress-Net",
      "ingress.net",
      "-ingress",
      "",
      "a".repeat(65),
      42,
    ]
  ) {
    assertThrows(
      () =>
        parseEnvironmentDeployPayload({
          ...BASE_ENVIRONMENT_DEPLOY,
          hostings: [hosting],
          hostingIngressNetwork: network,
        }),
      TypeError,
      "Invalid environment.deploy payload",
    );
  }
  // The bare allocated UUID stays valid under both rules.
  assertEquals(
    parseEnvironmentDeployPayload({
      ...BASE_ENVIRONMENT_DEPLOY,
      hostings: [hosting],
      hostingIngressNetwork: INGRESS_SERVICE_ID,
    }).hostingIngressNetwork,
    INGRESS_SERVICE_ID,
  );
});

test("parseEnvironmentDeployPayload round-trips runtime composeFiles", () => {
  const composeFiles = [{
    filename: "compose.yaml",
    role: "runtime" as const,
    content: "services:\n  web:\n    image: nginx\n",
  }];
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    composeFiles,
  });
  assertEquals(result.composeFiles, composeFiles);
});

test("parseEnvironmentDeployPayload rejects missing composeFiles", () => {
  assertThrows(
    () => parseEnvironmentDeployPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      hostings: [],
    }),
    Error,
    "Invalid environment.deploy payload",
  );
});

test("parseEnvironmentDeployPayload parses repository source with valid path", () => {
  const result = parseEnvironmentDeployPayload({
    ...BASE_ENVIRONMENT_DEPLOY,
    composeFiles: [
      {
        filename: "compose.yaml",
        role: "runtime" as const,
        source: "repository" as const,
        path: "deploy/compose.yaml",
        content: "services:\n  web:\n    image: nginx\n",
      },
    ],
  });
  assertEquals(result.composeFiles[0]?.source, "repository");
  assertEquals(result.composeFiles[0]?.path, "deploy/compose.yaml");
});

test("parseDeployComposeFiles rejects a path with traversal or a leading slash", () => {
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: "docker-compose.yml",
          role: "project",
          source: "repository",
          path: "../evil/docker-compose.yml",
          content: "a",
        },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: "docker-compose.yml",
          role: "project",
          source: "repository",
          path: "/etc/docker-compose.yml",
          content: "a",
        },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: "docker-compose.yml",
          role: "project",
          source: "repository",
          path: "",
          content: "a",
        },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
});

test("parseDeployComposeFiles rejects invalid entries", () => {
  assertThrows(
    () => parseDeployComposeFiles([]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "../evil.yml", role: "project", content: "x" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "nested/file.yml", role: "project", content: "x" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "compose.txt", role: "project", content: "x" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "docker-compose.yml", role: "project", content: "a" },
        { filename: "docker-compose.yml", role: "environment", content: "b" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "docker-compose.yml", role: "unknown", content: "a" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: "docker-compose.yml",
          role: "project",
          source: "git",
          content: "a",
        },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "docker-compose.yml", role: "project", content: "" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        {
          filename: "docker-compose.turbopanel.yml",
          role: "platform",
          content: "p",
        },
        { filename: "docker-compose.yml", role: "project", content: "a" },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseDeployComposeFiles([
        { filename: "docker-compose.yml", role: "project", content: "a" },
        {
          filename: "docker-compose.platform.yml",
          role: "platform",
          content: "p1",
        },
        {
          filename: "docker-compose.turbopanel.yml",
          role: "platform",
          content: "p2",
        },
      ]),
    Error,
    "Invalid environment.deploy payload",
  );
});

test("parseEnvironmentDeployPayload rejects invalid hosting protocol and bindAddress", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [{
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: [],
          protocol: "ftp",
        }],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [{
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["app.example.com"],
          bindAddress: "not-an-ip",
        }],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...BASE_ENVIRONMENT_DEPLOY,
        hostings: [{
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: [],
          protocol: "tcp",
          ports: [{ published: 0, target: 5432 }],
        }],
      }),
    Error,
    "Invalid environment.deploy payload",
  );
});

test("parseEnvironmentDeployResult keeps services list", () => {
  assertEquals(
    parseEnvironmentDeployResult({
      projectName: "tp-demo",
      services: ["web", "api"],
    }),
    { projectName: "tp-demo", services: ["web", "api"] },
  );
});

test("parseEnvironmentStopPayload accepts and validates ingressServices", () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      ingressServices: [{ serviceId: INGRESS_SERVICE_ID }],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      ingressServices: [{ serviceId: INGRESS_SERVICE_ID }],
    },
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        ingressServices: [{ serviceId: "not-a-uuid" }],
      }),
    Error,
    "Invalid environment.stop ingressServices entry",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        ingressServices: "bad",
      }),
    TypeError,
    "ingressServices must be an array",
  );
});

test("parseEnvironmentStopPayload round-trips siteReleases and rejects unsafe segments", () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      siteReleases: [{ serviceId: "svc-1", username: "appuser" }],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      siteReleases: [{ serviceId: "svc-1", username: "appuser" }],
    },
  );
  // Both fields become path segments on the host; neither may traverse.
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        siteReleases: [{ serviceId: "../etc", username: "appuser" }],
      }),
    Error,
    "Invalid environment.stop siteReleases entry",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        siteReleases: "svc-1",
      }),
    TypeError,
    "siteReleases must be an array",
  );
});

test("parseEnvironmentStopPayload round-trips tpn_ fabricNetworks and rejects other names", () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      fabricNetworks: ["tpn_net1"],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      fabricNetworks: ["tpn_net1"],
    },
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        fabricNetworks: ["bridge_net1"],
      }),
    Error,
    "Invalid environment.stop fabricNetworks name",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        fabricNetworks: "tpn_net1",
      }),
    TypeError,
    "fabricNetworks must be an array",
  );
});

test("parseEnvironmentStopResult round-trips summary and containers", () => {
  assertEquals(
    parseEnvironmentStopResult({
      projectName: "tp-demo",
      summary: "stopped",
      containers: [],
    }),
    { projectName: "tp-demo", summary: "stopped", containers: [] },
  );
  assertEquals(parseEnvironmentStopResult(null), { projectName: "" });
});

const NATIVE_APP_BASE = {
  environmentId: "env-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "tp-demo",
  composeFiles: [{
    filename: "compose.yaml",
    role: "runtime" as const,
    content: "services: {}\n",
  }],
  hostings: [],
};

test("parseEnvironmentDeployPayload round-trips nativeAppServices", () => {
  const parsed = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    nativeAppServices: [
      {
        composeServiceName: "web",
        serviceId: "svc-web",
        listenPort: 18100,
        framework: "next",
        nodeVersion: "24.17.0",
        resources: { cpus: 1.5, memoryBytes: 536870912 },
        accountLimits: { cpus: 4, memoryBytes: 2147483648, tasksMax: 512 },
      },
    ],
  });
  assertEquals(parsed.nativeAppServices, [
    {
      composeServiceName: "web",
      serviceId: "svc-web",
      listenPort: 18100,
      framework: "next",
      nodeVersion: "24.17.0",
      resources: { cpus: 1.5, memoryBytes: 536870912 },
      accountLimits: { cpus: 4, memoryBytes: 2147483648, tasksMax: 512 },
    },
  ]);
});

test("parseEnvironmentDeployPayload rejects an unsafe nativeAppServices serviceId", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...NATIVE_APP_BASE,
        nativeAppServices: [
          {
            composeServiceName: "web",
            // A path separator here would escape the release tree when the
            // daemon joins it into the unit's WorkingDirectory.
            serviceId: "../../etc",
            listenPort: 18100,
            framework: "auto",
          },
        ],
      }),
    Error,
    "Invalid nativeAppServices entry",
  );
});

test("parseEnvironmentDeployPayload rejects an unknown nativeAppServices framework", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...NATIVE_APP_BASE,
        nativeAppServices: [
          {
            composeServiceName: "web",
            serviceId: "svc-web",
            listenPort: 18100,
            framework: "deno",
          },
        ],
      }),
    Error,
    "Invalid nativeAppServices entry",
  );
});

test("sourceMaterial build round-trips startCommand", () => {
  const parsed = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    sourceMaterial: [
      {
        sourceId: "00000000-0000-4000-8000-000000000001",
        composeServiceName: "web",
        provider: "github",
        cloneUrl: "https://github.test/acme/app.git",
        ref: "main",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        releaseId: "rel-1",
        build: {
          kind: "native",
          installCommand: "pnpm install",
          buildCommand: "pnpm build",
          startCommand: "node server.js",
        },
      },
    ],
  });
  assertEquals(
    parsed.sourceMaterial?.[0]?.build.startCommand,
    "node server.js",
  );
});

const GITLAB_SOURCE_ENTRY = {
  sourceId: "00000000-0000-4000-8000-000000000001",
  composeServiceName: "web",
  provider: "gitlab",
  cloneUrl: "https://gitlab.test/acme/app.git",
  ref: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "rel-1",
  credential: "tpdaemon.sealed",
  credentialKind: "token",
  build: { kind: "native" },
} as const;

test("sourceMaterial carries the HTTPS credential username opaquely", () => {
  const parsed = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    sourceMaterial: [{ ...GITLAB_SOURCE_ENTRY, credentialUsername: "oauth2" }],
  });
  assertEquals(parsed.sourceMaterial?.[0]?.credentialUsername, "oauth2");

  // Absent stays absent — the host applies its own default rather than
  // receiving one the control plane never stated.
  const withoutUsername = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    sourceMaterial: [{ ...GITLAB_SOURCE_ENTRY }],
  });
  assertEquals(withoutUsername.sourceMaterial?.[0]?.credentialUsername, undefined);
});

test("sourceMaterial rejects a credentialUsername that could break the askpass script", () => {
  for (
    const bad of ["", "oauth2\nUsername", "oauth2\u0000", "x".repeat(201), 2]
  ) {
    assertThrows(
      () =>
        parseEnvironmentDeployPayload({
          ...NATIVE_APP_BASE,
          sourceMaterial: [{ ...GITLAB_SOURCE_ENTRY, credentialUsername: bad }],
        }),
      Error,
      "Invalid sourceMaterial credentialUsername",
    );
  }
});

test("sourceMaterial build round-trips packageManager and rejects unknown ones", () => {
  const parsed = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    sourceMaterial: [{
      ...GITLAB_SOURCE_ENTRY,
      build: { kind: "native", packageManager: "pnpm" },
    }],
  });
  assertEquals(parsed.sourceMaterial?.[0]?.build, {
    kind: "native",
    packageManager: "pnpm",
  });

  // Absent stays absent — lockfile auto-detection remains the host's call.
  const withoutManager = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    sourceMaterial: [{ ...GITLAB_SOURCE_ENTRY }],
  });
  assertEquals(
    withoutManager.sourceMaterial?.[0]?.build.packageManager,
    undefined,
  );

  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...NATIVE_APP_BASE,
        sourceMaterial: [{
          ...GITLAB_SOURCE_ENTRY,
          build: { kind: "native", packageManager: "bun" },
        }],
      }),
    Error,
    "Invalid sourceMaterial build packageManager",
  );
});

test("parseEnvironmentDeployPayload round-trips the node app settings", () => {
  const parsed = parseEnvironmentDeployPayload({
    ...NATIVE_APP_BASE,
    nativeAppServices: [
      {
        composeServiceName: "web",
        serviceId: "svc-web",
        listenPort: 18100,
        framework: "auto",
        appMode: "development",
        // `false` must survive the round-trip, never collapse to absent.
        enabled: false,
        startupFile: "apps/web/server.js",
      },
    ],
  });
  assertEquals(parsed.nativeAppServices, [
    {
      composeServiceName: "web",
      serviceId: "svc-web",
      listenPort: 18100,
      framework: "auto",
      appMode: "development",
      enabled: false,
      startupFile: "apps/web/server.js",
    },
  ]);
});

test("parseEnvironmentDeployPayload rejects bad node app settings", () => {
  const entry = {
    composeServiceName: "web",
    serviceId: "svc-web",
    listenPort: 18100,
    framework: "auto",
  };
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...NATIVE_APP_BASE,
        nativeAppServices: [{ ...entry, appMode: "staging" }],
      }),
    Error,
    "Invalid nativeAppServices appMode",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...NATIVE_APP_BASE,
        nativeAppServices: [{ ...entry, enabled: "yes" }],
      }),
    Error,
    "Invalid nativeAppServices enabled",
  );
  // It becomes part of an ExecStart line, so it keeps the relative-path rule.
  for (const bad of ["../x", "/abs"]) {
    assertThrows(
      () =>
        parseEnvironmentDeployPayload({
          ...NATIVE_APP_BASE,
          nativeAppServices: [{ ...entry, startupFile: bad }],
        }),
      Error,
      "Invalid nativeAppServices startupFile",
    );
  }
});

const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFZ";

function deployPayloadWithPrincipalFields(fields: Record<string, unknown>) {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}\n",
    }],
    hostings: [],
    principalMaterial: [{
      principalId: "00000000-0000-4000-8000-000000000001",
      username: "appuser",
      ...fields,
    }],
  };
}

test("parseCommandPayload round-trips access groups and ssh keys", () => {
  const parsed = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithPrincipalFields({
      accessGroups: ["tpshell"],
      sshKeys: [ED25519_KEY],
    }),
  ) as { principalMaterial: { accessGroups?: unknown; sshKeys?: unknown }[] };
  assertEquals(parsed.principalMaterial[0]?.accessGroups, ["tpshell"]);
  assertEquals(parsed.principalMaterial[0]?.sshKeys, [ED25519_KEY]);
});

test("parseCommandPayload keeps an empty access list distinct from an absent one", () => {
  // `[]` is a revocation and `undefined` means "say nothing". Collapsing the
  // two would make a steward-only edit silently strip an account's login.
  const empty = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithPrincipalFields({ accessGroups: [], sshKeys: [] }),
  ) as { principalMaterial: { accessGroups?: unknown; sshKeys?: unknown }[] };
  assertEquals(empty.principalMaterial[0]?.accessGroups, []);
  assertEquals(empty.principalMaterial[0]?.sshKeys, []);

  const absent = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithPrincipalFields({}),
  ) as { principalMaterial: { accessGroups?: unknown; sshKeys?: unknown }[] };
  assertEquals(absent.principalMaterial[0]?.accessGroups, undefined);
  assertEquals(absent.principalMaterial[0]?.sshKeys, undefined);
});

test("parseCommandPayload rejects anything structural in an ssh key", () => {
  // These lines all reach a file `sshd` authenticates against. A second line is
  // key injection; an options field is a directive the panel never wrote.
  for (
    const bad of [
      [`${ED25519_KEY} laptop`],
      [`command="/bin/sh" ${ED25519_KEY}`],
      [`${ED25519_KEY}\nssh-rsa AAAAB3Nz`],
      ["ssh-dss AAAAB3NzaC1kc3M="],
      [ED25519_KEY.replace("ssh-ed25519", "ssh-magic")],
      ED25519_KEY,
      [42],
    ]
  ) {
    assertThrows(
      () =>
        parseCommandPayload(
          "environment.deploy" as CommandType,
          deployPayloadWithPrincipalFields({ sshKeys: bad }),
        ),
      Error,
      "Invalid environment.deploy payload",
    );
  }
});

test("parseCommandPayload rejects a malformed access group list", () => {
  for (const bad of [["TPSHELL"], ["tp shell"], ["../root"], "tpshell", [7]]) {
    assertThrows(
      () =>
        parseCommandPayload(
          "environment.deploy" as CommandType,
          deployPayloadWithPrincipalFields({ accessGroups: bad }),
        ),
      Error,
      "Invalid environment.deploy payload",
    );
  }
});

test("server.principals.reconcile validates principals the same way a deploy does", () => {
  const parsed = parseCommandPayload("server.principals.reconcile", {
    principals: [{
      principalId: "00000000-0000-4000-8000-000000000001",
      username: "appuser",
      accessGroups: ["tpsftp"],
      sshKeys: [ED25519_KEY],
    }],
  }) as { principals: { username: string }[] };
  assertEquals(parsed.principals[0]?.username, "appuser");

  // One account named twice makes "the complete set" ambiguous about which key
  // list wins — and the whole safety of removal rests on that set.
  assertThrows(
    () =>
      parseCommandPayload("server.principals.reconcile", {
        principals: [
          { principalId: "a", username: "appuser" },
          { principalId: "b", username: "appuser" },
        ],
      }),
    Error,
    "more than once",
  );

  // An empty list is a real instruction (remove every key file); a missing one
  // is a malformed payload. The two must never be confused.
  assertEquals(
    (parseCommandPayload("server.principals.reconcile", { principals: [] }) as {
      principals: unknown[];
    }).principals,
    [],
  );
  assertThrows(
    () => parseCommandPayload("server.principals.reconcile", {}),
    Error,
    "principals must be an array",
  );
});

function deployPayloadWithSite(site: Record<string, unknown>) {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}\n",
    }],
    hostings: [],
    sites: [{
      composeServiceName: "blog",
      engine: "caddy",
      root: "public",
      listenPort: 18080,
      ...site,
    }],
  };
}

const SITE_PRINCIPAL = {
  principalId: "00000000-0000-4000-8000-000000000001",
  username: "appuser",
};

test("a site's sourceKind round-trips, and absent stays absent", () => {
  const managed = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithSite({
      sourceKind: "managed-directory",
      principal: SITE_PRINCIPAL,
    }),
  ) as { sites: { sourceKind?: unknown }[] };
  assertEquals(managed.sites[0]?.sourceKind, "managed-directory");

  // Absent means `release` on both sides, so emitting it explicitly would churn
  // the wire for every site that never opted in.
  const plain = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithSite({}),
  ) as { sites: { sourceKind?: unknown }[] };
  assertEquals(plain.sites[0]?.sourceKind, undefined);
});

test("a managed directory with no principal is refused", () => {
  // "A directory and a principal" needs both. Without an owner the daemon would
  // fall back to the unreachable daemon-owned tree, which looks like it worked.
  assertThrows(
    () =>
      parseCommandPayload(
        "environment.deploy" as CommandType,
        deployPayloadWithSite({ sourceKind: "managed-directory" }),
      ),
    Error,
    "managed directory with no principal",
  );
});

test("an unknown sourceKind is refused rather than defaulted", () => {
  for (const bad of ["directory", "", 7, null]) {
    assertThrows(
      () =>
        parseCommandPayload(
          "environment.deploy" as CommandType,
          deployPayloadWithSite({
            sourceKind: bad,
            principal: SITE_PRINCIPAL,
          }),
        ),
      Error,
      "Invalid sites entry",
    );
  }
});

test("a site's cron jobs round-trip as OnCalendar and argv", () => {
  const parsed = parseCommandPayload(
    "environment.deploy" as CommandType,
    deployPayloadWithSite({
      principal: SITE_PRINCIPAL,
      cron: [{
        name: "wp-cron",
        schedule: "*-*-* *:0/5:00",
        command: ["/usr/local/bin/php", "wp-cron.php"],
      }],
    }),
  ) as { sites: { cron?: { name: string }[] }[] };
  assertEquals(parsed.sites[0]?.cron?.[0]?.name, "wp-cron");
});

test("scheduled jobs with no principal are refused", () => {
  // A timer with no `User=` runs as root. There is no safe account to guess.
  assertThrows(
    () =>
      parseCommandPayload(
        "environment.deploy" as CommandType,
        deployPayloadWithSite({
          cron: [{
            name: "wp-cron",
            schedule: "*-*-* *:0/5:00",
            command: ["/usr/local/bin/php", "wp-cron.php"],
          }],
        }),
      ),
    Error,
    "no principal to run them as",
  );
});

test("a cron entry that could reach a unit file structurally is refused", () => {
  for (
    const bad of [
      // A relative command: systemd does not search PATH.
      { name: "a", schedule: "*-*-* 0:0:00", command: ["php", "x.php"] },
      // A newline in an argument would terminate the ExecStart directive.
      { name: "a", schedule: "*-*-* 0:0:00", command: ["/bin/x", "a\nb"] },
      // A name that is not usable as a unit filename.
      { name: "A B", schedule: "*-*-* 0:0:00", command: ["/bin/x"] },
      // A schedule carrying something other than calendar syntax.
      { name: "a", schedule: "*-*-* 0:0:00\nExecStart=/bin/sh", command: ["/bin/x"] },
      { name: "a", schedule: "*-*-* 0:0:00", command: [] },
    ]
  ) {
    assertThrows(
      () =>
        parseCommandPayload(
          "environment.deploy" as CommandType,
          deployPayloadWithSite({ principal: SITE_PRINCIPAL, cron: [bad] }),
        ),
      Error,
      "Invalid sites cron",
    );
  }
});

test("two cron jobs under one name are refused", () => {
  // They would render one unit and silently lose a job.
  assertThrows(
    () =>
      parseCommandPayload(
        "environment.deploy" as CommandType,
        deployPayloadWithSite({
          principal: SITE_PRINCIPAL,
          cron: [
            { name: "a", schedule: "*-*-* 0:0:00", command: ["/bin/x"] },
            { name: "a", schedule: "*-*-* 1:0:00", command: ["/bin/y"] },
          ],
        }),
      ),
    Error,
    "Duplicate sites cron job",
  );
});
