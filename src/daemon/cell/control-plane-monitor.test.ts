import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from "../authn/daemon-state.ts";
import type { DaemonCellRegistry } from "./contracts.ts";
import { DAEMON_OFFLINE_SWEEP_MS } from "./protocol.ts";
import {
  onDaemonConnected,
  onDaemonConnectedFromEvidence,
  onDaemonDisconnected,
  onDaemonHeartbeat,
  onDaemonInbound,
  onDaemonUpdateExpired,
  onDaemonUpdateQueued,
  onDaemonUpdateResult,
  onDaemonUpdateReset,
} from "./control-plane-monitor.ts";
import { resolveFleetPresence } from "./fleet-presence.ts";
import {
  resetTrunkManifestCacheForTests,
  seedTrunkManifestCacheForTests,
} from "../../lib/update/manifest.ts";

const serverId = "srv-heartbeat-agent";

const testGeo: ServerGeo = {
  country: "US",
  city: "San Francisco",
  capturedAt: "2020-01-01T00:00:00.000Z",
};

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

/**
 * Mock row shape mirrors `getServerDaemonStateByServerId`'s select — `daemon`
 * jsonb (`{ key, projection? }`, never `status`) plus dedicated fleet-status /
 * identity columns.
 */
type MockRow = {
  id: string;
  daemon: ServerDaemonState;
  metadata: ServerMetadata | null;
  hostname: string | null;
  machineId: string | null;
  connected: boolean;
  daemonStatus: string;
  lastSeenAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  statusChangedAt: string | null;
};

function buildMockRow(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
  identity: { hostname?: string | null; machineId?: string | null } = {
    hostname: "host-1",
  },
  metadata: ServerMetadata | null = null,
): MockRow {
  const status = { ...buildDefaultDaemonStatus(), ...statusOverrides };
  return {
    id: serverId,
    daemon,
    metadata,
    hostname: identity.hostname ?? null,
    machineId: identity.machineId ?? null,
    connected: status.connected,
    daemonStatus: status.daemonStatus ?? "unknown",
    lastSeenAt: status.lastSeenAt,
    connectedAt: status.connectedAt,
    disconnectedAt: status.disconnectedAt,
    statusChangedAt: status.statusChangedAt,
  };
}

/** Unwrap drizzle `sql\`… || ${json}::jsonb\`` metadata patches. */
function unwrapMetadataSqlPatch(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === "object" && value !== null && "queryChunks" in value) {
    for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
      if (typeof chunk === "string") {
        try {
          return JSON.parse(chunk) as Record<string, unknown>;
        } catch {
          // keep scanning
        }
      }
    }
    return undefined;
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}

/** Apply an `.update(server).set(patch)` call onto the mock row in place. */
function applyPatchToRow(row: MockRow, patch: Record<string, unknown>): void {
  if (patch.daemon !== undefined) {
    row.daemon = patch.daemon as ServerDaemonState;
  }
  if ("hostname" in patch) row.hostname = patch.hostname as string | null;
  if ("machineId" in patch) row.machineId = patch.machineId as string | null;
  if ("connected" in patch) row.connected = patch.connected as boolean;
  if ("daemonStatus" in patch) row.daemonStatus = patch.daemonStatus as string;
  if ("lastSeenAt" in patch) row.lastSeenAt = patch.lastSeenAt as string | null;
  if ("connectedAt" in patch) row.connectedAt = patch.connectedAt as string | null;
  if ("disconnectedAt" in patch) {
    row.disconnectedAt = patch.disconnectedAt as string | null;
  }
  if ("statusChangedAt" in patch) {
    row.statusChangedAt = patch.statusChangedAt as string | null;
  }
  const unwrapped = unwrapMetadataSqlPatch(patch.metadata);
  if (unwrapped !== undefined) {
    row.metadata = unwrapped === null
      ? null
      : { ...row.metadata, ...unwrapped } as ServerMetadata;
  }
}

