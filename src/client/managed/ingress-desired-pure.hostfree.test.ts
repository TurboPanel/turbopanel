/**
 * Host-free coverage for ProxySQL ingress pure helpers.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  addBackendAddressSan,
  addBindAddressSan,
  addSanValue,
  buildIngressUserRole,
  buildLocalOrMissingPortBackend,
  buildRemoteIngressBackend,
  clusterAutoReadSplit,
  clusterRequireTls,
  collectProxySqlListenerSans,
  decideIngressBindScopes,
  hostgroupsForClusterIndex,
  isAtRestSealedPassword,
  isIngressRecord,
  isManagedReplicationPrincipal,
  isManagedRootPrincipal,
  looksLikeIpLiteral,
  managedIngressFamilyForEngine,
  managedIngressPortForEngine,
  mergeHierarchyContainerSan,
  principalConnectionRole,
  principalDefaultDatabase,
  protocolListenerForEngine,
  shouldSkipIngressFrontendUser,
  sortManagedIds,
  unionExposureScopes,
  WILDCARD_BIND_ADDRESSES,
} from "./ingress-desired-pure.ts";
import type { ManagedSslMode } from "../../lib/managed/ssl.ts";
import { reservedIngressHostsForServer } from "./ingress-attachments.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("hostgroupsForClusterIndex pairs writer/reader and rejects bad indices", () => {
  assertEquals(hostgroupsForClusterIndex(0), {
    writerHostgroup: 0,
    readerHostgroup: 1,
  });
  assertEquals(hostgroupsForClusterIndex(3), {
    writerHostgroup: 6,
    readerHostgroup: 7,
  });
  assertThrows(() => hostgroupsForClusterIndex(-1), TypeError);
  assertThrows(() => hostgroupsForClusterIndex(1.5), TypeError);
});

test("unionExposureScopes unions distinct scopes and collapses public", () => {
  assertEquals(unionExposureScopes([]), []);
  assertEquals(unionExposureScopes([undefined]), []);
  assertEquals(unionExposureScopes(["local"]), ["local"]);
  assertEquals(unionExposureScopes(["local", "datacenter"]), [
    "datacenter",
    "local",
  ]);
  assertEquals(unionExposureScopes(["datacenter", "public", "local"]), [
    "public",
  ]);
});

test("protocolListenerForEngine returns the platform default port and family", () => {
  assertEquals(protocolListenerForEngine("postgres", 5432), {
    protocolPort: 15432,
    family: "pgsql",
  });
  assertEquals(protocolListenerForEngine("mysql", 3306), {
    protocolPort: 13306,
    family: "mysql",
  });
  assertEquals(protocolListenerForEngine("mariadb", 3306), {
    protocolPort: 13306,
    family: "mysql",
  });
  assertEquals(managedIngressPortForEngine("postgres", 5432), 15432);
  assertEquals(managedIngressPortForEngine("mysql", 3306), 13306);
});

test("protocolListenerForEngine honours organization-configured ports", () => {
  const ports = { postgres: 18432, mysqlFamily: 18306 };
  assertEquals(protocolListenerForEngine("postgres", 5432, ports), {
    protocolPort: 18432,
    family: "pgsql",
  });
  assertEquals(protocolListenerForEngine("mariadb", 3306, ports), {
    protocolPort: 18306,
    family: "mysql",
  });
  // Family must follow the engine even when the org moved Postgres onto a port
  // that used to mean MySQL.
  assertEquals(
    protocolListenerForEngine("postgres", 5432, {
      postgres: 16306,
      mysqlFamily: 15432,
    }),
    { protocolPort: 16306, family: "pgsql" },
  );
});

test("managedIngressFamilyForEngine falls back to the native backend port", () => {
  assertEquals(managedIngressFamilyForEngine("postgres", 5432), "pgsql");
  assertEquals(managedIngressFamilyForEngine("mysql", 3306), "mysql");
  assertEquals(managedIngressFamilyForEngine("mariadb", 3306), "mysql");
  // Unknown engine code (newer daemon): the native port decides.
  assertEquals(managedIngressFamilyForEngine("percona", 3306), "mysql");
  assertEquals(managedIngressFamilyForEngine("percona", 5432), "pgsql");
});

test("principal metadata helpers", () => {
  assertEquals(isIngressRecord(null), false);
  assertEquals(isIngressRecord([]), false);
  assertEquals(isIngressRecord({ a: 1 }), true);
  assertEquals(isManagedRootPrincipal({ managedRoot: true }), true);
  assertEquals(isManagedRootPrincipal("x"), false);
  assertEquals(
    isManagedReplicationPrincipal({ managedReplication: true }),
    true,
  );
  assertEquals(isManagedReplicationPrincipal({}), false);
  assertEquals(principalDefaultDatabase(null), undefined);
  assertEquals(principalDefaultDatabase({ databases: [] }), undefined);
  assertEquals(
    principalDefaultDatabase({ databases: ["", 1, "app"] }),
    "app",
  );
  assertEquals(buildIngressUserRole({ managedRoot: true }), "root");
  assertEquals(buildIngressUserRole({}), "user");
});

test("principalConnectionRole only recognizes an explicit read-only login", () => {
  assertEquals(
    principalConnectionRole({ connectionRole: "read-only" }),
    "read-only",
  );
  assertEquals(
    principalConnectionRole({ connectionRole: "read-write" }),
    undefined,
  );
  assertEquals(principalConnectionRole({}), undefined);
  assertEquals(principalConnectionRole(null), undefined);
  assertEquals(principalConnectionRole("read-only"), undefined);
  assertEquals(principalConnectionRole({ connectionRole: true }), undefined);
});

test("clusterAutoReadSplit defaults off unless the operator opts in", () => {
  assertEquals(clusterAutoReadSplit(undefined), false);
  assertEquals(clusterAutoReadSplit({}), false);
  assertEquals(clusterAutoReadSplit({ autoReadSplit: false }), false);
  assertEquals(clusterAutoReadSplit({ autoReadSplit: true }), true);
});

test("clusterRequireTls resolves override, then org default, then require", () => {
  // Nothing configured anywhere still enforces TLS — the platform default.
  assertEquals(clusterRequireTls(undefined, undefined), true);
  // Org default reaches an inheriting service...
  assertEquals(clusterRequireTls(undefined, "prefer"), false);
  assertEquals(clusterRequireTls(undefined, "verify-full"), true);
  // ...and a service override wins over it in both directions, so an operator
  // can loosen one cluster in a strict org and tighten one in a lax org.
  assertEquals(clusterRequireTls("allow", "verify-full"), false);
  assertEquals(clusterRequireTls("require", "disable"), true);
  // Only require/verify-* force TLS; allow and prefer leave it optional.
  assertEquals(
    ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].map(
      (mode) => clusterRequireTls(mode as ManagedSslMode, undefined),
    ),
    [false, false, false, true, true, true],
  );
});

test("looksLikeIpLiteral and SAN collectors", () => {
  assertEquals(looksLikeIpLiteral("203.0.113.10"), true);
  assertEquals(looksLikeIpLiteral("203.0.113"), false);
  assertEquals(looksLikeIpLiteral("203.0.113.999"), false);
  assertEquals(looksLikeIpLiteral("2001:db8::1"), true);
  assertEquals(WILDCARD_BIND_ADDRESSES.has("0.0.0.0"), true);

  const dns = new Set<string>();
  const ips = new Set<string>();
  addSanValue("203.0.113.10", dns, ips);
  addSanValue("db.example", dns, ips);
  assertEquals([...dns], ["db.example"]);
  assertEquals([...ips], ["203.0.113.10"]);

  addBindAddressSan(undefined, dns, ips);
  addBindAddressSan("proxy.internal", dns, ips);
  addBindAddressSan("0.0.0.0", dns, ips);
  addBindAddressSan("203.0.113.20", dns, ips);
  assertEquals(dns.has("proxy.internal"), true);
  assertEquals(ips.has("203.0.113.20"), true);
  assertEquals(ips.has("0.0.0.0"), false);

  addBackendAddressSan("", dns, ips);
  addBackendAddressSan("engine-1", dns, ips);
  addBackendAddressSan("peer.example", dns, ips);
  assertEquals(dns.has("peer.example"), true);
  assertEquals(dns.has("engine-1"), false);
});

test("collectProxySqlListenerSans and hierarchy merge", () => {
  const sans = collectProxySqlListenerSans({
    hostname: "  pg.example  ",
    bindAddresses: ["::"],
    backendAddresses: ["managed-abc", "203.0.113.50", "peer.lan"],
  });
  assertEquals(sans.dnsNames, ["peer.lan", "pg.example"]);
  assertEquals(sans.ipAddresses, ["203.0.113.50"]);

  const ipv6Bind = collectProxySqlListenerSans({
    hostname: null,
    bindAddresses: ["2001:db8::1"],
    backendAddresses: [],
  });
  assertEquals(ipv6Bind.dnsNames, []);
  assertEquals(ipv6Bind.ipAddresses, ["2001:db8::1"]);

  const merged = mergeHierarchyContainerSan(sans, "proxysql-1");
  assertEquals(merged.dnsNames.includes("proxysql-1"), true);
  assertEquals(merged.ipAddresses, sans.ipAddresses);
});

test("decideIngressBindScopes covers omit/public/resolve", () => {
  assertEquals(decideIngressBindScopes([]), { kind: "omit" });
  assertEquals(decideIngressBindScopes([undefined]), { kind: "omit" });
  assertEquals(decideIngressBindScopes([undefined, undefined]), {
    kind: "omit",
  });
  assertEquals(decideIngressBindScopes(["public"]), {
    kind: "public_all_interfaces",
    addresses: ["0.0.0.0"],
  });
  assertEquals(decideIngressBindScopes(["local"]), {
    kind: "resolve",
    scopes: ["local"],
  });
  assertEquals(decideIngressBindScopes(["datacenter", "local"]), {
    kind: "resolve",
    scopes: ["datacenter", "local"],
  });
});

test("decideIngressBindScopes ignores undefined and collapses public", () => {
  assertEquals(
    decideIngressBindScopes([undefined, "local", undefined]),
    { kind: "resolve", scopes: ["local"] },
  );
  assertEquals(
    decideIngressBindScopes([undefined, "public", "local"]),
    { kind: "public_all_interfaces", addresses: ["0.0.0.0"] },
  );
  assertEquals(
    decideIngressBindScopes(["local", "datacenter"]),
    { kind: "resolve", scopes: ["datacenter", "local"] },
  );
});

test("buildLocalOrMissingPortBackend local and remote paths", () => {
  const localOk = buildLocalOrMissingPortBackend(
    "s1",
    {
      memberId: "m1",
      serverId: "s1",
      role: "primary",
      readEligible: true,
      containerName: "engine-1",
      privatePort: null,
    },
    5432,
  );
  assertEquals(localOk, {
    kind: "ok",
    backend: {
      memberId: "m1",
      role: "primary",
      readEligible: true,
      address: "engine-1",
      port: 5432,
      transport: "local",
    },
  });

  const localMissing = buildLocalOrMissingPortBackend(
    "s1",
    {
      memberId: "m1",
      serverId: "s1",
      role: "replica",
      readEligible: false,
      containerName: null,
      privatePort: null,
    },
    5432,
  );
  assertEquals(localMissing.kind, "private_path_unavailable");

  const remoteMissingPort = buildLocalOrMissingPortBackend(
    "s1",
    {
      memberId: "m2",
      serverId: "s2",
      role: "replica",
      readEligible: true,
      containerName: null,
      privatePort: null,
    },
    5432,
  );
  assertEquals(remoteMissingPort.kind, "private_path_unavailable");

  const remote = buildLocalOrMissingPortBackend(
    "s1",
    {
      memberId: "m2",
      serverId: "s2",
      role: "replica",
      readEligible: true,
      containerName: null,
      privatePort: 54001,
    },
    5432,
  );
  assertEquals(remote, { kind: "remote", role: "replica" });

  assertEquals(
    buildRemoteIngressBackend({
      memberId: "m2",
      role: "replica",
      readEligible: true,
      address: "203.0.113.9",
      privatePort: 54001,
      transport: "fabric",
    }),
    {
      memberId: "m2",
      role: "replica",
      readEligible: true,
      address: "203.0.113.9",
      port: 54001,
      transport: "fabric",
    },
  );

  assertEquals(
    buildRemoteIngressBackend({
      memberId: "m2",
      role: "replica",
      readEligible: true,
      address: "203.0.113.10",
      privatePort: 54001,
      transport: "public",
    }),
    {
      memberId: "m2",
      role: "replica",
      readEligible: true,
      address: "203.0.113.10",
      port: 54001,
      transport: "public",
    },
  );
});

test("frontend user skip + sealed password checks", () => {
  assertEquals(shouldSkipIngressFrontendUser("", {}), true);
  assertEquals(shouldSkipIngressFrontendUser(null, {}), true);
  assertEquals(
    shouldSkipIngressFrontendUser("repl", { managedReplication: true }),
    true,
  );
  assertEquals(shouldSkipIngressFrontendUser("app", {}), false);

  assertEquals(isAtRestSealedPassword("tp1.abc", "tp1."), true);
  assertEquals(isAtRestSealedPassword("plain", "tp1."), false);
  assertEquals(isAtRestSealedPassword(null, "tp1."), false);
});

test("sortManagedIds is locale-stable", () => {
  assertEquals(sortManagedIds(new Set(["b", "a", "c"])), ["a", "b", "c"]);
});

test("reservedIngressHostsForServer maps listener name to reserved segment address", () => {
  const netId = "00000000-0000-4000-8000-0000000000cc";
  const hostName = `tpn_${netId}`;
  const attachments = [{ serverId: "s-a", networkKeys: ["frontend"] }];
  const consumers = [{
    composeServiceName: "web",
    networkKeys: ["frontend"],
    listenerServerId: "s-a",
  }];
  const spanning = new Map([["frontend", hostName]]);
  const segmentsByServer = new Map([
    ["s-a", [{ name: hostName, subnet: "203.0.113.0/24" }]],
  ]);
  const listenerNameByServer = new Map([["s-a", "svc-sql"]]);
  assertEquals(
    reservedIngressHostsForServer({
      thisServerId: "s-b",
      attachments,
      consumers,
      spanning,
      segmentsByServer,
      listenerNameByServer,
    }),
    new Map([["web", [{ name: "svc-sql", address: "203.0.113.254" }]]]),
  );
  assertEquals(
    reservedIngressHostsForServer({
      thisServerId: "s-a",
      attachments,
      consumers,
      spanning,
      segmentsByServer,
      listenerNameByServer,
    }),
    new Map(),
  );
});

test("reservedIngressHostsForServer scopes the reserved address to each consumer network", () => {
  const frontendHost = "tpn_00000000-0000-4000-8000-0000000000cc";
  const backendHost = "tpn_00000000-0000-4000-8000-0000000000dd";
  const attachments = [{
    serverId: "s-a",
    networkKeys: ["backend", "frontend"],
  }];
  const consumers = [
    {
      composeServiceName: "api",
      networkKeys: ["backend"],
      listenerServerId: "s-a",
    },
    {
      composeServiceName: "web",
      networkKeys: ["frontend"],
      listenerServerId: "s-a",
    },
  ];
  const spanning = new Map([
    ["frontend", frontendHost],
    ["backend", backendHost],
  ]);
  const segmentsByServer = new Map([
    ["s-a", [
      { name: frontendHost, subnet: "203.0.113.0/24" },
      { name: backendHost, subnet: "198.51.100.0/24" },
    ]],
  ]);
  const hosts = reservedIngressHostsForServer({
    thisServerId: "s-b",
    attachments,
    consumers,
    spanning,
    segmentsByServer,
    listenerNameByServer: new Map([["s-a", "svc-sql"]]),
  });
  assertEquals(hosts.get("web"), [{
    name: "svc-sql",
    address: "203.0.113.254",
  }]);
  assertEquals(hosts.get("api"), [{
    name: "svc-sql",
    address: "198.51.100.254",
  }]);
  assertEquals(hosts.has("worker"), false);
});
