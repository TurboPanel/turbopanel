import { assertEquals, assertRejects } from "@std/assert";
import type { EnvironmentDeploySite } from "../../lib/commands/schemas.ts";
import { describe, it } from "@std/testing/bdd";
import {
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
} from "../../lib/compose/apply-service-options.ts";
import {
  assertComposeDocument,
  type SiteSpec,
} from "../../lib/compose/index.ts";
import {
  dockerVolumeNameFromStorageId,
  principalHomeDir,
  principalVolumePath,
  resolveDockerVolumeName,
} from "../../lib/naming.ts";
import { DEFAULT_PRINCIPAL_SHELL } from "../../lib/principal-options.ts";
import { sumServiceResourceUsage } from "../../lib/resource-limits.ts";
import type { Db } from "../../db.ts";
import {
  absorbSoftPrepareError,
  attachPrincipalsToSites,
  buildCloneNamesByServiceId,
  buildExpandedServiceOptionsMap,
  buildInstancesByComposeName,
  buildServiceRowByCloneName,
  compileRuntimeOptionsForServer,
  documentForServiceOptions,
  emptyComposePrepareResult,
  emptyPreparedCompose,
  evaluateHealthCheckGates,
  expansionToRecord,
  extractComposeFromOptions,
  fabricNetworksFromSchedule,
  findUnavailableStorageCopy,
  healthCheckAcknowledge,
  listComposeServiceKeys,
  listContainerComposeNames,
  loadPrincipalMaterial,
  loadStorageMaterial,
  localManagedNetworkServiceNames,
  mergeProjectEnvironmentCompose,
  nativeAppServicesForDeploy,
  readHostingProxyFromOptions,
  resolveHostingBindAddress,
  resolveProjectEnvironmentComposeLayers,
  resolveSitesForMode,
  resourceLimitPrepareError,
  sitesOnScheduledServer,
  splitHostNativeFromDocument,
  stripReservedKeysFromEntries,
  toApplyVariablesPrepareError,
  toPreparedDeployResult,
  verifyServerInOrg,
  warningFromPrepareError,
} from "./deploy-prepare.ts";

describe("deploy-prepare helpers", () => {
  it("counts compose services for resource usage even without DB options rows", () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: "nginx:latest" },
          api: { image: "node:22" },
        },
      },
      presentation: { keyOrder: ["services"], comments: {} },
    });

    const composeNames = Object.keys(
      merged.data.services as Record<string, unknown>,
    );
    const optionsByComposeName = buildServiceOptionsMap([]);
    const usage = sumServiceResourceUsage(
      optionsByComposeName,
      composeNames.length,
    );

    assertEquals(usage.serviceCount, 2);
    assertEquals(usage.cpus, 0);
  });

  it("does not warn by default when compose has no healthcheck", () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: "nginx:latest" },
        },
      },
      presentation: { keyOrder: ["services"], comments: {} },
    });

    const warnings = collectHealthCheckWarnings(merged, new Map());
    assertEquals(warnings.length, 0);
  });

  it("keeps local turbopanel-managed attachment when another service uses remote extra_hosts", () => {
    const remote = new Map([
      ["remote-app", [{ name: "svc-in", address: "203.0.113.254" }]],
    ]);
    assertEquals(
      localManagedNetworkServiceNames(["local-app", "remote-app"], remote),
      ["local-app"],
    );
    assertEquals(
      localManagedNetworkServiceNames(["local-app", "remote-app"], new Map()),
      ["local-app", "remote-app"],
    );
  });

  it("keeps managedNetworkServices for a service with both remote hosts and a local binding", () => {
    // `managedNetworkServices` is this list after expansion. `api` consumes
    // two managed clusters: one served by a remote ProxySQL (extra_hosts) and
    // one by this host's listener. Dropping the local attachment because
    // remote hosts exist would break the second set of connections.
    const remote = new Map([
      ["api", [{ name: "svc-in", address: "203.0.113.254" }]],
      ["worker", [{ name: "svc-in", address: "203.0.113.254" }]],
    ]);
    assertEquals(
      localManagedNetworkServiceNames(
        ["api", "worker"],
        remote,
        new Set(["api"]),
      ),
      ["api"],
    );
    // Without a co-resident binding the service still stays off the network.
    assertEquals(
      localManagedNetworkServiceNames(["api", "worker"], remote, new Set()),
      [],
    );
  });

  it("warns only when the operator sets healthCheck.policy to warn", () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: "nginx:latest" },
        },
      },
      presentation: { keyOrder: ["services"], comments: {} },
    });

    const optionsByComposeName = buildServiceOptionsMap([
      {
        composeServiceName: "web",
        options: { healthCheck: { policy: "warn" } },
      },
    ]);
    const warnings = collectHealthCheckWarnings(merged, optionsByComposeName);
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]?.composeServiceName, "web");
    assertEquals(warnings[0]?.policy, "warn");
  });

  it("skips services that already declare a compose healthcheck", () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: {
            image: "nginx:latest",
            healthcheck: { test: ["CMD", "curl", "-f", "http://localhost"] },
          },
        },
      },
      presentation: { keyOrder: ["services"], comments: {} },
    });

    const optionsByComposeName = buildServiceOptionsMap([
      {
        composeServiceName: "web",
        options: { healthCheck: { policy: "required" } },
      },
    ]);
    const warnings = collectHealthCheckWarnings(merged, optionsByComposeName);
    assertEquals(warnings.length, 0);
  });
});

type IpRow = {
  id: string;
  address: string;
  serverId: string | null;
  scope: string;
};

function createIpLookupDb(
  rows: IpRow[],
): Parameters<typeof resolveHostingBindAddress>[0] {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve(rows.slice(0, 1));
                    },
                  };
                },
                limit() {
                  // Caller chains `.where(...).limit(1)`; return first matching
                  // row. Public-by-id and datacenter-by-server (via orderBy) end here.
                  return Promise.resolve(rows.slice(0, 1));
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof resolveHostingBindAddress>[0];
}

describe("resolveHostingBindAddress", () => {
  it("public + ipId returns the pinned address", async () => {
    const db = createIpLookupDb([{
      id: "ip-1",
      address: "203.0.113.10",
      serverId: "srv-1",
      scope: "public",
    }]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: { bind: "public" },
      ipId: "ip-1",
    });
    assertEquals(result, "203.0.113.10");
  });

  it("public + no ipId returns undefined", async () => {
    const db = createIpLookupDb([]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: {},
      ipId: null,
    });
    assertEquals(result, undefined);
  });

  it("local returns loopback", async () => {
    const db = createIpLookupDb([]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: { bind: "local" },
      ipId: null,
    });
    assertEquals(result, "127.0.0.1");
  });

  it("datacenter returns the server private IP when present", async () => {
    const db = createIpLookupDb([{
      id: "ip-dc",
      address: "10.0.0.1",
      serverId: "srv-1",
      scope: "datacenter",
    }]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: { bind: "datacenter" },
      ipId: null,
    });
    assertEquals(result, "10.0.0.1");
  });

  it("datacenter missing returns typed DeployPrepareError", async () => {
    const db = createIpLookupDb([]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-missing-dc",
      options: { bind: "datacenter" },
      ipId: null,
    });
    assertEquals(result, {
      kind: "datacenter_ip_required",
      serverId: "srv-missing-dc",
    });
  });

  it("public + ipId rejects server mismatch", async () => {
    const db = createIpLookupDb([{
      id: "ip-1",
      address: "203.0.113.10",
      serverId: "other-server",
      scope: "public",
    }]);
    await assertRejects(
      () =>
        resolveHostingBindAddress(db, {
          serverId: "srv-1",
          options: { bind: "public" },
          ipId: "ip-1",
        }),
      Error,
      "server mismatch",
    );
  });
});

