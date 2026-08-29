/**
 * Coverage for managed ProxySQL ingress reconcile pure helpers, plus
 * DB-gated regression tests for the bind-address decision made by
 * {@link buildManagedIngressReconcilePayload} (Comment 2: disabled exposure
 * must never translate into a public ProxySQL publish, and enabled exposure
 * must publish only the intended address).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { eq, inArray } from "drizzle-orm";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "../authn/secrets.ts";
import { attachDaemonStateToServer } from "../../daemon/authn/server-identity-db.ts";
import {
  binding,
  command,
  container,
  datacenter,
  environment,
  ip,
  leaf,
  managed,
  network,
  replica,
  organization,
  principal,
  project,
  server,
  service,
  slot,
  tls,
  workspace,
} from "../../lib/db/schema.ts";
import { postgresEngineSpec } from "../../lib/managed/postgres.ts";
import type { ManagedSettings } from "../../lib/managed/settings.ts";
import { createManagedPrincipal } from "../principals/store.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import { ensureManagedContainerAllocation } from "./allocate-managed-container.ts";
import {
  buildManagedIngressReconcilePayload,
  collectProxySqlListenerSans,
  hostgroupsForClusterIndex,
  loadBoundManagedIdsForServer,
  runManagedIngressOrphanSweep,
  unionExposureScopes,
} from "./ingress-desired.ts";
import { ensureManagedIngressHierarchy } from "../system/hierarchy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const dbUrl = getDatabaseUrl();

type ExposureInput = ManagedSettings["exposure"];

function exposureSettings(exposure: ExposureInput): ManagedSettings {
  const parsed = postgresEngineSpec.parseSettings({ exposure });
  if (!parsed) throw new TypeError("expected valid managed settings");
  return parsed;
}

async function testEncryptionContext() {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  return { secretsConfig, dataEncryptionSecrets };
}

/**
 * One org/server/managed-cluster fixture with a single primary member on
 * `serverId`, sealed root principal, and org CA/daemon-key prerequisites for
 * {@link buildManagedIngressReconcilePayload}. Isolated per test (own server)
 * so `unionExposureBind` never mixes exposure across unrelated clusters.
 */
