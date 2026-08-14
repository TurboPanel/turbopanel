import { assertEquals } from "jsr:@std/assert";
import { compileRuntimeComposeDocument } from "./compile-runtime.ts";
import { type ComposeDocument, emptyComposeDocument } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function doc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  };
}

test("compileRuntimeComposeDocument strips scheduler-only deploy keys", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          deploy: {
            mode: "replicated",
            replicas: 3,
            placement: { constraints: ["node.labels.role == web"] },
            update_config: { parallelism: 1 },
            rollback_config: { parallelism: 1 },
            endpoint_mode: "vip",
            resources: { limits: { cpus: "0.5" } },
            restart_policy: { condition: "on-failure" },
          },
        },
      },
    }),
  );
  const web = compiled.data.services as Record<string, Record<string, unknown>>;
  assertEquals(web.web?.image, "nginx");
  assertEquals(web.web?.deploy, {
    resources: { limits: { cpus: "0.5" } },
    restart_policy: { condition: "on-failure" },
  });
});

test("compileRuntimeComposeDocument drops empty deploy after stripping", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          deploy: { replicas: 2, mode: "replicated" },
        },
      },
    }),
  );
  const web = compiled.data.services as Record<string, Record<string, unknown>>;
  assertEquals("deploy" in (web.web ?? {}), false);
});

test("compileRuntimeComposeDocument filters to local services and strips remote depends_on", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          depends_on: { db: { condition: "service_started" }, cache: {} },
        },
        db: { image: "postgres" },
        cache: { image: "redis" },
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  const services = compiled.data.services as Record<string, unknown>;
  assertEquals(Object.keys(services).sort((a, b) => a.localeCompare(b)), [
    "web",
  ]);
  const web = services.web as Record<string, unknown>;
  assertEquals("depends_on" in web, false);
});

test("compileRuntimeComposeDocument sets scale and drops container_name for local replicas > 1", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", container_name: "web-uuid" },
      },
    }),
    {
      environmentId: "env-1",
      localReplicaCounts: new Map([["web", 3]]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals(web?.scale, 3);
  assertEquals("container_name" in (web ?? {}), false);
  assertEquals(web?.labels, {
    "com.turbopanel.service": "web",
    "com.turbopanel.environment": "env-1",
  });
});

test("compileRuntimeComposeDocument rewrites spanning networks as external tpn_* names", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
      networks: {
        frontend: { driver: "bridge" },
        unused: { driver: "bridge" },
      },
    }),
    {
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
    },
  );
  assertEquals(compiled.data.networks, {
    frontend: { external: true, name: "tpn_net1" },
  });
});

test("compileRuntimeComposeDocument returns empty document when no services remain", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({ services: { web: { image: "nginx" } } }),
    { localServiceNames: new Set(["other"]) },
  );
  assertEquals(compiled.data, emptyComposeDocument().data);
});

test("compileRuntimeComposeDocument injects spanning default as an external network", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx" },
      },
    }),
    {
      spanningNetworks: new Map([["default", "tpn_net_default"]]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals(web?.networks, ["default"]);
  assertEquals(compiled.data.networks, {
    default: { external: true, name: "tpn_net_default" },
  });
});

test("compileRuntimeComposeDocument emits ipv4_address only on the local spanning attachment", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend", "backend"],
        },
      },
      networks: {
        frontend: { driver: "bridge" },
        backend: { driver: "bridge" },
      },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
      ]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals(web?.networks, {
    frontend: { ipv4_address: "203.0.113.10" },
    backend: {},
  });
  assertEquals(compiled.data.networks, {
    frontend: { external: true, name: "tpn_net1" },
    backend: { driver: "bridge" },
  });
});

test("compileRuntimeComposeDocument merges extra_hosts for sibling spanning services", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: ["legacy.example.test:192.0.2.1"],
        },
      },
      networks: {
        frontend: { driver: "bridge" },
      },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
      ]),
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map([
            [1, "203.0.113.20"],
            [2, "203.0.113.21"],
          ]),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals(web?.extra_hosts, [
    "legacy.example.test:192.0.2.1",
    "api.env-1:203.0.113.20",
    "api-1.env-1:203.0.113.20",
    "api-2.env-1:203.0.113.21",
  ]);
});

test("compileRuntimeComposeDocument omits extra_hosts when there is no spanning network", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx" },
      },
    }),
    {
      environmentId: "env-1",
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map([[1, "203.0.113.20"]]),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals("extra_hosts" in (web ?? {}), false);
});

