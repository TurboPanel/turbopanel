import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "../authn/daemon-state.ts";
import {
  PROJECTION_SUMMARY_REFRESH_MS,
  agentChanged,
  mergeAgentPreserving,
  projectServerDaemon,
} from "./postgres-projection.ts";
import {
  onDaemonDisconnected,
  onMonitorMessageApplied,
} from "./control-plane-monitor.ts";

const serverId = "srv-projection-test";

function createMockDb(initialDaemon: ServerDaemonState): {
  db: Db;
  updateCalls: Array<Record<string, unknown>>;
} {
  const updateCalls: Array<Record<string, unknown>> = [];
  let daemon = initialDaemon;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ daemon }]),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updateCalls.push(patch);
        if (patch.daemon) {
          daemon = patch.daemon as ServerDaemonState;
        }
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  } as unknown as Db;

  return { db, updateCalls };
}

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

const testAgent = {
  commit: "abc123",
  buildId: "build-1",
  channel: "trunk",
};

Deno.test("projectServerDaemon summary_refresh skips when lastProjectedAt is recent", async () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: recent,
    },
  });

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "summary_refresh",
  }, {
    resources: [],
    instanceAt: recent,
  });

  assertEquals(wrote, false);
  assertEquals(updateCalls.length, 0);
});

Deno.test("projectServerDaemon resource_transition writes only meaningful transitions", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  const noop = await projectServerDaemon(db, serverId, {
    kind: "resource_transition",
    events: [{
      resourceKey: "container:abc",
      kind: "container",
      fromStatus: "starting",
      toStatus: "starting",
      at: "2020-01-01T00:00:00.000Z",
    }],
  }, { resources: [], instanceAt: "2020-01-01T00:00:00.000Z" });
  assertEquals(noop, false);
  assertEquals(updateCalls.length, 0);

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "resource_transition",
    events: [{
      resourceKey: "container:abc",
      kind: "container",
      fromStatus: "healthy",
      toStatus: "unhealthy",
      at: "2020-01-01T00:00:00.000Z",
    }],
  }, {
    resources: [{
      resourceKey: "container:abc",
      serverId,
      kind: "container",
      status: "unhealthy",
      state: {
        resourceKey: "container:abc",
        kind: "container",
        status: "unhealthy",
      },
      updatedAt: "2020-01-01T00:00:00.000Z",
    }],
    instanceAt: new Date().toISOString(),
  });
  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.status, "unhealthy");
});

Deno.test("projectServerDaemon online writes lastSeenAt", async () => {
  const { db, updateCalls } = createMockDb({ key: baseKey });

  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: { hostname: "host-1", machineId: "mid-1" },
    connectedAt: "2020-01-01T00:00:00.000Z",
  }, { resources: [], instanceAt: "2020-01-01T00:00:00.000Z" });

  assert(updateCalls.length >= 1);
  assertEquals(typeof updateCalls[0]?.lastSeenAt, "string");
});

Deno.test("projectServerDaemon offline writes lastSeenAt and status offline", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  await projectServerDaemon(db, serverId, { kind: "offline" });

  assertEquals(updateCalls.length, 1);
  assertEquals(typeof updateCalls[0]?.lastSeenAt, "string");
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.status, "offline");
  assertEquals(merged?.projection?.connected, false);
});

Deno.test("onDaemonDisconnected projects disconnected without marking status offline", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  await onDaemonDisconnected(db, serverId);

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.connected, false);
  assertEquals(merged?.projection?.status, "healthy");
});

Deno.test("projectServerDaemon preserves server.daemon.key on write", async () => {
  const stale = new Date(Date.now() - PROJECTION_SUMMARY_REFRESH_MS - 1)
    .toISOString();
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 0,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: stale,
    },
  });

  await projectServerDaemon(db, serverId, { kind: "summary_refresh" }, {
    resources: [],
    instanceAt: stale,
  });

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.key?.id, baseKey.id);
  assertEquals(merged?.key?.fingerprint, baseKey.fingerprint);
});

Deno.test("projectServerDaemon disconnect preserves agent", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
      agent: testAgent,
    },
  });

  await projectServerDaemon(db, serverId, { kind: "disconnected" });

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.agent, testAgent);
});

Deno.test("projectServerDaemon offline preserves agent", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
      agent: testAgent,
    },
  });

  await projectServerDaemon(db, serverId, { kind: "offline" });

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.agent, testAgent);
});

Deno.test("projectServerDaemon identity refresh preserves agent", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      hostname: "old-host",
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
      agent: testAgent,
    },
  });

  await projectServerDaemon(db, serverId, {
    kind: "identity",
    identity: { hostname: "new-host" },
  });

  assert(updateCalls.length >= 1);
  const projectionUpdate = updateCalls.find((call) => call.daemon != null);
  const merged = parseServerDaemonState(projectionUpdate?.daemon);
  assertEquals(merged?.projection?.hostname, "new-host");
  assertEquals(merged?.projection?.agent, testAgent);
});

Deno.test("projectServerDaemon summary_refresh preserves agent", async () => {
  const stale = new Date(Date.now() - PROJECTION_SUMMARY_REFRESH_MS - 1)
    .toISOString();
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 0,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: stale,
      agent: testAgent,
    },
  });

  await projectServerDaemon(db, serverId, { kind: "summary_refresh" }, {
    resources: [],
    instanceAt: stale,
  });

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.agent, testAgent);
});