async function withSingleClusterIngressFixture(
  exposure: ExposureInput,
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    serverId: string;
    organizationId: string;
    secretsConfig: Awaited<
      ReturnType<typeof testEncryptionContext>
    >["secretsConfig"];
    dataEncryptionSecrets: Awaited<
      ReturnType<typeof testEncryptionContext>
    >["dataEncryptionSecrets"];
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping ingress-desired bind-address tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const { secretsConfig, dataEncryptionSecrets } =
    await testEncryptionContext();
  const db = createDenoDb();

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Ingress Desired Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: "Ingress Desired Workspace", organizationId })
    .returning({ id: workspace.id });
  const workspaceId = insertedWorkspace!.id;

  const now = new Date().toISOString();
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Ingress Desired Server",
      createdAt: now,
      updatedAt: now,
      isConnected: true,
      statusChangedAt: now,
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  await attachDaemonStateToServer(db, serverId, {
    publicJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: `ingress-desired-key-${serverId}`,
    },
    fingerprint: `ingress-desired-fp-${serverId}`,
  });

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: "Ingress Desired Project",
      workspaceId,
      metadata: { type: "managed", code: "postgres" },
    })
    .returning({ id: project.id });
  const projectId = insertedProject!.id;

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: "Production",
      projectId,
      serverId,
    })
    .returning({ id: environment.id });
  const environmentId = insertedEnvironment!.id;

  const settings = exposureSettings(exposure);
  const [insertedManaged] = await db
    .insert(managed)
    .values({
      environmentId,
      serverId,
      name: "Postgres",
      engine: "postgres",
      status: "ready",
      options: { settings, databases: ["postgres"] },
    })
    .returning({ id: managed.id });
  const managedId = insertedManaged!.id;

  await db.insert(replica).values({
    managedId,
    serverId,
    role: "primary",
    isReadEligible: false,
    ordinal: 1,
  });

  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId,
    serverId,
    composeServiceName: "postgres",
    ordinal: 1,
  });

  await createManagedPrincipal(db, dataEncryptionSecrets, {
    managedId,
    provider: "postgres",
    username: "postgres",
    metadata: { managedRoot: true, databases: ["postgres"] },
  });

  try {
    await fn({
      db,
      serverId,
      organizationId,
      secretsConfig,
      dataEncryptionSecrets,
    });
  } finally {
    await db.delete(principal).where(eq(principal.managedId, managedId));
    await db.delete(replica).where(eq(replica.managedId, managedId));
    await db.delete(container).where(
      eq(container.id, allocation.containerRowId),
    );
    await db.delete(service).where(eq(service.id, allocation.serviceId));
    await db.delete(managed).where(eq(managed.id, managedId));
    await db.delete(environment).where(eq(environment.id, environmentId));
    await db.delete(project).where(eq(project.id, projectId));
    await db.delete(ip).where(eq(ip.serverId, serverId));

    // `buildManagedIngressReconcilePayload` self-heals a system
    // (managed-ingress) workspace/project/environment/service/container
    // scoped to `serverId` — sweep every workspace under this test-owned
    // organization (not just the tracked ids above) so that hierarchy never
    // leaks and blocks the `server` delete below via RESTRICT foreign keys.
    await db.delete(container).where(eq(container.serverId, serverId));
    const workspaceIds = (
      await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.organizationId, organizationId))
    ).map((row) => row.id);
    if (workspaceIds.length > 0) {
      const projectIds = (
        await db
          .select({ id: project.id })
          .from(project)
          .where(inArray(project.workspaceId, workspaceIds))
      ).map((row) => row.id);
      if (projectIds.length > 0) {
        const environmentIds = (
          await db
            .select({ id: environment.id })
            .from(environment)
            .where(inArray(environment.projectId, projectIds))
        ).map((row) => row.id);
        if (environmentIds.length > 0) {
          await db.delete(service).where(
            inArray(service.environmentId, environmentIds),
          );
          await db.delete(managed).where(
            inArray(managed.environmentId, environmentIds),
          );
          await db.delete(environment).where(
            inArray(environment.id, environmentIds),
          );
        }
        await db.delete(project).where(inArray(project.id, projectIds));
      }
    }

    await db.delete(server).where(eq(server.id, serverId));
    if (workspaceIds.length > 0) {
      await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
    }
    await db.delete(tls).where(eq(tls.organizationId, organizationId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

/**
 * Org + connected server with no managed members and no bindings — the
 * empty-`managedIdSet` case for lazy placement / teardown.
 */
async function withEmptyServerIngressFixture(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    serverId: string;
    organizationId: string;
    secretsConfig: Awaited<
      ReturnType<typeof testEncryptionContext>
    >["secretsConfig"];
    dataEncryptionSecrets: Awaited<
      ReturnType<typeof testEncryptionContext>
    >["dataEncryptionSecrets"];
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping ingress-desired teardown tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const { secretsConfig, dataEncryptionSecrets } =
    await testEncryptionContext();
  const db = createDenoDb();

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Ingress Teardown Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const now = new Date().toISOString();
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Ingress Teardown Server",
      createdAt: now,
      updatedAt: now,
      isConnected: true,
      statusChangedAt: now,
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  await attachDaemonStateToServer(db, serverId, {
    publicJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: `ingress-teardown-key-${serverId}`,
    },
    fingerprint: `ingress-teardown-fp-${serverId}`,
  });

  try {
    await fn({
      db,
      serverId,
      organizationId,
      secretsConfig,
      dataEncryptionSecrets,
    });
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId));
    const workspaceIds = (
      await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.organizationId, organizationId))
    ).map((row) => row.id);
    if (workspaceIds.length > 0) {
      const projectIds = (
        await db
          .select({ id: project.id })
          .from(project)
          .where(inArray(project.workspaceId, workspaceIds))
      ).map((row) => row.id);
      if (projectIds.length > 0) {
        const environmentIds = (
          await db
            .select({ id: environment.id })
            .from(environment)
            .where(inArray(environment.projectId, projectIds))
        ).map((row) => row.id);
        if (environmentIds.length > 0) {
          await db.delete(service).where(
            inArray(service.environmentId, environmentIds),
          );
          await db.delete(environment).where(
            inArray(environment.id, environmentIds),
          );
        }
        await db.delete(project).where(inArray(project.id, projectIds));
      }
      await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
    }
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(tls).where(eq(tls.organizationId, organizationId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("hostgroupsForClusterIndex is stable writer=2i / reader=2i+1", () => {
  assertEquals(hostgroupsForClusterIndex(0), {
    writerHostgroup: 0,
    readerHostgroup: 1,
  });
  assertEquals(hostgroupsForClusterIndex(1), {
    writerHostgroup: 2,
    readerHostgroup: 3,
  });
  assertEquals(hostgroupsForClusterIndex(4), {
    writerHostgroup: 8,
    readerHostgroup: 9,
  });
});

test("hostgroupsForClusterIndex rejects non-integer and negative indices", () => {
  assertThrows(
    () => hostgroupsForClusterIndex(-1),
    TypeError,
    "Invalid cluster index",
  );
  assertThrows(
    () => hostgroupsForClusterIndex(1.5),
    TypeError,
    "Invalid cluster index",
  );
});

test("unionExposureScopes deduplicates and collapses public", () => {
  assertEquals(unionExposureScopes([]), []);
  assertEquals(unionExposureScopes([undefined, undefined]), []);
  assertEquals(unionExposureScopes(["local"]), ["local"]);
  assertEquals(
    unionExposureScopes(["local", "datacenter"]),
    ["datacenter", "local"],
  );
  assertEquals(
    unionExposureScopes(["local", "public", "datacenter"]),
    ["public"],
  );
  assertEquals(
    unionExposureScopes(["datacenter", undefined, "local"]),
    ["datacenter", "local"],
  );
});

test("collectProxySqlListenerSans covers connection/bind host and peer IPs", () => {
  const sans = collectProxySqlListenerSans({
    hostname: "pg-primary.example",
    bindAddresses: ["203.0.113.10"],
    backendAddresses: [
      "managed-abc",
      "203.0.113.50",
      "peer.internal.example",
    ],
  });
  assertEquals(sans.dnsNames, [
    "peer.internal.example",
    "pg-primary.example",
  ]);
  assertEquals(sans.ipAddresses, ["203.0.113.10", "203.0.113.50"]);
});

test("collectProxySqlListenerSans skips wildcard binds and bare container names", () => {
  const sans = collectProxySqlListenerSans({
    hostname: null,
    bindAddresses: ["0.0.0.0"],
    backendAddresses: ["engine-1", "local-name"],
  });
  assertEquals(sans.dnsNames, []);
  assertEquals(sans.ipAddresses, []);
});

test("empty managedIdSet without hierarchy returns null", async () => {
  await withEmptyServerIngressFixture(
    async ({ db, serverId, secretsConfig, dataEncryptionSecrets }) => {
      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      assertEquals(built, null);
    },
  );
});

test("empty managedIdSet with prior hierarchy returns teardown payload", async () => {
  await withEmptyServerIngressFixture(
    async ({
      db,
      serverId,
      organizationId,
      secretsConfig,
      dataEncryptionSecrets,
    }) => {
      await ensureManagedIngressHierarchy(db, { organizationId, serverId });
      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      if (built === null || "kind" in built) {
        throw new TypeError(
          `expected teardown payload, got ${JSON.stringify(built)}`,
        );
      }
      assertEquals(built.serverId, serverId);
      assertEquals(built.clusters, []);
      assertEquals("bindAddresses" in built, false);
      assertEquals(built.orgTlsMaterial, undefined);
    },
  );
});

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[];
} {
  const envelopes: CommandEnvelope[] = [];
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope);
      return Promise.resolve();
    },
  };
}