type LocationFixtureRow = {
  storageId: string;
  locationId: string;
  kind: string;
  name: string;
  accessMode: string;
  principalId: string | null;
  principalUsername: string | null;
  contentEnvelope: string | null;
  locationServerId: string | null;
  provider: string;
  role: string;
  path: string | null;
  locationOptions: unknown;
  metadata: unknown;
};

type MountFixtureRow = {
  storageId: string;
  serviceId: string;
  composeServiceName: string;
  destinationPath: string;
  subpath: string | null;
  readOnly: boolean;
};

function createSelectWhereDb<T>(rows: T[]): Db {
  const whereResult = () => Promise.resolve(rows);
  return {
    select() {
      return {
        from() {
          return {
            leftJoin() {
              return { where: whereResult };
            },
            innerJoin() {
              return { where: whereResult };
            },
            where: whereResult,
          };
        },
      };
    },
  } as unknown as Db;
}

function createStorageMaterialDb(opts: {
  locations: LocationFixtureRow[];
  mounts?: MountFixtureRow[];
}): Db {
  let calls = 0;
  return {
    select() {
      return {
        from() {
          const chain = {
            innerJoin() {
              return chain;
            },
            leftJoin() {
              return chain;
            },
            where() {
              calls += 1;
              if (calls === 1) return Promise.resolve(opts.locations);
              return Promise.resolve(opts.mounts ?? []);
            },
          };
          return chain;
        },
      };
    },
  } as unknown as Db;
}

function pathLocation(
  overrides:
    & Partial<LocationFixtureRow>
    & Pick<LocationFixtureRow, "storageId" | "locationId">,
): LocationFixtureRow {
  return {
    kind: "directory",
    name: "data",
    accessMode: "single_writer",
    principalId: null,
    principalUsername: null,
    contentEnvelope: null,
    locationServerId: "srv-1",
    provider: "path",
    role: "primary",
    path: null,
    locationOptions: null,
    metadata: null,
    ...overrides,
  };
}

function volumeLocation(
  overrides:
    & Partial<LocationFixtureRow>
    & Pick<LocationFixtureRow, "storageId" | "locationId">,
): LocationFixtureRow {
  return {
    kind: "volume",
    name: "pgdata",
    accessMode: "single_writer",
    principalId: null,
    principalUsername: null,
    contentEnvelope: null,
    locationServerId: "srv-1",
    provider: "docker",
    role: "primary",
    path: null,
    locationOptions: null,
    metadata: null,
    ...overrides,
  };
}

describe("loadStorageMaterial principal path locations", () => {
  const principalId = "01936b3e-aaaa-bbbb-cccc-123456789abc";
  const username = "appuser";
  const storageId = "01936b3e-dddd-eeee-ffff-123456789abc";
  const locationId = "01936b3e-dddd-eeee-ffff-0000000000aa";

  const baseParams = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    serverId: "srv-1",
    serviceIds: [] as string[],
    cloneNamesByServiceId: new Map<string, string[]>(),
    registeredVolumes: [] as const,
  };

  it("derives principal volume path when location path is empty", async () => {
    const db = createStorageMaterialDb({
      locations: [pathLocation({
        storageId,
        locationId,
        principalId,
        principalUsername: username,
      })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(material.length, 1);
    assertEquals(
      material[0]?.sourcePath,
      principalVolumePath(username, storageId),
    );
    assertEquals(material[0]?.locationId, locationId);
    assertEquals(material[0]?.provider, "path");
  });

  it("keeps an explicit location path override", async () => {
    const db = createStorageMaterialDb({
      locations: [pathLocation({
        storageId,
        locationId,
        principalId,
        principalUsername: username,
        path: "/custom/mount",
      })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(material[0]?.sourcePath, "/custom/mount");
  });

  it("leaves non-principal path locations untouched", async () => {
    const db = createStorageMaterialDb({
      locations: [pathLocation({ storageId, locationId })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(material[0]?.sourcePath, undefined);
  });

  it("leaves principal-owned path locations without username unresolved", async () => {
    const db = createStorageMaterialDb({
      locations: [pathLocation({
        storageId,
        locationId,
        principalId,
        principalUsername: null,
      })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(material[0]?.sourcePath, undefined);
  });
});

describe("loadPrincipalMaterial home and shell", () => {
  const principalId = "01936b3e-aaaa-bbbb-cccc-123456789abc";
  const username = "appuser";

  it("emits rows without uid/gid when no override is stored", async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: "/bin/bash" },
    }]);
    const material = await loadPrincipalMaterial(db, [principalId]);
    assertEquals(material.length, 1);
    assertEquals(material[0]?.home, principalHomeDir(username));
    assertEquals(material[0]?.shell, "/bin/bash");
    assertEquals(material[0]?.uid, undefined);
    assertEquals(material[0]?.gid, undefined);
    assertEquals("uid" in (material[0] ?? {}), false);
    assertEquals("gid" in (material[0] ?? {}), false);
  });

  it("defaults shell when options omit it", async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: null,
    }]);
    const material = await loadPrincipalMaterial(db, [principalId]);
    assertEquals(material[0]?.shell, DEFAULT_PRINCIPAL_SHELL);
    assertEquals(material[0]?.home, principalHomeDir(username));
  });

  it("echoes an operator uid/gid override when set", async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: "/bin/bash", uid: 10001, gid: 10001 },
    }]);
    const material = await loadPrincipalMaterial(db, [principalId]);
    assertEquals(material[0]?.uid, 10001);
    assertEquals(material[0]?.gid, 10001);
    assertEquals(material[0]?.home, principalHomeDir(username));
  });

  it("returns an empty list when no principal ids are requested", async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: null,
    }]);
    const material = await loadPrincipalMaterial(db, []);
    assertEquals(material, []);
  });

  it("dedupes principal ids before querying", async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: "/bin/sh" },
    }]);
    const material = await loadPrincipalMaterial(db, [
      principalId,
      principalId,
    ]);
    assertEquals(material.length, 1);
    assertEquals(material[0]?.principalId, principalId);
  });

  it("carries a stored crypt hash and adds the password access group", async () => {
    const passwordHash = `$6$saltstring$${"a".repeat(86)}`;
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: "/bin/bash" },
      password: passwordHash,
    }]);
    const material = await loadPrincipalMaterial(db, [principalId]);
    assertEquals(material[0]?.passwordHash, passwordHash);
    // A password is a credential: the level group resolves even with zero
    // keys, and the password group rides alongside it.
    assertEquals(material[0]?.accessGroups, ["tpshell", "tppasswd"]);
  });

  it("never forwards a password value that is not a crypt hash", async () => {
    // Defence in depth for the column's other tenant: a managed principal's
    // sealed envelope must not reach `chpasswd -e` on a host.
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: "/bin/bash" },
      password: "sealed:v1:AAAA",
    }]);
    const material = await loadPrincipalMaterial(db, [principalId]);
    assertEquals(material[0]?.passwordHash, undefined);
    assertEquals("passwordHash" in (material[0] ?? {}), false);
    assertEquals(material[0]?.accessGroups, []);
  });
});