function createTrackingDb(
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
  identity: { hostname?: string | null; machineId?: string | null } = {
    hostname: "host-1",
  },
): {
  db: Db;
  updateCalls: Array<Record<string, unknown>>;
  getSelectCallCount: () => number;
  getDaemon: () => ServerDaemonState;
  getMetadata: () => ServerMetadata | null;
  getStatus: () => ServerDaemonStatus;
  getIdentity: () => { hostname: string | null; machineId: string | null };
} {
  const updateCalls: Array<Record<string, unknown>> = [];
  let selectCalls = 0;
  const row = buildMockRow(initialDaemon, statusOverrides, identity);

  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1;
          const rows = Promise.resolve([{ ...row }]);
          return Object.assign(rows, { limit: () => rows });
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        const recorded = { ...patch };
        const unwrapped = unwrapMetadataSqlPatch(patch.metadata);
        if (unwrapped !== undefined) {
          recorded.metadata = unwrapped;
        }
        updateCalls.push(recorded);
        applyPatchToRow(row, patch);
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  } as unknown as Db;

  return {
    db,
    updateCalls,
    getSelectCallCount: () => selectCalls,
    getDaemon: () => row.daemon,
    getMetadata: () => row.metadata,
    getStatus: () => mapServerDaemonStatusFromColumns(row),
    getIdentity: () => ({ hostname: row.hostname, machineId: row.machineId }),
  };
}

function createEmptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error("not used");
    },
    listOnlineServerIds: async () => [],
    getSnapshots: async () => {
      throw new Error("getSnapshots must not be called");
    },
    purge: async () => {},
  };
}

function createMockCell(snapshot: Record<string, unknown> = {}) {
  return {
    getSnapshot: async () => ({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: true,
      hostname: "host-1",
      machineId: "mid-1",
      ...snapshot,
    }),
  };
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("onDaemonHeartbeat projects agent.commit for update status via resolveFleetPresence", async () => {
  const { db, getDaemon } = createTrackingDb(
    { key: baseKey, projection: { hostname: "host-1" } },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: new Date(Date.now() - 61_000).toISOString(),
    },
  );

  const agent = {
    commit: "heartbeat-commit",
    buildId: "heartbeat-build",
    channel: "trunk" as const,
  };

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, agent }) as never,
    agent,
  );

  const merged = parseServerDaemonState(getDaemon());
  assertEquals(merged?.projection?.agent?.commit, agent.commit);

  const presence = await resolveFleetPresence(
    db,
    createEmptyRegistry(),
    [serverId],
  );
  const liveAgent = presence.get(serverId)?.agent;
  assertEquals(liveAgent?.commit, agent.commit);
  assertEquals(liveAgent?.buildId, agent.buildId);

  const current = liveAgent?.commit
    ? {
      commit: liveAgent.commit,
      buildId: liveAgent.buildId ?? "",
      builtAt: liveAgent.builtAt ?? "",
    }
    : null;
  assertEquals(current?.commit, agent.commit);
});

test("onDaemonConnected persists optional geo into metadata (hostname/machineId stay on columns)", async () => {
  const { db, updateCalls } = createTrackingDb({ key: baseKey }, {}, {
    hostname: "host-1",
  });

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({
      connectedAt: "2020-01-01T00:00:00.000Z",
      remoteAddress: "203.0.113.10",
    }) as never,
    "2020-01-01T00:00:00.000Z",
    undefined,
    testGeo,
  );

  assertEquals(updateCalls.length, 1);
  // hostname/machineId are dedicated column patches now — never in metadata.
  assertEquals(updateCalls[0]?.machineId, "mid-1");
  assertEquals(updateCalls[0]?.metadata, { geo: testGeo });
});

test("onDaemonInbound backfills metadata.geo when already online", async () => {
  const recentAt = new Date().toISOString();
  const { db, updateCalls, getMetadata } = createTrackingDb(
    {
      key: baseKey,
      projection: {
        hostname: "host-1",
        machineId: "mid-1",
        remoteAddress: "203.0.113.10",
      },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recentAt,
      connectedAt: recentAt,
    },
    { hostname: "host-1", machineId: "mid-1" },
  );

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({
      connected: true,
      connectedAt: recentAt,
      lastSeenAt: recentAt,
      remoteAddress: "203.0.113.10",
      hostname: "host-1",
      machineId: "mid-1",
    }) as never,
    { at: recentAt, geo: testGeo },
  );

  assertEquals(
    updateCalls.some((patch) =>
      (patch.metadata as { geo?: ServerGeo } | undefined)?.geo?.country === "US"
    ),
    true,
  );
  assertEquals(getMetadata()?.geo, testGeo);
});