test("orphan sweep tears down an observed frontend with no demand and throttles the repeat", async () => {
  await withEmptyServerIngressFixture(
    async ({
      db,
      serverId,
      organizationId,
      secretsConfig,
      dataEncryptionSecrets,
    }) => {
      try {
        const hierarchy = await ensureManagedIngressHierarchy(db, {
          organizationId,
          serverId,
        });
        await db
          .update(container)
          .set({ status: "running", containerId: "orphan-proxysql-cid" })
          .where(eq(container.id, hierarchy.containerRowId));
        // `attachDaemonStateToServer` resets connectivity; the sweep only
        // targets connected servers, so stamp the daemon as online again.
        await db
          .update(server)
          .set({ isConnected: true })
          .where(eq(server.id, serverId));

        const queue = createRecordingCommandQueue();
        const first = await runManagedIngressOrphanSweep(db, queue, {
          secretsConfig,
          dataEncryptionSecrets,
        });
        assertEquals(first.enqueued, 1);
        assertEquals(queue.envelopes.length, 1);
        assertEquals(queue.envelopes[0]!.type, "managed.ingress.reconcile");
        assertEquals(queue.envelopes[0]!.serverId, serverId);

        // The command row created above sits inside the throttle window, so
        // the next tick must not enqueue a duplicate.
        const second = await runManagedIngressOrphanSweep(db, queue, {
          secretsConfig,
          dataEncryptionSecrets,
        });
        assertEquals(second.enqueued, 0);
        assertEquals(queue.envelopes.length, 1);
      } finally {
        await db.delete(command).where(eq(command.serverId, serverId));
      }
    },
  );
});