test("compileRuntimeComposeDocument merges managed ingress extra_hosts when not co-resident", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      managedIngressHostsByService: new Map([
        ["web", [
          {
            name: "00000000-0000-4000-8000-0000000000aa-sql",
            address: "203.0.113.254",
          },
        ]],
      ]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals(web?.extra_hosts, [
    "00000000-0000-4000-8000-0000000000aa-sql:203.0.113.254",
  ]);
});

test("compileRuntimeComposeDocument omits managed ingress extra_hosts when co-resident", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals("extra_hosts" in (web ?? {}), false);
});

test("compileRuntimeComposeDocument scopes managed ingress extra_hosts to the bound service network", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "api", networks: ["backend"] },
        worker: { image: "worker", networks: ["frontend"] },
      },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([
        ["frontend", "tpn_net1"],
        ["backend", "tpn_net2"],
      ]),
      managedIngressHostsByService: new Map([
        ["web", [{ name: "svc-sql", address: "203.0.113.254" }]],
        ["api", [{ name: "svc-sql", address: "198.51.100.254" }]],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.extra_hosts, ["svc-sql:203.0.113.254"]);
  assertEquals(services.api?.extra_hosts, ["svc-sql:198.51.100.254"]);
  assertEquals("extra_hosts" in (services.worker ?? {}), false);
});

test("compileRuntimeComposeDocument expands two local spanning replicas with distinct ipv4_address", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          container_name: "web-uuid",
          networks: ["frontend"],
        },
        api: {
          image: "api",
          networks: ["frontend"],
          depends_on: ["web"],
        },
      },
      networks: {
        frontend: { driver: "bridge" },
      },
    }),
    {
      environmentId: "env-1",
      localReplicaCounts: new Map([["web", 2], ["api", 1]]),
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"], [1, "203.0.113.11"]])],
        ["api", new Map([[0, "203.0.113.20"]])],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals("web" in services, false);
  assertEquals("scale" in (services["web-1"] ?? {}), false);
  assertEquals("container_name" in (services["web-1"] ?? {}), false);
  assertEquals(services["web-1"]?.networks, {
    frontend: { ipv4_address: "203.0.113.10" },
  });
  assertEquals(services["web-2"]?.networks, {
    frontend: { ipv4_address: "203.0.113.11" },
  });
  assertEquals(services["web-1"]?.labels, {
    "com.turbopanel.service": "web",
    "com.turbopanel.environment": "env-1",
  });
  assertEquals(services.api?.depends_on, ["web-1", "web-2"]);
});

test("compileRuntimeComposeDocument extra_hosts is sibling-only and network-scoped", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "api", networks: ["frontend"] },
        cache: { image: "redis", networks: ["backend"] },
        worker: { image: "worker", networks: ["backend"] },
      },
      networks: {
        frontend: { driver: "bridge" },
        backend: { driver: "bridge" },
      },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([
        ["frontend", "tpn_front"],
        ["backend", "tpn_back"],
      ]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
        ["api", new Map([[0, "203.0.113.20"]])],
        ["cache", new Map([[0, "198.51.100.10"]])],
        ["worker", new Map([[0, "198.51.100.20"]])],
      ]),
      spanningHostsByService: new Map([
        ["web", {
          primary: "203.0.113.10",
          replicas: new Map([[1, "203.0.113.10"]]),
          networks: new Set(["frontend"]),
        }],
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map([[1, "203.0.113.20"]]),
          networks: new Set(["frontend"]),
        }],
        ["cache", {
          primary: "198.51.100.10",
          replicas: new Map([[1, "198.51.100.10"]]),
          networks: new Set(["backend"]),
        }],
        ["worker", {
          primary: "198.51.100.20",
          replicas: new Map([[1, "198.51.100.20"]]),
          networks: new Set(["backend"]),
        }],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.extra_hosts, [
    "api.env-1:203.0.113.20",
    "api-1.env-1:203.0.113.20",
  ]);
  assertEquals(services.worker?.extra_hosts, [
    "cache.env-1:198.51.100.10",
    "cache-1.env-1:198.51.100.10",
  ]);
  assertEquals(services.api?.extra_hosts, [
    "web.env-1:203.0.113.10",
    "web-1.env-1:203.0.113.10",
  ]);
});

test("compileRuntimeComposeDocument prunes secrets not referenced by remaining services", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      secrets: {
        web_token: { file: "/run/secrets/web" },
        db_token: { file: "/run/secrets/db" },
      },
      services: {
        web: {
          image: "nginx",
          secrets: [{ source: "web_token", target: "token" }],
        },
        db: {
          image: "postgres",
          secrets: ["db_token"],
        },
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  assertEquals(compiled.data.secrets, {
    web_token: { file: "/run/secrets/web" },
  });
});