Deno.test("onMonitorMessageApplied heartbeat without projection triggers skips Postgres writes", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: new Date().toISOString(),
      agent: testAgent,
    },
  });

  const cell = {
    listMonitorResources: async () => [],
    getMonitorInstance: async () => null,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: true,
    }),
  };

  await onMonitorMessageApplied(
    db,
    serverId,
    cell as unknown as import("./contracts.ts").DaemonCell,
    "monitor-heartbeat",
    {
      kind: "monitor-heartbeat",
      serverId,
      sequence: 1,
      at: new Date().toISOString(),
      instance: {},
    },
  );

  assertEquals(updateCalls.length, 0);
});

Deno.test("onMonitorMessageApplied merges agent into resource transition write", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  const cell = {
    listMonitorResources: async () => [{
      resourceKey: "container:abc",
      serverId,
      kind: "container" as const,
      status: "unhealthy" as const,
      state: {
        resourceKey: "container:abc",
        kind: "container" as const,
        status: "unhealthy" as const,
      },
      updatedAt: "2020-01-01T00:00:00.000Z",
    }],
    getMonitorInstance: async () => ({
      serverId,
      sequence: 1,
      at: new Date().toISOString(),
      instance: {},
      updatedAt: new Date().toISOString(),
    }),
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: true,
    }),
  };

  await onMonitorMessageApplied(
    db,
    serverId,
    cell as unknown as import("./contracts.ts").DaemonCell,
    "monitor-heartbeat",
    {
      kind: "monitor-heartbeat",
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      instance: {},
      agent: testAgent,
      events: [{
        resourceKey: "container:abc",
        kind: "container",
        fromStatus: "healthy",
        toStatus: "unhealthy",
        at: "2020-01-01T00:00:00.000Z",
      }],
    },
  );

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.agent, testAgent);
  assertEquals(merged?.projection?.status, "unhealthy");
});

Deno.test("agentChanged detects optional field backfill for unchanged build", () => {
  const current = {
    connected: true,
    status: "healthy" as const,
    healthyCount: 1,
    degradedCount: 0,
    unhealthyCount: 0,
    lastProjectedAt: "2020-01-01T00:00:00.000Z",
    agent: {
      commit: "abc123",
      buildId: "build-1",
    },
  };

  assertEquals(
    agentChanged(current, {
      commit: "abc123",
      buildId: "build-1",
      builtAt: "2020-01-02T00:00:00.000Z",
    }),
    true,
  );
  assertEquals(
    agentChanged(current, {
      commit: "abc123",
      buildId: "build-1",
      channel: "trunk",
    }),
    true,
  );
  assertEquals(
    agentChanged(current, {
      commit: "abc123",
      buildId: "build-1",
    }),
    false,
  );
});

Deno.test("mergeAgentPreserving backfills optional fields for unchanged build", () => {
  const current = {
    connected: true,
    status: "healthy" as const,
    healthyCount: 1,
    degradedCount: 0,
    unhealthyCount: 0,
    lastProjectedAt: "2020-01-01T00:00:00.000Z",
    agent: {
      commit: "abc123",
      buildId: "build-1",
    },
  };

  assertEquals(
    mergeAgentPreserving(current, {
      commit: "abc123",
      buildId: "build-1",
      builtAt: "2020-01-02T00:00:00.000Z",
      channel: "trunk",
    }),
    {
      commit: "abc123",
      buildId: "build-1",
      builtAt: "2020-01-02T00:00:00.000Z",
      channel: "trunk",
    },
  );
});

Deno.test("projectServerDaemon agent trigger backfills builtAt for unchanged build", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
      agent: {
        commit: "abc123",
        buildId: "build-1",
      },
    },
  });

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "agent",
    agent: {
      commit: "abc123",
      buildId: "build-1",
      builtAt: "2020-01-02T00:00:00.000Z",
      channel: "trunk",
    },
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.agent, {
    commit: "abc123",
    buildId: "build-1",
    builtAt: "2020-01-02T00:00:00.000Z",
    channel: "trunk",
  });
});

Deno.test("onMonitorMessageApplied heartbeat backfills builtAt for unchanged build", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      status: "healthy",
      healthyCount: 1,
      degradedCount: 0,
      unhealthyCount: 0,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
      agent: {
        commit: "abc123",
        buildId: "build-1",
      },
    },
  });

  const cell = {
    listMonitorResources: async () => [],
    getMonitorInstance: async () => null,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: true,
    }),
  };

  await onMonitorMessageApplied(
    db,
    serverId,
    cell as unknown as import("./contracts.ts").DaemonCell,
    "monitor-heartbeat",
    {
      kind: "monitor-heartbeat",
      serverId,
      sequence: 3,
      at: new Date().toISOString(),
      instance: {},
      agent: {
        commit: "abc123",
        buildId: "build-1",
        builtAt: "2020-01-02T00:00:00.000Z",
        channel: "trunk",
      },
    },
  );

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.agent, {
    commit: "abc123",
    buildId: "build-1",
    builtAt: "2020-01-02T00:00:00.000Z",
    channel: "trunk",
  });
});