test("orphan sweep skips a frontend that was never observed on Docker", async () => {
  await withEmptyServerIngressFixture(
    async ({
      db,
      serverId,
      organizationId,
      secretsConfig,
      dataEncryptionSecrets,
    }) => {
      // Hierarchy rows exist (allocation happened) but the container row was
      // never stamped running / id'd — nothing to tear down yet, and a
      // pre-first-deploy sweep must not race the bring-up.
      await ensureManagedIngressHierarchy(db, { organizationId, serverId });
      await db
        .update(server)
        .set({ isConnected: true })
        .where(eq(server.id, serverId));

      const queue = createRecordingCommandQueue();
      const result = await runManagedIngressOrphanSweep(db, queue, {
        secretsConfig,
        dataEncryptionSecrets,
      });
      assertEquals(result.enqueued, 0);
      assertEquals(queue.envelopes.length, 0);
    },
  );
});

test("orphan sweep skips servers that still host managed members", async () => {
  await withSingleClusterIngressFixture(
    { enabled: false },
    async ({
      db,
      serverId,
      organizationId,
      secretsConfig,
      dataEncryptionSecrets,
    }) => {
      const hierarchy = await ensureManagedIngressHierarchy(db, {
        organizationId,
        serverId,
      });
      await db
        .update(container)
        .set({ status: "running", containerId: "live-proxysql-cid" })
        .where(eq(container.id, hierarchy.containerRowId));
      await db
        .update(server)
        .set({ isConnected: true })
        .where(eq(server.id, serverId));

      const queue = createRecordingCommandQueue();
      const result = await runManagedIngressOrphanSweep(db, queue, {
        secretsConfig,
        dataEncryptionSecrets,
      });
      assertEquals(result.enqueued, 0);
      assertEquals(queue.envelopes.length, 0);
    },
  );
});

test("exposure disabled omits bindAddresses — no public ProxySQL publish", async () => {
  await withSingleClusterIngressFixture(
    { enabled: false },
    async ({ db, serverId, secretsConfig, dataEncryptionSecrets }) => {
      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      if (built === null || "kind" in built) {
        throw new TypeError(`expected a payload, got ${JSON.stringify(built)}`);
      }
      assertEquals("bindAddresses" in built, false);
      assertEquals(built.clusters.length, 1);
      assertEquals(built.identity?.composeServiceName, "proxysql");
      assertEquals(built.identity?.containerName.endsWith("-in"), true);
      const mintedLeaves = await db
        .select({ id: leaf.id })
        .from(leaf)
        .where(eq(leaf.serverId, serverId));
      assertEquals(mintedLeaves.length, 0);
    },
  );
});

test("exposure enabled + scope public resolves bindAddresses to all-interfaces", async () => {
  await withSingleClusterIngressFixture(
    { enabled: true, scope: "public" },
    async ({ db, serverId, secretsConfig, dataEncryptionSecrets }) => {
      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      if (built === null || "kind" in built) {
        throw new TypeError(`expected a payload, got ${JSON.stringify(built)}`);
      }
      assertEquals(built.bindAddresses, ["0.0.0.0"]);
    },
  );
});