const EMPTY_COMPOSE = {
  version: 1,
  data: { services: {} },
  presentation: { keyOrder: ["services"], comments: {} },
} as const;

const WEB_COMPOSE = {
  version: 1,
  data: {
    services: {
      web: { image: "nginx:latest" },
    },
  },
  presentation: { keyOrder: ["services"], comments: {} },
} as const;

const WEB_API_COMPOSE = {
  version: 1,
  data: {
    services: {
      web: { image: "nginx:latest" },
      api: { image: "node:22" },
    },
  },
  presentation: { keyOrder: ["services"], comments: {} },
} as const;

describe("extractComposeFromOptions", () => {
  it("returns compose when options is a plain object", () => {
    assertEquals(
      extractComposeFromOptions({ compose: WEB_COMPOSE }),
      WEB_COMPOSE,
    );
  });

  it("returns null for non-objects and missing compose", () => {
    assertEquals(extractComposeFromOptions(null), null);
    assertEquals(extractComposeFromOptions("x"), null);
    assertEquals(extractComposeFromOptions([]), null);
    assertEquals(extractComposeFromOptions({}), null);
  });
});

describe("mergeProjectEnvironmentCompose", () => {
  it("merges environment overlay services onto the project base", () => {
    const merged = mergeProjectEnvironmentCompose(
      { compose: WEB_COMPOSE },
      {
        compose: {
          version: 1,
          data: {
            services: {
              api: { image: "node:22" },
            },
          },
          presentation: { keyOrder: ["services"], comments: {} },
        },
      },
    );
    if (merged instanceof Response) {
      throw new TypeError("expected merged compose document");
    }
    const services = merged.data.services as Record<string, unknown>;
    assertEquals(Object.keys(services).sort((a, b) => a.localeCompare(b)), [
      "api",
      "web",
    ]);
  });

  it("returns 400 when either side is not a compose document", async () => {
    const res = mergeProjectEnvironmentCompose({ compose: "bad" }, {
      compose: EMPTY_COMPOSE,
    });
    if (!(res instanceof Response)) {
      throw new TypeError("expected Response");
    }
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "Invalid compose document" });
  });
});

describe("resolveProjectEnvironmentComposeLayers", () => {
  it("returns project and environment layers with the given filename", () => {
    const layers = resolveProjectEnvironmentComposeLayers(
      { compose: WEB_COMPOSE },
      { compose: EMPTY_COMPOSE },
      "docker-compose.staging.yml",
    );
    if (layers instanceof Response) {
      throw new TypeError("expected layers");
    }
    assertEquals(layers.map((l) => l.role), ["project", "environment"]);
    assertEquals(layers[0]!.filename, "docker-compose.yml");
    assertEquals(layers[1]!.filename, "docker-compose.staging.yml");
  });

  it("returns 400 on invalid documents", async () => {
    const res = resolveProjectEnvironmentComposeLayers(
      { compose: "bad" },
      { compose: EMPTY_COMPOSE },
      "docker-compose.env.yml",
    );
    if (!(res instanceof Response)) {
      throw new TypeError("expected Response");
    }
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "Invalid compose document" });
  });
});

describe("emptyPreparedCompose", () => {
  it("includes a single empty runtime compose file", async () => {
    const prepared = await emptyPreparedCompose([]);
    assertEquals(prepared.composeYaml, "services: {}\n");
    assertEquals(prepared.composeFiles, [
      {
        filename: "compose.yaml",
        role: "runtime",
        source: "inline",
        content: "services: {}\n",
      },
    ]);
  });
});

describe("readHostingProxyFromOptions", () => {
  it("returns undefined for non-object options", () => {
    assertEquals(readHostingProxyFromOptions(null), undefined);
    assertEquals(readHostingProxyFromOptions("x"), undefined);
  });

  it("applies proxy defaults when proxy is omitted", () => {
    assertEquals(readHostingProxyFromOptions({}), {
      forceHttps: true,
      gzip: true,
      brotli: false,
    });
  });

  it("passes through stripPrefix when set", () => {
    assertEquals(
      readHostingProxyFromOptions({
        proxy: {
          forceHttps: false,
          gzip: false,
          brotli: true,
          stripPrefix: "/api",
        },
      }),
      {
        forceHttps: false,
        gzip: false,
        brotli: true,
        stripPrefix: "/api",
      },
    );
  });

  it("ignores a non-object proxy field", () => {
    assertEquals(readHostingProxyFromOptions({ proxy: "nope" }), {
      forceHttps: true,
      gzip: true,
      brotli: false,
    });
  });
});

describe("verifyServerInOrg", () => {
  it("returns true when a matching server row exists", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([{ id: "srv-1" }]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Db;
    assertEquals(await verifyServerInOrg(db, "srv-1", "org-1"), true);
  });

  it("returns false when no matching row exists", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Db;
    assertEquals(await verifyServerInOrg(db, "srv-missing", "org-1"), false);
  });
});

