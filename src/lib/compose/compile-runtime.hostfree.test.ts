import { assertEquals } from "@std/assert";
import {
  compileRuntimeCompose,
  compileRuntimeComposeDocument,
} from "./compile-runtime.ts";
import { composeDocumentToRuntimeYaml } from "./convert.ts";
import { TURBOPANEL_EXTENSION_KEY } from "./placement.ts";
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
            name: "00000000-0000-4000-8000-0000000000aa-in",
            address: "203.0.113.254",
          },
        ]],
      ]),
    },
  );
  const web =
    (compiled.data.services as Record<string, Record<string, unknown>>).web;
  assertEquals(web?.extra_hosts, [
    "00000000-0000-4000-8000-0000000000aa-in:203.0.113.254",
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
        ["web", [{ name: "svc-in", address: "203.0.113.254" }]],
        ["api", [{ name: "svc-in", address: "198.51.100.254" }]],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.extra_hosts, ["svc-in:203.0.113.254"]);
  assertEquals(services.api?.extra_hosts, ["svc-in:198.51.100.254"]);
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

test("compileRuntimeComposeDocument annotates x-turbopanel placement", () => {
  const serverId = "01989d42-9adb-7e65-bc2e-f38792c53691";
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: { web: { image: "nginx" } },
    }),
    { placementServerId: serverId },
  );
  assertEquals(compiled.data[TURBOPANEL_EXTENSION_KEY], {
    placement: { server_id: serverId },
  });
  const yaml = composeDocumentToRuntimeYaml(compiled);
  assertEquals(yaml.lastIndexOf("x-turbopanel:") > yaml.indexOf("services:"), true);
  assertEquals(yaml.includes(serverId), true);
});

test("compileRuntimeComposeDocument omits placement without a server id", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: { web: { image: "nginx" } },
    }),
  );
  assertEquals(compiled.data[TURBOPANEL_EXTENSION_KEY], undefined);
});

test("compileRuntimeComposeDocument filters depends_on list form to local services", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          depends_on: ["db", "cache", 42],
        },
        db: { image: "postgres" },
        cache: { image: "redis" },
      },
    }),
    { localServiceNames: new Set(["web", "db"]) },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.depends_on, ["db"]);
  assertEquals(services.cache, undefined);
});

test("compileRuntimeComposeDocument merges identity labels when scale is greater than one", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          labels: ["com.example=keep", "com.turbopanel.service=stale"],
          container_name: "custom-web",
        },
      },
    }),
    {
      localReplicaCounts: new Map([["web", 3]]),
      environmentId: "env-1",
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.scale, 3);
  assertEquals("container_name" in (services.web ?? {}), false);
  assertEquals(services.web?.labels, [
    "com.example=keep",
    "com.turbopanel.service=web",
    "com.turbopanel.environment=env-1",
  ]);
});

test("compileRuntimeComposeDocument prunes volumes not referenced by remaining services", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      volumes: {
        web_data: {},
        db_data: {},
      },
      services: {
        web: {
          image: "nginx",
          volumes: ["web_data:/var/www", "/host:/bind"],
        },
        db: {
          image: "postgres",
          volumes: ["db_data:/var/lib/postgresql/data"],
        },
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  assertEquals(compiled.data.volumes, { web_data: {} });
});

test("compileRuntimeComposeDocument prunes build secrets referenced only on filtered services", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      secrets: {
        build_token: { file: "/run/secrets/build" },
        web_token: { file: "/run/secrets/web" },
      },
      services: {
        web: {
          image: "nginx",
          secrets: ["web_token"],
        },
        builder: {
          build: {
            context: ".",
            secrets: [{ source: "build_token" }],
          },
        },
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  assertEquals(compiled.data.secrets, {
    web_token: { file: "/run/secrets/web" },
  });
});

