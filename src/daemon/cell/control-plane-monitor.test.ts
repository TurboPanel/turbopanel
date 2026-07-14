import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import {
  buildDefaultDaemonStatus,
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

function mergeDaemonStatus(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): ServerDaemonState {
  return {
    ...daemon,
    status: {
      ...buildDefaultDaemonStatus(),
      ...(daemon.status),
      ...statusOverrides,
    },
  };
}

type TrackingDbRow = {
  id: string;
  daemon: ServerDaemonState;
  metadata: Record<string, unknown>;
};

function createTrackingDbUpdateHandler(
  updateCalls: Array<Record<string, unknown>>,
  row: TrackingDbRow,
  setDaemon: (daemon: ServerDaemonState) => void,
) {
  return (patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    if (patch.daemon) {
      const nextDaemon = patch.daemon as ServerDaemonState;
      setDaemon(nextDaemon);
      row.daemon = nextDaemon;
    }
    if (patch.metadata !== undefined) {
      row.metadata = patch.metadata as Record<string, unknown>;
    }
    return {
      where: () => Promise.resolve(undefined),
    };
  };
}

function createTrackingDbSelectHandler(
  row: TrackingDbRow,
  getDaemon: () => ServerDaemonState,
  onSelect: () => void,
) {
  return () => {
    onSelect();
    row.daemon = getDaemon();
    const rows = Promise.resolve([row]);
    return Object.assign(rows, { limit: () => rows });
  };
}

function createTrackingDb(
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): {
  db: Db;
  updateCalls: Array<Record<string, unknown>>;
  getSelectCallCount: () => number;
  getDaemon: () => ServerDaemonState;
} {
  const updateCalls: Array<Record<string, unknown>> = [];
  let selectCalls = 0;
  let daemon = mergeDaemonStatus(initialDaemon, statusOverrides);

  const row: TrackingDbRow = {
    id: serverId,
    daemon,
    metadata: { hostname: "host-1" },
  };

  const db = {
    select: () => ({
      from: () => ({
        where: createTrackingDbSelectHandler(row, () => daemon, () => {
          selectCalls += 1;
        }),
      }),
    }),
    update: () => ({
      set: createTrackingDbUpdateHandler(updateCalls, row, (nextDaemon) => {
        daemon = nextDaemon;
      }),
    }),
  } as unknown as Db;

  return { db, updateCalls, getSelectCallCount: () => selectCalls, getDaemon: () => daemon };
}

function statusFromPatch(
  patch: Record<string, unknown> | undefined,
): ServerDaemonStatus | undefined {
  return parseServerDaemonState(patch?.daemon)?.status ?? undefined;
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

Deno.test("onDaemonHeartbeat projects agent.commit for update status via resolveFleetPresence", async () => {
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

Deno.test("onDaemonConnected persists optional geo into metadata", async () => {
  const { db, updateCalls } = createTrackingDb({ key: baseKey });

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
  assertEquals(updateCalls[0]?.metadata, {
    hostname: "host-1",
    machineId: "mid-1",
    geo: testGeo,
  });
});

Deno.test("onDaemonConnected sets status in daemon jsonb", async () => {
  const { db, updateCalls } = createTrackingDb({ key: baseKey });

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: "2020-01-01T00:00:00.000Z" }) as never,
    "2020-01-01T00:00:00.000Z",
  );

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assert(status);
  assertEquals(status?.connected, true);
  assertEquals(status?.connectedAt, "2020-01-01T00:00:00.000Z");
  assertEquals(typeof status?.statusChangedAt, "string");
  assertEquals(typeof status?.lastSeenAt, "string");
});

Deno.test("onDaemonConnected repeated within 60s skips write when already online", async () => {
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
  );

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: "2020-06-01T00:00:00.000Z" }) as never,
    "2020-06-01T00:00:00.000Z",
  );

  assertEquals(updateCalls.length, 0);
});

Deno.test("onDaemonConnected repeated after 60s updates lastSeenAt only", async () => {
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
  );

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: "2020-06-01T00:00:00.000Z" }) as never,
    "2020-06-01T00:00:00.000Z",
  );

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(typeof status?.lastSeenAt, "string");
  assertEquals(status?.connectedAt, connectedAt);
  assertEquals(status?.statusChangedAt, null);
});

Deno.test("onDaemonDisconnected sets offline status in daemon jsonb without lastSeenAt change", async () => {
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
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, false);
  assertEquals(typeof status?.disconnectedAt, "string");
  assertEquals(typeof status?.statusChangedAt, "string");
  assertEquals(status?.lastSeenAt, "2020-01-01T00:00:00.000Z");
});

Deno.test("onDaemonConnected self-heals Postgres offline when cell is live", async () => {
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
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, true);
});

Deno.test("onDaemonConnectedFromEvidence marks online without a cell", async () => {
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
  );

  await onDaemonConnectedFromEvidence(db, serverId, connectedAt);

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, true);
  assertEquals(status?.connectedAt, connectedAt);
  const daemon = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(daemon?.projection?.hostname, "host-1");
  assertEquals(daemon?.projection?.machineId, "mid-1");
});

Deno.test("onDaemonHeartbeat within 60s skips DB write when agent unchanged", async () => {
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

Deno.test("onDaemonInbound projects new agent before steady-state skip", async () => {
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

Deno.test("onDaemonInbound repairs stale updating on steady-state hello when agent matches trunk", async () => {
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

Deno.test("onDaemonConnected self-heals Postgres offline when cell is live", async () => {
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
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, true);
});

Deno.test("onDaemonInbound within 60s skips heartbeat write when agent unchanged", async () => {
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

Deno.test("onDaemonHeartbeat after 60s writes lastSeenAt", async () => {
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
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(typeof status?.lastSeenAt, "string");
});

Deno.test("onDaemonHeartbeat without agent after 60s writes lastSeenAt", async () => {
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
  const status = statusFromPatch(updateCalls[0]);
  assert(status);
  assertEquals(typeof status?.lastSeenAt, "string");
  assertEquals(status?.lastSeenAt !== stale, true);
  assertEquals(status?.connected, true);
});

Deno.test("onDaemonInbound restores online projection after stale sweep", async () => {
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
  const onlinePatch = updateCalls.find((patch) =>
    statusFromPatch(patch)?.connected === true
  );
  assert(onlinePatch);
  assertEquals(statusFromPatch(onlinePatch)?.connected, true);
  assertEquals(statusFromPatch(onlinePatch)?.daemonStatus, "online");
});

Deno.test("onDaemonUpdateQueued writes projection.update as updating", async () => {
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

Deno.test("onDaemonUpdateResult writes projection.update as done or failed", async () => {
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

Deno.test("onDaemonUpdateReset clears projection.update to idle", async () => {
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

Deno.test("onDaemonUpdateExpired writes projection.update as expired", async () => {
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

Deno.test("repairStaleProjectedUpdate marks done when daemon commit matches trunk", async () => {
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

Deno.test("maybeRepairUpdateFromAgentHello clears updating when agent matches trunk", async () => {
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