test("onDaemonConnected sets status on dedicated columns", async () => {
  const { db, updateCalls } = createTrackingDb({ key: baseKey });

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: "2020-01-01T00:00:00.000Z" }) as never,
    "2020-01-01T00:00:00.000Z",
  );

  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.connected, true);
  assertEquals(updateCalls[0]?.connectedAt, "2020-01-01T00:00:00.000Z");
  assertEquals(typeof updateCalls[0]?.statusChangedAt, "string");
  assertEquals(typeof updateCalls[0]?.lastSeenAt, "string");
  // status never lives in the daemon jsonb patch.
  const daemonPatch = updateCalls[0]?.daemon as Record<string, unknown> | undefined;
  assertEquals(daemonPatch !== undefined && "status" in daemonPatch, false);
});

test("onDaemonConnected repeated within 60s skips write when already online", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: "host-1", machineId: "mid-1" },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recent,
      connectedAt,
    },
    { hostname: "host-1", machineId: "mid-1" },
  );

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: "2020-06-01T00:00:00.000Z" }) as never,
    "2020-06-01T00:00:00.000Z",
  );

  assertEquals(updateCalls.length, 0);
});

test("onDaemonConnected repeated after 60s updates lastSeenAt only", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: "host-1", machineId: "mid-1" },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: stale,
      connectedAt,
    },
    { hostname: "host-1", machineId: "mid-1" },
  );

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: "2020-06-01T00:00:00.000Z" }) as never,
    "2020-06-01T00:00:00.000Z",
  );

  assertEquals(updateCalls.length, 1);
  assertEquals(typeof updateCalls[0]?.lastSeenAt, "string");
  assertEquals(updateCalls[0]?.connectedAt, connectedAt);
  assertEquals(updateCalls[0]?.statusChangedAt, null);
});

test("onDaemonDisconnected sets offline status on columns without lastSeenAt change", async () => {
  const { db, updateCalls } = createTrackingDb(
    { key: baseKey, projection: { hostname: "host-1" } },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: "2020-01-01T00:00:00.000Z",
    },
  );

  await onDaemonDisconnected(db, serverId);

  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.connected, false);
  assertEquals(typeof updateCalls[0]?.disconnectedAt, "string");
  assertEquals(typeof updateCalls[0]?.statusChangedAt, "string");
  assertEquals(updateCalls[0]?.lastSeenAt, "2020-01-01T00:00:00.000Z");
});

test("onDaemonConnected self-heals Postgres offline when cell is live", async () => {
  const recentAt = new Date().toISOString();
  const { db, updateCalls } = createTrackingDb(
    { key: baseKey, projection: { hostname: "host-1" } },
    {
      connected: false,
      daemonStatus: "offline",
      lastSeenAt: recentAt,
      disconnectedAt: recentAt,
      statusChangedAt: recentAt,
    },
  );

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({
      connected: true,
      connectedAt: recentAt,
      lastSeenAt: recentAt,
    }) as never,
    recentAt,
  );

  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.connected, true);
});

test("onDaemonConnectedFromEvidence marks online without a cell", async () => {
  const recentAt = new Date().toISOString();
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const { db, updateCalls } = createTrackingDb(
    { key: baseKey, projection: { hostname: "host-1", machineId: "mid-1" } },
    {
      connected: false,
      daemonStatus: "offline",
      lastSeenAt: recentAt,
      connectedAt,
      disconnectedAt: recentAt,
      statusChangedAt: recentAt,
    },
    { hostname: "host-1", machineId: "mid-1" },
  );

  await onDaemonConnectedFromEvidence(db, serverId, connectedAt);

  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.connected, true);
  assertEquals(updateCalls[0]?.connectedAt, connectedAt);
  const daemon = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(daemon?.projection?.hostname, "host-1");
  assertEquals(daemon?.projection?.machineId, "mid-1");
});