test("compileRuntimeComposeDocument rewrites depends_on map when a dependency expands", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
        },
        api: {
          image: "node",
          networks: ["frontend"],
          depends_on: {
            web: { condition: "service_started" },
            ghost: { condition: "service_started" },
          },
          extra_hosts: { "legacy.local": "203.0.113.1" },
        },
      },
      networks: { frontend: {} },
    }),
    {
      localServiceNames: new Set(["web", "api"]),
      localReplicaCounts: new Map([["web", 2], ["api", 1]]),
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"], [1, "203.0.113.11"]])],
        ["api", new Map([[0, "203.0.113.20"]])],
      ]),
      environmentId: "env-1",
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.api?.depends_on, {
    "web-1": { condition: "service_started" },
    "web-2": { condition: "service_started" },
  });
  assertEquals(
    (services.api?.extra_hosts as Record<string, string>)["legacy.local"],
    "203.0.113.1",
  );
});

test("compileRuntimeComposeDocument ignores non-object network attachments for spanning keys", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: 12,
        },
      },
      networks: { frontend: {} },
    }),
    {
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.networks, 12);
});

test("compileRuntimeComposeDocument drops networks when no remaining service references them", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        worker: { image: "busybox", networks: ["backend"] },
      },
      networks: {
        frontend: {},
        backend: {},
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  assertEquals(compiled.data.networks, { frontend: {} });

  const empty = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx" },
        worker: { image: "busybox", networks: ["backend"] },
      },
      networks: { backend: {} },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  assertEquals(empty.data.networks, undefined);
});

test("compileRuntimeComposeDocument keeps non-mapping services and skips zero replica counts", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: "not-a-mapping",
        api: { image: "node" },
      },
    }),
    {
      localServiceNames: new Set(["web", "api"]),
      localReplicaCounts: new Map([["api", 0]]),
    },
  );
  const services = compiled.data.services as Record<string, unknown>;
  assertEquals(services.web, "not-a-mapping");
  assertEquals(services.api, undefined);
});

test("compileRuntimeComposeDocument merges map-form extra_hosts without duplicating names", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: {
            "api.env-1": "198.51.100.9",
            "keep.local": "203.0.113.50",
          },
        },
        api: {
          image: "node",
          networks: ["frontend"],
        },
      },
      networks: { frontend: {} },
    }),
    {
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
        ["api", new Map([[0, "203.0.113.20"]])],
      ]),
      environmentId: "env-1",
      spanningHostsByService: new Map([
        [
          "api",
          {
            primary: "203.0.113.20",
            replicas: new Map(),
            networks: new Set(["frontend"]),
          },
        ],
        [
          "web",
          {
            primary: "203.0.113.10",
            replicas: new Map(),
            networks: new Set(["frontend"]),
          },
        ],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services.web?.extra_hosts, {
    "api.env-1": "198.51.100.9",
    "keep.local": "203.0.113.50",
  });
});

test("compileRuntimeComposeDocument drops depends_on when every dependency is remote", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          depends_on: ["db", "cache"],
        },
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals("depends_on" in (web ?? {}), false);
});

test("compileRuntimeComposeDocument expands spanning replicas without pre-assigned addresses", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      localReplicaCounts: new Map([["web", 2]]),
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals("web-1" in services, true);
  assertEquals("web-2" in services, true);
  assertEquals(services["web-1"]?.networks, ["frontend"]);
});

test("compileRuntimeComposeDocument skips non-string extra_hosts entries when merging", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: [12, "legacy.local:192.0.2.1"],
        },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
        ["api", new Map([[0, "203.0.113.20"]])],
      ]),
      spanningHostsByService: new Map([
        ["web", {
          primary: "203.0.113.10",
          replicas: new Map(),
          networks: new Set(["frontend"]),
        }],
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map(),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, [
    12,
    "legacy.local:192.0.2.1",
    "api.env-1:203.0.113.20",
  ]);
});

test("compileRuntimeComposeDocument omits peer extra_hosts when peer networks are empty", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
        ["api", new Map([[0, "203.0.113.20"]])],
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
          networks: new Set(),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals("extra_hosts" in (web ?? {}), false);
});