describe("loadStorageMaterial filters, volumes, and fan-out", () => {
  const principalId = "01936b3e-aaaa-bbbb-cccc-123456789abc";
  const username = "appuser";
  const storageId = "01936b3e-dddd-eeee-ffff-123456789abc";
  const locationId = "01936b3e-dddd-eeee-ffff-0000000000aa";
  const volumeStorageId = "01936b3e-1111-2222-3333-123456789abc";
  const volumeLocationId = "01936b3e-1111-2222-3333-0000000000bb";
  const serviceId = "01936b3e-4444-5555-6666-123456789abc";

  const baseParams = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    serverId: "srv-1",
    serviceIds: [] as string[],
    cloneNamesByServiceId: new Map<string, string[]>(),
    registeredVolumes: [] as const,
  };

  it("drops rows for other servers and scratch locations", async () => {
    const db = createStorageMaterialDb({
      locations: [
        pathLocation({
          storageId,
          locationId,
          name: "other-server",
          path: "/x",
          locationServerId: "srv-other",
        }),
        pathLocation({
          storageId: "01936b3e-dddd-eeee-ffff-000000000001",
          locationId: "01936b3e-dddd-eeee-ffff-000000000002",
          name: "scratch",
          role: "scratch",
          path: "/x",
        }),
      ],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(material.length, 0);
  });

  it("keeps docker volumes without mounts and resolves pinned names", async () => {
    const db = createStorageMaterialDb({
      locations: [volumeLocation({
        storageId: volumeStorageId,
        locationId: volumeLocationId,
        metadata: { dockerVolumeName: "custom_vol" },
      })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(material.length, 1);
    assertEquals(material[0]?.kind, "volume");
    assertEquals(material[0]?.provider, "docker");
    assertEquals(material[0]?.mounts, []);
    assertEquals(
      material[0]?.volumeName,
      resolveDockerVolumeName({
        storageId: volumeStorageId,
        pinnedName: "custom_vol",
      }),
    );
  });

  it("falls back to storage id when docker volume metadata has no pin", async () => {
    const db = createStorageMaterialDb({
      locations: [volumeLocation({
        storageId: volumeStorageId,
        locationId: volumeLocationId,
        metadata: { dockerVolumeName: "" },
      })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(
      material[0]?.volumeName,
      dockerVolumeNameFromStorageId(volumeStorageId),
    );
  });

  it("fans mounts out to clone compose names", async () => {
    const db = createStorageMaterialDb({
      locations: [pathLocation({
        storageId,
        locationId,
        path: "/srv/data",
      })],
      mounts: [{
        storageId,
        serviceId,
        composeServiceName: "web",
        destinationPath: "/app/data",
        subpath: null,
        readOnly: false,
      }],
    });
    const material = await loadStorageMaterial(db, {
      ...baseParams,
      serviceIds: [serviceId],
      cloneNamesByServiceId: new Map([[serviceId, ["web-1", "web-2"]]]),
    });
    assertEquals(material.length, 1);
    assertEquals(
      material[0]?.mounts.map((row) => row.composeServiceName),
      ["web-1", "web-2"],
    );
    assertEquals(material[0]?.mounts[0]?.destinationPath, "/app/data");
  });

  it("appends registered volumes that were not already loaded", async () => {
    const seenId = volumeStorageId;
    const unseenId = "01936b3e-7777-8888-9999-123456789abc";
    const unseenLocationId = "01936b3e-7777-8888-9999-0000000000cc";
    const db = createStorageMaterialDb({
      locations: [volumeLocation({
        storageId: seenId,
        locationId: volumeLocationId,
        name: "already",
      })],
    });
    const material = await loadStorageMaterial(db, {
      ...baseParams,
      registeredVolumes: [
        {
          storageId: seenId,
          locationId: volumeLocationId,
          composeKey: "already",
          volumeName: seenId,
          managed: true,
        },
        {
          storageId: unseenId,
          locationId: unseenLocationId,
          composeKey: "extra",
          volumeName: unseenId,
          managed: true,
        },
      ],
    });
    assertEquals(material.length, 2);
    assertEquals(material[1]?.storageId, unseenId);
    assertEquals(material[1]?.locationId, unseenLocationId);
    assertEquals(material[1]?.name, "extra");
    assertEquals(material[1]?.volumeName, unseenId);
    assertEquals(material[1]?.kind, "volume");
  });

  it("carries contentEnvelope and treats empty path as unset for principals", async () => {
    const db = createStorageMaterialDb({
      locations: [pathLocation({
        storageId,
        locationId,
        principalId,
        principalUsername: username,
        path: "",
        contentEnvelope: "tp1.sealed.example",
      })],
    });
    const material = await loadStorageMaterial(db, baseParams);
    assertEquals(
      material[0]?.sourcePath,
      principalVolumePath(username, storageId),
    );
    assertEquals(material[0]?.contentEnvelope, "tp1.sealed.example");
    assertEquals(material[0]?.principalId, principalId);
  });
});

describe("resolveHostingBindAddress edge cases", () => {
  it("throws when the pinned public ip row is missing", async () => {
    const db = createIpLookupDb([]);
    await assertRejects(
      () =>
        resolveHostingBindAddress(db, {
          serverId: "srv-1",
          options: { bind: "public" },
          ipId: "missing-ip",
        }),
      Error,
      "not found",
    );
  });

  it("throws when the pinned public address is invalid", async () => {
    const db = createIpLookupDb([{
      id: "ip-1",
      address: "not-an-ip",
      serverId: "srv-1",
      scope: "public",
    }]);
    await assertRejects(
      () =>
        resolveHostingBindAddress(db, {
          serverId: "srv-1",
          options: { bind: "public" },
          ipId: "ip-1",
        }),
      Error,
      "address invalid",
    );
  });

  it("trims a valid public address", async () => {
    const db = createIpLookupDb([{
      id: "ip-1",
      address: "  203.0.113.20  ",
      serverId: "srv-1",
      scope: "public",
    }]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: { bind: "public" },
      ipId: "ip-1",
    });
    assertEquals(result, "203.0.113.20");
  });

  it("allows a public pin with null serverId", async () => {
    const db = createIpLookupDb([{
      id: "ip-1",
      address: "203.0.113.30",
      serverId: null,
      scope: "public",
    }]);
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: { bind: "public" },
      ipId: "ip-1",
    });
    assertEquals(result, "203.0.113.30");
  });

  it("treats a non-string datacenter address as missing", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return {
                      limit() {
                        return Promise.resolve([{ address: 10 }]);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof resolveHostingBindAddress>[0];
    const result = await resolveHostingBindAddress(db, {
      serverId: "srv-1",
      options: { bind: "datacenter" },
      ipId: null,
    });
    assertEquals(result, {
      kind: "datacenter_ip_required",
      serverId: "srv-1",
    });
  });
});

describe("attachPrincipalsToSites", () => {
  const principalId = "01936b3e-aaaa-bbbb-cccc-123456789abc";
  const serviceId = "01936b3e-4444-5555-6666-123456789abc";
  const site: SiteSpec = {
    composeServiceName: "site",
    engine: "nginx",
    root: "public",
    listenPort: 18080,
  };

  it("returns an empty list when there are no sites", async () => {
    const db = createSelectWhereDb([]);
    const result = await attachPrincipalsToSites(
      db,
      "env-1",
      [],
      [],
      [],
    );
    assertEquals(result, []);
  });

  it("pins a sole assigned principal onto the site", async () => {
    const db = createSelectWhereDb([
      { principalId, serviceId },
    ]);
    const result = await attachPrincipalsToSites(
      db,
      "env-1",
      [{ id: serviceId, composeServiceName: "site" }],
      [{
        principalId,
        username: "appuser",
        home: principalHomeDir("appuser"),
        shell: "/bin/bash",
        uid: 10001,
        gid: 10001,
      }],
      [site],
    );
    if ("kind" in result) {
      throw new TypeError("expected pinned sites");
    }
    assertEquals(result.length, 1);
    assertEquals(result[0]?.principal, {
      principalId,
      username: "appuser",
      uid: 10001,
      gid: 10001,
    });
  });

  it("omits principal when none are assigned", async () => {
    const db = createSelectWhereDb([]);
    const result = await attachPrincipalsToSites(
      db,
      "env-1",
      [{ id: serviceId, composeServiceName: "site" }],
      [],
      [site],
    );
    if ("kind" in result) {
      throw new TypeError("expected sites without principal");
    }
    assertEquals(result[0]?.principal, undefined);
  });

  it("returns ambiguous when more than one principal is assigned", async () => {
    const db = createSelectWhereDb([
      { principalId, serviceId },
      { principalId: "01936b3e-bbbb-cccc-dddd-123456789abc", serviceId },
    ]);
    const result = await attachPrincipalsToSites(
      db,
      "env-1",
      [{ id: serviceId, composeServiceName: "site" }],
      [],
      [site],
    );
    assertEquals(result, {
      kind: "site_principal_ambiguous",
      composeServiceName: "site",
    });
  });
});

describe("warningFromPrepareError and soft-error absorb", () => {
  it("maps every soft prepare error kind to a warning", () => {
    assertEquals(warningFromPrepareError({ kind: "empty_compose" }), {
      code: "empty_compose",
      message: "Compose has no services to deploy.",
    });
    assertEquals(
      warningFromPrepareError({
        kind: "resource_limit",
        violations: [{
          scope: "organization",
          field: "maxCpus",
          limit: 1,
          requested: 2,
        }],
      }).code,
      "resource_limit_exceeded",
    );
    assertEquals(
      warningFromPrepareError({
        kind: "health_check",
        required: true,
        services: ["web"],
      }).message.includes("require"),
      true,
    );
    assertEquals(
      warningFromPrepareError({
        kind: "health_check",
        required: false,
        services: ["web"],
      }).message.includes("warn"),
      true,
    );
    assertEquals(
      warningFromPrepareError({
        kind: "docker_external_network_unregistered",
        names: ["edge"],
      }).details,
      { names: ["edge"] },
    );
    assertEquals(
      warningFromPrepareError({
        kind: "site_principal_ambiguous",
        composeServiceName: "site",
      }).code,
      "site_principal_ambiguous",
    );
    assertEquals(
      warningFromPrepareError({ kind: "binding_endpoint_unavailable" }),
      {
        code: "binding_endpoint_unavailable",
        message:
          "A service binding could not resolve a ProxySQL listener for its managed cluster.",
      },
    );
    assertEquals(
      warningFromPrepareError({
        kind: "site_managed_directory_unowned",
        composeServiceName: "uploads",
      }).code,
      "site_managed_directory_unowned",
    );
    assertEquals(
      warningFromPrepareError({
        kind: "site_cron_unowned",
        composeServiceName: "cron-site",
      }).code,
      "site_cron_unowned",
    );
    assertEquals(
      warningFromPrepareError({
        kind: "source_principal_ambiguous",
        composeServiceName: "git-app",
      }).code,
      "source_principal_ambiguous",
    );
  });

  it("absorbs soft errors only in preview mode", () => {
    const warnings: ReturnType<typeof warningFromPrepareError>[] = [];
    assertEquals(
      absorbSoftPrepareError("deploy", warnings, { kind: "empty_compose" }),
      { kind: "empty_compose" },
    );
    assertEquals(warnings.length, 0);
    assertEquals(
      absorbSoftPrepareError("preview", warnings, { kind: "empty_compose" }),
      null,
    );
    assertEquals(warnings.length, 1);
    assertEquals(absorbSoftPrepareError("preview", warnings, null), null);
    assertEquals(absorbSoftPrepareError("deploy", warnings, null), null);
  });

  it("emptyComposePrepareResult differs by mode", async () => {
    assertEquals(await emptyComposePrepareResult("deploy"), {
      kind: "empty_compose",
    });
    const preview = await emptyComposePrepareResult("preview");
    if (!preview || typeof preview !== "object" || !("warnings" in preview)) {
      throw new TypeError("expected prepared compose");
    }
    assertEquals(preview.warnings[0]?.code, "empty_compose");
    assertEquals(preview.composeYaml, "services: {}\n");
    assertEquals(preview.composeFiles[0]?.role, "runtime");
    assertEquals(preview.composeFiles[0]?.content, "services: {}\n");
  });
});

describe("evaluateHealthCheckGates and resourceLimitPrepareError", () => {
  const webDoc = assertComposeDocument(WEB_COMPOSE);

  it("returns required health_check when policy is required", () => {
    const options = buildServiceOptionsMap([
      {
        composeServiceName: "web",
        options: { healthCheck: { policy: "required" } },
      },
    ]);
    assertEquals(evaluateHealthCheckGates(webDoc, options, false), {
      kind: "health_check",
      required: true,
      services: ["web"],
    });
  });

  it("returns warn health_check unless acknowledged", () => {
    const options = buildServiceOptionsMap([
      {
        composeServiceName: "web",
        options: { healthCheck: { policy: "warn" } },
      },
    ]);
    assertEquals(evaluateHealthCheckGates(webDoc, options, false), {
      kind: "health_check",
      required: false,
      services: ["web"],
    });
    assertEquals(evaluateHealthCheckGates(webDoc, options, true), null);
  });

  it("returns resource_limit when org max services is exceeded", () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: "web", options: {} },
      { composeServiceName: "api", options: {} },
    ]);
    const err = resourceLimitPrepareError(
      options,
      2,
      { resourceLimits: { maxServicesPerEnvironment: 1 } },
      {},
    );
    if (!err || err.kind !== "resource_limit") {
      throw new TypeError("expected resource_limit error");
    }
    assertEquals(err.violations.length > 0, true);
  });

  it("returns null when limits are satisfied", () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: "web", options: {} },
    ]);
    assertEquals(
      resourceLimitPrepareError(options, 1, {
        resourceLimits: { maxServicesPerEnvironment: 5 },
      }, {}),
      null,
    );
  });
});