test("exposure enabled + scope local resolves bindAddresses to loopback only", async () => {
  await withSingleClusterIngressFixture(
    { enabled: true, scope: "local" },
    async ({ db, serverId, secretsConfig, dataEncryptionSecrets }) => {
      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      if (built === null || "kind" in built) {
        throw new TypeError(`expected a payload, got ${JSON.stringify(built)}`);
      }
      assertEquals(built.bindAddresses, ["127.0.0.1"]);
    },
  );
});

test("exposure enabled + scope datacenter publishes only the pinned datacenter address", async () => {
  await withSingleClusterIngressFixture(
    { enabled: true, scope: "datacenter" },
    async (
      { db, serverId, organizationId, secretsConfig, dataEncryptionSecrets },
    ) => {
      const now = new Date().toISOString();
      const [dc] = await db.insert(datacenter).values({
        organizationId,
        name: "Ingress Datacenter",
        createdAt: now,
        updatedAt: now,
      }).returning({ id: datacenter.id });
      const [siteNet] = await db.insert(network).values({
        organizationId,
        datacenterId: dc!.id,
        kind: "datacenter",
        cidr: "10.20.30.0/24",
        name: "Ingress LAN",
        createdAt: now,
        updatedAt: now,
      }).returning({ id: network.id });
      await db.insert(ip).values({
        organizationId,
        datacenterId: dc!.id,
        networkId: siteNet!.id,
        serverId,
        address: "10.20.30.40",
        allocation: "dedicated",
        scope: "datacenter",
        createdAt: now,
        updatedAt: now,
      });

      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      if (built === null || "kind" in built) {
        throw new TypeError(`expected a payload, got ${JSON.stringify(built)}`);
      }
      assertEquals(built.bindAddresses, ["10.20.30.40"]);
      // Never widens to all-interfaces just because exposure is enabled.
      assertEquals(built.bindAddresses?.includes("0.0.0.0"), false);

      await db.delete(ip).where(eq(ip.serverId, serverId));
      await db.delete(network).where(eq(network.id, siteNet!.id));
      await db.delete(datacenter).where(eq(datacenter.id, dc!.id));
    },
  );
});

test("exposure enabled + scope datacenter without a pinned IP is a typed prepare error, never a silent public publish", async () => {
  await withSingleClusterIngressFixture(
    { enabled: true, scope: "datacenter" },
    async ({ db, serverId, secretsConfig, dataEncryptionSecrets }) => {
      const built = await buildManagedIngressReconcilePayload(db, {
        serverId,
        secretsConfig,
        dataEncryptionSecrets,
      });
      assertEquals(
        typeof built === "object" && built !== null && "kind" in built &&
          built.kind === "datacenter_ip_required",
        true,
      );
    },
  );
});

async function insertBoundConsumer(
  db: ReturnType<typeof createDenoDb>,
  params: {
    workspaceId: string;
    projectName: string;
    defaultServerId: string;
    environmentServerId: string | null;
    managedServerId: string;
    username: string;
    keyPrefix: string;
    taskServerId?: string;
  },
): Promise<{
  managedId: string;
  environmentId: string;
  projectId: string;
  serviceId: string;
}> {
  const [projectRow] = await db
    .insert(project)
    .values({
      name: params.projectName,
      workspaceId: params.workspaceId,
      options: { defaultServerId: params.defaultServerId },
    })
    .returning({ id: project.id });
  const [environmentRow] = await db
    .insert(environment)
    .values({
      name: "Production",
      projectId: projectRow!.id,
      serverId: params.environmentServerId,
    })
    .returning({ id: environment.id });
  const [serviceRow] = await db
    .insert(service)
    .values({
      environmentId: environmentRow!.id,
      composeServiceName: "web",
    })
    .returning({ id: service.id });
  const [managedRow] = await db
    .insert(managed)
    .values({
      environmentId: environmentRow!.id,
      serverId: params.managedServerId,
      name: "Postgres",
      engine: "postgres",
      status: "ready",
    })
    .returning({ id: managed.id });
  const [principalRow] = await db
    .insert(principal)
    .values({
      kind: "database",
      provider: "postgres",
      username: params.username,
      managedId: managedRow!.id,
    })
    .returning({ id: principal.id });
  await db.insert(binding).values({
    principalId: principalRow!.id,
    serviceId: serviceRow!.id,
    databaseName: "appdb",
    keyPrefix: params.keyPrefix,
    isEmitEngineDefaults: false,
  });
  if (params.taskServerId) {
    await db.insert(slot).values({
      environmentId: environmentRow!.id,
      serviceId: serviceRow!.id,
      serverId: params.taskServerId,
      slot: 0,
    });
  }
  return {
    managedId: managedRow!.id,
    environmentId: environmentRow!.id,
    projectId: projectRow!.id,
    serviceId: serviceRow!.id,
  };
}