test("compileRuntimeCompose returns identity expansion for unexpanded services", () => {
  const { document, expansion } = compileRuntimeCompose(
    doc({ services: { web: { image: "nginx" } } }),
  );
  assertEquals(expansion.get("web"), ["web"]);
  assertEquals(
    (document.data.services as Record<string, unknown>).web !== undefined,
    true,
  );
});

test("compileRuntimeCompose expands spanning replicas in the expansion map", () => {
  const { expansion } = compileRuntimeCompose(
    doc({
      services: { web: { image: "nginx", networks: ["frontend"] } },
      networks: { frontend: {} },
    }),
    {
      localReplicaCounts: new Map([["web", 2]]),
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
    },
  );
  assertEquals(expansion.get("web"), ["web-1", "web-2"]);
});

test("compileRuntimeComposeDocument merges map-form labels when scale is greater than one", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          labels: { "com.example": "keep" },
        },
      },
    }),
    { localReplicaCounts: new Map([["web", 3]]) },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.scale, 3);
  assertEquals(web?.labels, {
    "com.example": "keep",
    "com.turbopanel.service": "web",
  });
  assertEquals("com.turbopanel.environment" in (web?.labels as object), false);
});

test("compileRuntimeComposeDocument skips extra_hosts that already use name= form", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: ["api.env-1=198.51.100.9", "api.env-1"],
        },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map(),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, ["api.env-1=198.51.100.9", "api.env-1"]);
});

test("compileRuntimeComposeDocument replaces a non-list extra_hosts value when merging", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: 12,
        },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map(),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, ["api.env-1:203.0.113.20"]);
});

test("compileRuntimeComposeDocument merges managed ingress extra_hosts without spanning networks", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: { web: { image: "nginx" } },
    }),
    {
      managedIngressHostsByService: new Map([
        ["web", [{ name: "svc-in", address: "203.0.113.254" }]],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, ["svc-in:203.0.113.254"]);
});

test("compileRuntimeComposeDocument does not attach default when the service already lists networks", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      spanningNetworks: new Map([
        ["default", "tpn_default"],
        ["frontend", "tpn_front"],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.networks, ["frontend"]);
  assertEquals(compiled.data.networks, {
    frontend: { external: true, name: "tpn_front" },
  });
});

test("compileRuntimeComposeDocument adds spanning keys that were absent from networks", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
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

test("compileRuntimeComposeDocument object-form networks with non-object values still get ipv4_address", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: { frontend: "bridge" },
        },
      },
      networks: { frontend: {} },
    }),
    {
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([
        ["web", new Map([[0, "203.0.113.10"]])],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.networks, {
    frontend: { ipv4_address: "203.0.113.10" },
  });
});

test("compileRuntimeComposeDocument keeps a string depends_on when filtering locals", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", depends_on: "db" },
        db: { image: "postgres" },
      },
    }),
    { localServiceNames: new Set(["web"]) },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.depends_on, "db");
});

test("compileRuntimeComposeDocument drops non-string depends_on list entries during expansion rewrite", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: {
          image: "node",
          networks: ["frontend"],
          depends_on: [12, true],
        },
      },
      networks: { frontend: {} },
    }),
    {
      localReplicaCounts: new Map([["web", 2], ["api", 1]]),
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
    },
  );
  const api = (compiled.data.services as Record<string, Record<string, unknown>>)
    .api;
  assertEquals("depends_on" in (api ?? {}), false);
});

test("compileRuntimeComposeDocument deletes empty volume and secret mappings", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      volumes: {},
      secrets: {},
      services: { web: { image: "nginx" } },
    }),
  );
  assertEquals("volumes" in compiled.data, false);
  assertEquals("secrets" in compiled.data, false);
});