test("onDaemonHeartbeat within 60s skips DB write when agent unchanged", async () => {
  const agent = {
    commit: "abc123",
    buildId: "build-1",
    channel: "trunk" as const,
  };
  const recentAt = new Date().toISOString();
  const { db, updateCalls, getSelectCallCount } = createTrackingDb(
    {
      key: baseKey,
      projection: { agent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recentAt,
    },
  );

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, lastSeenAt: recentAt, agent }) as never,
    agent,
    new Date(Date.now() + 1000).toISOString(),
  );

  assertEquals(updateCalls.length, 0);
  assertEquals(getSelectCallCount(), 0);
});

test("onDaemonInbound projects new agent before steady-state skip", async () => {
  const agent = {
    commit: "abc123",
    buildId: "build-1",
    channel: "trunk" as const,
  };
  const recentAt = new Date().toISOString();
  const { db, updateCalls, getDaemon } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: "host-1" },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recentAt,
    },
  );

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({ connected: true, lastSeenAt: recentAt, agent }) as never,
    { at: new Date(Date.now() + 1000).toISOString(), agent },
  );

  assertEquals(updateCalls.length, 1);
  assertEquals(getDaemon()?.projection?.agent?.commit, "abc123");
});

test("onDaemonInbound repairs stale updating on steady-state hello when agent matches trunk", async () => {
  resetTrunkManifestCacheForTests();
  seedTrunkManifestCacheForTests({
    commit: "target-commit",
    buildId: "b2",
    builtAt: "2020-01-01T00:00:00.000Z",
    channel: "trunk",
    manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
  });

  const agent = {
    commit: "target-commit",
    buildId: "build-1",
    channel: "trunk" as const,
  };
  const recentAt = new Date().toISOString();
  const { db, updateCalls, getDaemon } = createTrackingDb(
    {
      key: baseKey,
      projection: {
        agent,
        update: {
          status: "updating",
          requestId: "req-1",
          channel: "trunk",
          queuedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recentAt,
    },
  );

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({ connected: true, lastSeenAt: recentAt, agent }) as never,
    { at: new Date(Date.now() + 1000).toISOString(), agent },
  );

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-1");
  assertEquals(updateCalls.length, 1);
});

test("onDaemonInbound within 60s skips heartbeat write when agent unchanged", async () => {
  const agent = {
    commit: "abc123",
    buildId: "build-1",
    channel: "trunk" as const,
  };
  const recentAt = new Date().toISOString();
  const { db, updateCalls, getSelectCallCount } = createTrackingDb(
    {
      key: baseKey,
      projection: { agent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recentAt,
    },
  );

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({ connected: true, lastSeenAt: recentAt, agent }) as never,
    { at: new Date(Date.now() + 1000).toISOString(), agent },
  );

  assertEquals(updateCalls.length, 0);
  assertEquals(getSelectCallCount(), 2);
});

test("onDaemonHeartbeat after 60s writes lastSeenAt", async () => {
  const agent = {
    commit: "abc123",
    buildId: "build-1",
    channel: "trunk" as const,
  };
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { agent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: new Date(Date.now() - 61_000).toISOString(),
    },
  );

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, agent }) as never,
    agent,
  );

  assertEquals(updateCalls.length, 1);
  assertEquals(typeof updateCalls[0]?.lastSeenAt, "string");
});

test("onDaemonHeartbeat without agent after 60s writes lastSeenAt", async () => {
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: "host-1", agent: { commit: "abc", buildId: "1" } },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: stale,
      connectedAt: "2020-01-01T00:00:00.000Z",
    },
  );

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, lastSeenAt: stale }) as never,
  );

  assertEquals(updateCalls.length, 1);
  assert(updateCalls[0]);
  assertEquals(typeof updateCalls[0]?.lastSeenAt, "string");
  assertEquals(updateCalls[0]?.lastSeenAt !== stale, true);
  assertEquals(updateCalls[0]?.connected, true);
});