describe("nativeAppServicesForDeploy", () => {
  it("passes appMode, enabled, and startupFile through for a disabled app", () => {
    const prepared = nativeAppServicesForDeploy(
      [{
        composeServiceName: "web",
        framework: "auto" as const,
        listenPort: 18100,
        nodeVersion: "24",
        appMode: "development" as const,
        enabled: false,
        startupFile: "app.js",
      }],
      buildServiceOptionsMap([]),
      {},
      {},
    );
    // The disabled app is still emitted — the daemon stops and disables the
    // unit instead of starting it; dropping the row would strand the release.
    assertEquals(prepared, [{
      composeServiceName: "web",
      listenPort: 18100,
      framework: "auto",
      nodeVersion: "24",
      appMode: "development",
      enabled: false,
      startupFile: "app.js",
    }]);
  });

  it("leaves undeclared node app settings absent", () => {
    const prepared = nativeAppServicesForDeploy(
      [{
        composeServiceName: "web",
        framework: "auto" as const,
        listenPort: 18100,
      }],
      buildServiceOptionsMap([]),
      {},
      {},
    );
    assertEquals(prepared, [{
      composeServiceName: "web",
      listenPort: 18100,
      framework: "auto",
    }]);
  });
});

describe("compose list/split/expansion helpers", () => {
  it("lists compose service keys and container names", () => {
    const mixed = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: "nginx:latest" },
          site: {
            "x-turbopanel": {
              serviceKind: "site",
              engine: "nginx",
            },
          },
        },
      },
      presentation: { keyOrder: ["services"], comments: {} },
    });
    assertEquals(
      listComposeServiceKeys(mixed).sort((a, b) => a.localeCompare(b)),
      ["site", "web"],
    );
    assertEquals([...listContainerComposeNames(mixed)], ["web"]);
    assertEquals(
      listComposeServiceKeys(assertComposeDocument(EMPTY_COMPOSE)),
      [],
    );
  });

  it("splits sites and empties compose when only sites remain", () => {
    const sitesOnly = assertComposeDocument({
      version: 1,
      data: {
        services: {
          site: {
            "x-turbopanel": {
              serviceKind: "site",
              engine: "apache",
              root: "html",
            },
          },
        },
        networks: {
          internal: {},
        },
      },
      presentation: { keyOrder: ["services", "networks"], comments: {} },
    });
    const split = splitHostNativeFromDocument(sitesOnly);
    assertEquals(split.composeYaml, "services: {}\n");
    assertEquals(split.sites.length, 1);
    assertEquals(split.sites[0]?.engine, "apache");
    assertEquals(split.sites[0]?.root, "html");
  });

  it("keeps container services and prunes networks only used by site", () => {
    const mixed = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: {
            image: "nginx:latest",
            networks: ["shared"],
          },
          site: {
            "x-turbopanel": {
              serviceKind: "site",
              engine: "nginx",
            },
            networks: ["tw-only"],
          },
        },
        networks: {
          shared: {},
          "tw-only": {},
        },
      },
      presentation: { keyOrder: ["services", "networks"], comments: {} },
    });
    const split = splitHostNativeFromDocument(mixed);
    assertEquals(split.composeYaml.includes("nginx:latest"), true);
    assertEquals(split.composeYaml.includes("site"), false);
    assertEquals(split.composeYaml.includes("tw-only"), false);
    assertEquals(split.composeYaml.includes("shared"), true);
    assertEquals(split.sites[0]?.composeServiceName, "site");
  });

  it("builds expansion maps and clone name indexes", () => {
    const serviceRows = [
      { id: "svc-web", composeServiceName: "web", options: { instances: 2 } },
      { id: "svc-api", composeServiceName: "api", options: {} },
    ];
    const expansion = new Map([
      ["web", ["web-1", "web-2"]],
      ["api", ["api"]],
    ]);
    assertEquals(expansionToRecord(expansion), {
      web: ["web-1", "web-2"],
      api: ["api"],
    });
    assertEquals(
      buildCloneNamesByServiceId(serviceRows, expansion).get("svc-web"),
      ["web-1", "web-2"],
    );
    assertEquals(
      buildServiceRowByCloneName(serviceRows, expansion).get("web-2")?.id,
      "svc-web",
    );

    const options = buildExpandedServiceOptionsMap(
      serviceRows,
      expansion,
    );
    assertEquals(options.get("web-1"), options.get("web-2"));
    assertEquals(options.has("web-1"), true);

    const instances = buildInstancesByComposeName(
      ["web", "api", "site"],
      [{
        serviceId: "svc-web",
        composeServiceName: "web",
        instances: 2,
      }],
      [
        ...serviceRows,
        { id: "svc-site", composeServiceName: "site", options: {} },
      ],
    );
    assertEquals(instances.get("web"), 2);
    assertEquals(instances.get("api"), 1);
    assertEquals(instances.get("site"), 1);
  });

  it("strips reserved keys without injecting platform variables", () => {
    const perService = new Map([
      ["web", [{
        key: "TURBOPANEL_PROJECT_ID",
        value: "stolen",
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }, {
        key: "APP_ENV",
        value: "prod",
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }]],
    ]);
    const next = stripReservedKeysFromEntries(perService);
    const keys = (next.get("web") ?? []).map((entry) => entry.key);
    assertEquals(keys, ["APP_ENV"]);
  });
});