test("compileRuntimeComposeDocument prunes secrets when the remaining service uses a non-array secrets value", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      secrets: { web_token: { file: "/run/secrets/web" } },
      services: {
        web: { image: "nginx", secrets: "web_token" },
      },
    }),
  );
  assertEquals("secrets" in compiled.data, false);
});

test("compileRuntimeComposeDocument ignores an empty task-address slot map", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      taskAddressesByService: new Map([["web", new Map()]]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.networks, ["frontend"]);
});

test("compileRuntimeComposeDocument skips replica extra_hosts with a blank address", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map([[2, ""]]),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, ["api.env-1:203.0.113.20"]);
});

test("compileRuntimeComposeDocument copies managed ingress extra_hosts onto expanded spanning clones", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      localReplicaCounts: new Map([["web", 2]]),
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      managedIngressHostsByService: new Map([
        ["web", [{ name: "svc-in", address: "203.0.113.254" }]],
      ]),
    },
  );
  const services = compiled.data.services as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(services["web-1"]?.extra_hosts, ["svc-in:203.0.113.254"]);
  assertEquals(services["web-2"]?.extra_hosts, ["svc-in:203.0.113.254"]);
});

test("compileRuntimeComposeDocument keeps a non-mapping volumes value when no services remain", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      volumes: "legacy",
      services: { web: { image: "nginx" } },
    }),
    { localServiceNames: new Set(["other"]) },
  );
  assertEquals(compiled.data.volumes, "legacy");
  assertEquals(compiled.data.services, {});
});

test("compileRuntimeComposeDocument keeps empty services when volumes are still present", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      volumes: ["legacy-volume"],
      services: { web: { image: "nginx" } },
    }),
    { localServiceNames: new Set(["other"]) },
  );
  // Empty-service short-circuit only fires when volumes/networks are also gone.
  assertEquals(compiled.data.services, {});
  assertEquals(compiled.data.volumes, ["legacy-volume"]);
});

test("compileRuntimeComposeDocument skips extra_hosts that already use exact name", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: ["api.env-1"],
        },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map(),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, ["api.env-1"]);
});

test("compileRuntimeComposeDocument skips extra_hosts that already use name: form", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: "nginx",
          networks: ["frontend"],
          extra_hosts: ["api.env-1:192.0.2.9"],
        },
        api: { image: "node", networks: ["frontend"] },
      },
      networks: { frontend: {} },
    }),
    {
      environmentId: "env-1",
      spanningNetworks: new Map([["frontend", "tpn_net1"]]),
      spanningHostsByService: new Map([
        ["api", {
          primary: "203.0.113.20",
          replicas: new Map(),
          networks: new Set(["frontend"]),
        }],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals(web?.extra_hosts, ["api.env-1:192.0.2.9"]);
});

test("compileRuntimeComposeDocument omits managed ingress extra_hosts when the service has no spanning keys", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: "nginx", networks: ["local"] },
      },
      networks: { local: {} },
    }),
    {
      spanningNetworks: new Map([["fabric", "tpn_fabric"]]),
      managedIngressHostsByService: new Map([
        ["web", [{ name: "svc-in", address: "203.0.113.254" }]],
      ]),
    },
  );
  const web = (compiled.data.services as Record<string, Record<string, unknown>>)
    .web;
  assertEquals("extra_hosts" in (web ?? {}), false);
});

test("compileRuntimeComposeDocument keeps non-mapping service entries and skips non-string volume mounts", () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      volumes: { data: {} },
      secrets: { dbpass: { file: "/run/secrets/db" } },
      services: {
        web: {
          image: "nginx",
          volumes: [12, { target: "/unused" }, "data:/var/lib/data"],
          build: { context: ".", secrets: ["dbpass"] },
        },
        broken: "not-a-mapping",
      },
    }),
  );
  const services = compiled.data.services as Record<string, unknown>;
  assertEquals(services.broken, "not-a-mapping");
  assertEquals(compiled.data.volumes, { data: {} });
  assertEquals(compiled.data.secrets, { dbpass: { file: "/run/secrets/db" } });
});