test("onDaemonInbound restores online projection after stale sweep", async () => {
  const stale = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
    .toISOString();
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: "host-1", agent: { commit: "abc", buildId: "1" } },
    },
    {
      connected: false,
      daemonStatus: "offline",
      lastSeenAt: stale,
      disconnectedAt: stale,
    },
  );

  const at = new Date().toISOString();
  await onDaemonInbound(
    db,
    serverId,
    createMockCell({ connected: false, lastSeenAt: stale }) as never,
    { at, agent: { commit: "recovered", buildId: "2", channel: "trunk" } },
  );

  assertEquals(updateCalls.length, 2);
  const onlinePatch = updateCalls.find((patch) => patch.connected === true);
  assert(onlinePatch);
  assertEquals(onlinePatch?.connected, true);
  assertEquals(onlinePatch?.daemonStatus, "online");
});

test("onDaemonUpdateQueued writes projection.update as updating", async () => {
  const { db, getDaemon } = createTrackingDb({ key: baseKey });

  await onDaemonUpdateQueued(
    db,
    serverId,
    "req-1",
    "trunk",
    "2020-01-01T00:00:00.000Z",
  );

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "updating");
  assertEquals(update?.requestId, "req-1");
  assertEquals(update?.channel, "trunk");
  assertEquals(update?.queuedAt, "2020-01-01T00:00:00.000Z");
});

test("onDaemonUpdateResult writes projection.update as done or failed", async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: "updating",
        requestId: "req-1",
        channel: "trunk",
        queuedAt: "2020-01-01T00:00:00.000Z",
      },
    },
  });

  await onDaemonUpdateResult(
    db,
    serverId,
    "req-1",
    true,
    "2020-01-01T00:01:00.000Z",
  );

  let update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-1");
  assertEquals(update?.finishedAt, "2020-01-01T00:01:00.000Z");

  await onDaemonUpdateResult(
    db,
    serverId,
    "req-2",
    false,
    "2020-01-01T00:02:00.000Z",
    "reconcile failed",
  );

  update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "failed");
  assertEquals(update?.requestId, "req-2");
  assertEquals(update?.error, "reconcile failed");
});

test("onDaemonUpdateReset clears projection.update to idle", async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: "failed",
        requestId: "req-1",
        error: "reconcile failed",
      },
    },
  });

  await onDaemonUpdateReset(db, serverId);

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "idle");
});

test("onDaemonUpdateExpired writes projection.update as expired", async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: "updating",
        requestId: "req-1",
        channel: "trunk",
        queuedAt: "2020-01-01T00:00:00.000Z",
      },
    },
  });

  await onDaemonUpdateExpired(
    db,
    serverId,
    "req-1",
    "2020-01-01T00:05:00.000Z",
  );

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "expired");
  assertEquals(update?.requestId, "req-1");
  assertEquals(update?.finishedAt, "2020-01-01T00:05:00.000Z");
  assertEquals(
    update?.error,
    "Update timed out waiting for daemon acknowledgement",
  );
});

test("repairStaleProjectedUpdate marks done when daemon commit matches trunk", async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: "updating",
        requestId: "req-1",
        channel: "trunk",
        queuedAt: "2020-01-01T00:00:00.000Z",
      },
    },
  });

  const { repairStaleProjectedUpdate } = await import("./control-plane-monitor.ts");
  const repaired = await repairStaleProjectedUpdate(
    db,
    serverId,
    {
      status: "updating",
      requestId: "req-1",
      channel: "trunk",
      queuedAt: "2020-01-01T00:00:00.000Z",
    },
    {
      currentCommit: "target-commit",
      targetCommit: "target-commit",
    },
  );

  assertEquals(repaired, true);
  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
});

test("maybeRepairUpdateFromAgentHello clears updating when agent matches trunk", async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: "updating",
        requestId: "req-1",
        channel: "trunk",
        queuedAt: "2020-01-01T00:00:00.000Z",
      },
    },
  });

  const { maybeRepairUpdateFromAgentHello } = await import("./control-plane-monitor.ts");
  await maybeRepairUpdateFromAgentHello(
    db,
    serverId,
    {
      commit: "target-commit",
      buildId: "b1",
      channel: "trunk",
    },
    "target-commit",
  );

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-1");
});