describe("resolveSitesForMode and toPreparedDeployResult", () => {
  // The compose-authored shape (php is an authored block here) and the wire
  // shape (php already validated and rendered) are deliberately different
  // types now, so the fixture is spelled once per side.
  const site: SiteSpec = {
    composeServiceName: "site",
    engine: "nginx",
    root: "public",
    listenPort: 18080,
  };
  const wireSite: EnvironmentDeploySite = {
    composeServiceName: "site",
    engine: "nginx",
    root: "public",
    listenPort: 18080,
  };

  it("returns sites in deploy mode and softens ambiguous in preview", () => {
    const warnings: ReturnType<typeof warningFromPrepareError>[] = [];
    const ok = resolveSitesForMode(
      "deploy",
      warnings,
      [{ ...wireSite }],
      [site],
    );
    assertEquals(ok, [{ ...wireSite }]);

    const err = resolveSitesForMode(
      "deploy",
      warnings,
      {
        kind: "site_principal_ambiguous",
        composeServiceName: "site",
      },
      [site],
    );
    assertEquals(err, {
      kind: "site_principal_ambiguous",
      composeServiceName: "site",
    });

    const preview = resolveSitesForMode(
      "preview",
      warnings,
      {
        kind: "site_principal_ambiguous",
        composeServiceName: "site",
      },
      [site],
    );
    assertEquals(preview, [{ ...wireSite }]);
    assertEquals(warnings[0]?.code, "site_principal_ambiguous");
  });

  it("redacts secret materials in preview prepared results", async () => {
    const expansion = new Map([["web", ["web"]]]);
    const prepared = await toPreparedDeployResult("preview", {
      composeYaml: "services: {}\n",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        source: "inline",
        content: "services: {}\n",
      }],
      hooks: [],
      variableMaterial: [{
        key: "SECRET",
        composeServiceName: "web",
        forBuild: false,
        forRuntime: true,
        isLiteral: false,
        valueEnvelope: "tp1.sealed",
      }],
      storageMaterial: [{
        storageId: "st-1",
        locationId: "loc-1",
        kind: "volume",
        name: "data",
        provider: "docker",
        serverId: "srv-1",
        volumeName: "st-1",
        mounts: [],
      }],
      principalMaterial: [],
      sites: [],
      nativeAppServices: [],
      sourceMaterial: [],
      dockerExternalNetworks: [],
      managedNetworkServices: [],
      containers: [],
      ingressServices: [],
      expansion,
      registeredVolumes: [],
      warnings: [],
      replicaCounts: {},
    });
    assertEquals(prepared.variableMaterial, []);
    assertEquals(prepared.storageMaterial, []);
    assertEquals(prepared.composeServiceExpansion, { web: ["web"] });
    assertEquals(prepared.composeFiles.length, 1);
  });

  it("keeps materials for deploy mode", async () => {
    const prepared = await toPreparedDeployResult("deploy", {
      composeYaml: "services: {}\n",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services: {}\n",
      }],
      hooks: [],
      variableMaterial: [{
        key: "SECRET",
        composeServiceName: null,
        forBuild: false,
        forRuntime: true,
        isLiteral: false,
        valueEnvelope: "tp1.sealed",
      }],
      storageMaterial: [{
        storageId: "st-1",
        locationId: "loc-1",
        kind: "volume",
        name: "data",
        provider: "docker",
        serverId: "srv-1",
        volumeName: "st-1",
        mounts: [],
      }],
      principalMaterial: [],
      sites: [],
      nativeAppServices: [],
      sourceMaterial: [],
      dockerExternalNetworks: ["edge"],
      managedNetworkServices: [],
      containers: [],
      ingressServices: [],
      expansion: new Map(),
      registeredVolumes: [],
      warnings: [],
      replicaCounts: {},
    });
    assertEquals(prepared.variableMaterial.length, 1);
    assertEquals(prepared.storageMaterial.length, 1);
    assertEquals(prepared.dockerExternalNetworks, ["edge"]);
  });

  it("injects secret placeholders only in preview documentForServiceOptions", () => {
    const doc = assertComposeDocument(WEB_COMPOSE);
    const withVariables = {
      document: doc,
      secretMaterial: [{
        key: "DB_PASSWORD",
        composeServiceName: "web",
        forBuild: false,
        forRuntime: true,
        isLiteral: false,
        valueEnvelope: "tp1.envelope",
      }],
    };
    const previewDoc = documentForServiceOptions("preview", withVariables);
    const deployDoc = documentForServiceOptions("deploy", withVariables);
    assertEquals(deployDoc, doc);
    assertEquals(previewDoc, doc);
  });

  it("redacts binding secrets in preview the same as ordinary secret variables", async () => {
    // Binding materialization seals secrets as tpsecret. and parks them on
    // secretMaterial alongside user variables; preview must drop
    // variableMaterial and never leave envelopes in the YAML path.
    const prepared = await toPreparedDeployResult("preview", {
      composeYaml:
        "services:\n  web:\n    environment:\n      DATABASE_URL: sealed\n",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content:
          "services:\n  web:\n    environment:\n      DATABASE_URL: sealed\n",
      }],
      hooks: [],
      variableMaterial: [
        {
          key: "DATABASE_URL",
          composeServiceName: "web",
          forBuild: false,
          forRuntime: true,
          isLiteral: true,
          valueEnvelope: "tpsecret.binding-url",
        },
        {
          key: "DATABASE_PASSWORD",
          composeServiceName: "web",
          forBuild: false,
          forRuntime: true,
          isLiteral: true,
          valueEnvelope: "tpsecret.binding-password",
        },
      ],
      storageMaterial: [],
      principalMaterial: [],
      sites: [],
      nativeAppServices: [],
      sourceMaterial: [],
      dockerExternalNetworks: [],
      managedNetworkServices: [],
      containers: [],
      ingressServices: [],
      expansion: new Map([["web", ["web"]]]),
      registeredVolumes: [],
      warnings: [],
      replicaCounts: {},
    });
    assertEquals(prepared.variableMaterial, []);
    assertEquals(prepared.composeYaml.includes("tpsecret.binding"), false);
  });
});