test("loadBoundManagedIdsForServer does not scan unpinned environments that default to other servers", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping ingress-desired placement filter tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Ingress Bound Placement Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;
  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: "Ingress Bound Placement Workspace", organizationId })
    .returning({ id: workspace.id });
  const workspaceId = insertedWorkspace!.id;
  const now = new Date().toISOString();
  const [currentServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Ingress Bound Current Server",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id });
  const currentServerId = currentServer!.id;
  const [otherServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Ingress Bound Other Server",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id });
  const otherServerId = otherServer!.id;
  const created: Array<{
    managedId: string;
    environmentId: string;
    projectId: string;
    serviceId: string;
  }> = [];

  try {
    for (let index = 0; index < 8; index += 1) {
      created.push(
        await insertBoundConsumer(db, {
          workspaceId,
          projectName: `Noise Project ${index}`,
          defaultServerId: otherServerId,
          environmentServerId: null,
          managedServerId: otherServerId,
          username: `noise_user_${index}`,
          keyPrefix: `NOISE${index}`,
        }),
      );
    }
    const pinned = await insertBoundConsumer(db, {
      workspaceId,
      projectName: "Pinned Env Project",
      defaultServerId: otherServerId,
      environmentServerId: currentServerId,
      managedServerId: currentServerId,
      username: "pinned_user",
      keyPrefix: "PINNED",
    });
    const matchingDefault = await insertBoundConsumer(db, {
      workspaceId,
      projectName: "Matching Default Project",
      defaultServerId: currentServerId,
      environmentServerId: null,
      managedServerId: currentServerId,
      username: "default_user",
      keyPrefix: "DEFAULT",
    });
    const taskPinned = await insertBoundConsumer(db, {
      workspaceId,
      projectName: "Task Pin Project",
      defaultServerId: otherServerId,
      environmentServerId: null,
      managedServerId: otherServerId,
      username: "task_user",
      keyPrefix: "TASKPIN",
      taskServerId: currentServerId,
    });
    created.push(pinned, matchingDefault, taskPinned);

    const ids = await loadBoundManagedIdsForServer(
      db,
      currentServerId,
      organizationId,
    );
    const included = new Set(ids);
    assertEquals(included.has(pinned.managedId), true);
    assertEquals(included.has(matchingDefault.managedId), true);
    assertEquals(included.has(taskPinned.managedId), true);
    for (const row of created.slice(0, 8)) {
      assertEquals(included.has(row.managedId), false);
    }
    assertEquals(ids.length, 3);
  } finally {
    const serviceIds = created.map((row) => row.serviceId);
    const managedIds = created.map((row) => row.managedId);
    const environmentIds = created.map((row) => row.environmentId);
    const projectIds = created.map((row) => row.projectId);
    if (serviceIds.length > 0) {
      await db.delete(binding).where(inArray(binding.serviceId, serviceIds));
      await db.delete(slot).where(inArray(slot.serviceId, serviceIds));
      await db.delete(service).where(inArray(service.id, serviceIds));
    }
    if (managedIds.length > 0) {
      await db.delete(principal).where(
        inArray(principal.managedId, managedIds),
      );
      await db.delete(managed).where(inArray(managed.id, managedIds));
    }
    if (environmentIds.length > 0) {
      await db.delete(environment).where(
        inArray(environment.id, environmentIds),
      );
    }
    if (projectIds.length > 0) {
      await db.delete(project).where(inArray(project.id, projectIds));
    }
    await db.delete(server).where(eq(server.id, currentServerId));
    await db.delete(server).where(eq(server.id, otherServerId));
    await db.delete(workspace).where(eq(workspace.id, workspaceId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
});