describe("resourceLimitPrepareError server scope", () => {
  it("returns null when server limits are unset", () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: "web", options: { resources: { cpus: 0.5 } } },
    ]);
    assertEquals(
      resourceLimitPrepareError(options, 1, {}, {}),
      null,
    );
  });

  it("violates server maxCpus when usage exceeds server cap", () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: "web", options: { resources: { cpus: 4 } } },
    ]);
    const err = resourceLimitPrepareError(
      options,
      1,
      {},
      { resourceLimits: { maxCpus: 2 } },
    );
    if (!err || err.kind !== "resource_limit") {
      throw new TypeError("expected resource_limit error");
    }
    assertEquals(
      err.violations.some((v) => v.scope === "server" && v.field === "maxCpus"),
      true,
    );
  });
});

describe("stripReservedKeysFromEntries without service row", () => {
  it("strips reserved keys for clones that have no service row", () => {
    const perService = new Map([
      ["orphan", [{
        key: "TURBOPANEL_ENVIRONMENT_ID",
        value: "stolen-env",
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }, {
        key: "CUSTOM",
        value: "ok",
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }]],
    ]);
    const next = stripReservedKeysFromEntries(perService);
    const keys = (next.get("orphan") ?? []).map((entry) => entry.key);
    assertEquals(keys, ["CUSTOM"]);
  });
});

describe("attachPrincipalsToSites edge cases", () => {
  const site: SiteSpec = {
    composeServiceName: "site",
    engine: "nginx",
    root: "public",
    listenPort: 18080,
  };
  const serviceId = "01936b3e-4444-5555-6666-123456789abc";
  const principalId = "01936b3e-aaaa-bbbb-cccc-123456789abc";

  it("omits principal when assigned id is missing from material map", async () => {
    const db = createSelectWhereDb([{ principalId, serviceId }]);
    const result = await attachPrincipalsToSites(
      db,
      "env-1",
      [{ id: serviceId, composeServiceName: "site" }],
      [],
      [site],
    );
    if ("kind" in result) {
      throw new TypeError("expected sites without principal pin");
    }
    assertEquals(result[0]?.principal, undefined);
  });

  it("handles site with no matching service row", async () => {
    const db = createSelectWhereDb([]);
    const result = await attachPrincipalsToSites(
      db,
      "env-1",
      [],
      [],
      [site],
    );
    if ("kind" in result) {
      throw new TypeError("expected sites");
    }
    assertEquals(result[0]?.composeServiceName, "site");
    assertEquals(result[0]?.principal, undefined);
  });
});

describe("splitHostNativeFromDocument without networks key", () => {
  it("keeps container yaml when site is absent", () => {
    const doc = assertComposeDocument(WEB_API_COMPOSE);
    const split = splitHostNativeFromDocument(doc);
    assertEquals(split.sites.length, 0);
    assertEquals(split.composeYaml.includes("nginx:latest"), true);
    assertEquals(split.composeYaml.includes("node:22"), true);
    assertEquals(split.composeYaml.includes("networks:"), false);
  });
});

describe("toApplyVariablesPrepareError", () => {
  it("copies optional fields on unresolved refs", () => {
    assertEquals(
      toApplyVariablesPrepareError({
        kind: "variable_unresolved",
        message: "missing KEY",
        ref: "{$KEY}",
        composeServiceName: "web",
        envKey: "KEY",
      }),
      {
        kind: "variable_unresolved",
        message: "missing KEY",
        ref: "{$KEY}",
        composeServiceName: "web",
        envKey: "KEY",
      },
    );
  });

  it("omits absent optional fields", () => {
    assertEquals(
      toApplyVariablesPrepareError({
        kind: "variable_ref_invalid",
        message: "bad ref",
      }),
      {
        kind: "variable_ref_invalid",
        message: "bad ref",
      },
    );
  });

  it("copies optional fields on secret interpolation", () => {
    assertEquals(
      toApplyVariablesPrepareError({
        kind: "variable_secret_interpolation",
        message: "secret in YAML",
        composeServiceName: "web",
        envKey: "SECRET",
      }),
      {
        kind: "variable_secret_interpolation",
        message: "secret in YAML",
        composeServiceName: "web",
        envKey: "SECRET",
      },
    );
  });

  it("omits absent optional fields on unresolved refs", () => {
    assertEquals(
      toApplyVariablesPrepareError({
        kind: "variable_unresolved",
        message: "missing KEY",
      }),
      {
        kind: "variable_unresolved",
        message: "missing KEY",
      },
    );
  });
});

describe("compileRuntimeOptionsForServer", () => {
  const localReplicaCounts = new Map([["web", 1]]);

  it("returns environment and replica counts without a schedule", () => {
    assertEquals(
      compileRuntimeOptionsForServer("env-1", { localReplicaCounts }),
      {
        environmentId: "env-1",
        localReplicaCounts,
      },
    );
  });

  it("copies local names without a schedule", () => {
    const localServiceNames = new Set(["web"]);
    const options = compileRuntimeOptionsForServer("env-1", {
      localReplicaCounts,
      localServiceNames,
    });
    assertEquals(options.localServiceNames, localServiceNames);
    assertEquals(options.spanningNetworks, undefined);
  });

  it("copies local names and schedule attachments", () => {
    const localServiceNames = new Set(["web"]);
    const spanningNetworks = new Map([["app", "tpn_app"]]);
    const taskAddresses = new Map([["web", new Map([[1, "203.0.113.4"]])]]);
    const spanningHosts = new Map([["web", {
      primary: "web",
      replicas: new Map<number, string>(),
      networks: new Set(["app"]),
    }]]);
    const managedIngressHostsByService = new Map([["api", [{
      name: "db-in",
      address: "203.0.113.5",
    }]]]);
    const options = compileRuntimeOptionsForServer(
      "env-1",
      { localReplicaCounts, localServiceNames },
      {
        serverId: "srv-1",
        slots: [],
        serviceIdToName: new Map(),
        spanningNetworks,
        taskAddresses,
        spanningHosts,
        managedIngressHostsByService,
      },
    );
    assertEquals(options.localServiceNames, localServiceNames);
    assertEquals(options.spanningNetworks, spanningNetworks);
    assertEquals(options.taskAddressesByService, taskAddresses);
    assertEquals(options.spanningHostsByService, spanningHosts);
    assertEquals(
      options.managedIngressHostsByService,
      managedIngressHostsByService,
    );
  });

  it("omits an empty managed-ingress host map", () => {
    const options = compileRuntimeOptionsForServer(
      "env-1",
      { localReplicaCounts },
      {
        serverId: "srv-1",
        slots: [],
        serviceIdToName: new Map(),
        managedIngressHostsByService: new Map(),
      },
    );
    assertEquals(options.managedIngressHostsByService, undefined);
  });
});

describe("sitesOnScheduledServer", () => {
  const sites = [
    { composeServiceName: "web" },
    { composeServiceName: "api" },
  ];

  it("returns every site when the server is not sliced", () => {
    assertEquals(sitesOnScheduledServer(sites), sites);
  });

  it("keeps only sites local to the scheduled server", () => {
    assertEquals(
      sitesOnScheduledServer(sites, new Set(["api"])),
      [{ composeServiceName: "api" }],
    );
  });
});

describe("healthCheckAcknowledge", () => {
  it("forces preview to skip the acknowledge flag", () => {
    assertEquals(healthCheckAcknowledge("preview", true), false);
  });

  it("passes the deploy-mode flag through", () => {
    assertEquals(healthCheckAcknowledge("deploy", true), true);
    assertEquals(healthCheckAcknowledge("deploy"), undefined);
  });
});

describe("findUnavailableStorageCopy", () => {
  /**
   * Drizzle-shaped double: every builder method returns the same chain, and
   * each `await` consumes the next queued result set.
   */
  function fakeDb(resultSets: unknown[][]): Db {
    const queue = [...resultSets];
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const promise = Promise.resolve(queue.shift() ?? []);
            return promise.then.bind(promise);
          }
          if (prop === "catch" || prop === "finally") return undefined;
          return () => chain;
        },
      },
    );
    return chain as Db;
  }

  function locationRow(
    overrides: {
      storageId?: string;
      storageName?: string;
      accessMode?: string;
      serviceId?: string;
      locationServerId?: string | null;
      locationRole?: string;
    } = {},
  ) {
    return {
      storageId: overrides.storageId ?? "st-1",
      storageName: overrides.storageName ?? "data",
      accessMode: overrides.accessMode ?? "single_writer",
      serviceId: overrides.serviceId ?? "svc-1",
      locationServerId: overrides.locationServerId === undefined
        ? "srv-scheduled"
        : overrides.locationServerId,
      locationRole: overrides.locationRole ?? "replica",
    };
  }

  it("returns null when no services are scheduled", async () => {
    assertEquals(
      await findUnavailableStorageCopy(fakeDb([[locationRow()]]), {
        environmentId: "env-1",
        scheduledServerId: "srv-scheduled",
        serviceIds: [],
      }),
      null,
    );
  });

  it("returns null when a location is usable on the scheduled server", async () => {
    assertEquals(
      await findUnavailableStorageCopy(fakeDb([[locationRow()]]), {
        environmentId: "env-1",
        scheduledServerId: "srv-scheduled",
        serviceIds: ["svc-1"],
      }),
      null,
    );
  });

  it("treats an unpinned location as usable on any server", async () => {
    assertEquals(
      await findUnavailableStorageCopy(
        fakeDb([[locationRow({ locationServerId: null })]]),
        {
          environmentId: "env-1",
          scheduledServerId: "srv-scheduled",
          serviceIds: ["svc-1"],
        },
      ),
      null,
    );
  });

  it("ignores scratch locations when deciding usability", async () => {
    const result = await findUnavailableStorageCopy(
      fakeDb([[
        locationRow({ locationRole: "scratch", locationServerId: "srv-scheduled" }),
      ]]),
      {
        environmentId: "env-1",
        scheduledServerId: "srv-scheduled",
        serviceIds: ["svc-1"],
      },
    );
    if (!result || result.kind !== "storage_location_unavailable") {
      throw new TypeError("expected storage_location_unavailable");
    }
    assertEquals(result.storageId, "st-1");
    assertEquals(result.primaryServerId, null);
  });

  it("stamps primaryServerId from the primary location row", async () => {
    const result = await findUnavailableStorageCopy(
      fakeDb([[
        locationRow({
          locationRole: "primary",
          locationServerId: "srv-primary",
        }),
      ]]),
      {
        environmentId: "env-1",
        scheduledServerId: "srv-scheduled",
        serviceIds: ["svc-1"],
      },
    );
    if (!result || result.kind !== "storage_location_unavailable") {
      throw new TypeError("expected storage_location_unavailable");
    }
    assertEquals(result.primaryServerId, "srv-primary");
    assertEquals(result.scheduledServerId, "srv-scheduled");
    assertEquals(result.storageName, "data");
    assertEquals(result.accessMode, "single_writer");
    assertEquals(result.serviceId, "svc-1");
  });

  it("returns the first unusable storage when another is usable", async () => {
    const result = await findUnavailableStorageCopy(
      fakeDb([[
        locationRow({ storageId: "st-ok", storageName: "ok" }),
        locationRow({
          storageId: "st-bad",
          storageName: "bad",
          locationServerId: "srv-other",
        }),
      ]]),
      {
        environmentId: "env-1",
        scheduledServerId: "srv-scheduled",
        serviceIds: ["svc-1"],
      },
    );
    if (!result || result.kind !== "storage_location_unavailable") {
      throw new TypeError("expected first unusable storage");
    }
    assertEquals(result.storageId, "st-bad");
    assertEquals(result.storageName, "bad");
  });

  it("marks a storage usable when any non-scratch location matches", async () => {
    assertEquals(
      await findUnavailableStorageCopy(
        fakeDb([[
          locationRow({ locationServerId: "srv-other" }),
          locationRow({ locationServerId: "srv-scheduled" }),
        ]]),
        {
          environmentId: "env-1",
          scheduledServerId: "srv-scheduled",
          serviceIds: ["svc-1"],
        },
      ),
      null,
    );
  });
});

describe("fabricNetworksFromSchedule", () => {
  it("returns an empty list without a schedule", () => {
    assertEquals(fabricNetworksFromSchedule(), []);
  });

  it("copies fabric networks from the schedule", () => {
    const fabricNetworks = [{
      name: "tpn_app",
      subnet: "203.0.113.0/24",
    }];
    assertEquals(
      fabricNetworksFromSchedule({
        serverId: "srv-1",
        slots: [],
        serviceIdToName: new Map(),
        fabricNetworks,
      }),
      fabricNetworks,
    );
  });
});
