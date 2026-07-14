import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import {
  buildDefaultDaemonStatus,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from "../authn/daemon-state.ts";
import {
  agentChanged,
  listConnectedServerIdsFromProjection,
  listRecentlyOfflineServersForSweep,
  mergeAgentPreserving,
  projectServerDaemon,
  readProjectionsForServers,
  RECENT_OFFLINE_SWEEP_MS,
  rotateSweepBatch,
  steadyStateInboundSkipsDbRead,
} from "./postgres-projection.ts";
import { onDaemonDisconnected } from "./control-plane-monitor.ts";

const serverId = "srv-projection-test";

function mergeDaemonStatus(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): ServerDaemonState {
  return {
    ...daemon,
    status: {
      ...buildDefaultDaemonStatus(),
      ...daemon.status,
      ...statusOverrides,
    },
  };
}

function mockProjectionSelectRow(row: {
  daemon: ServerDaemonState;
  metadata: ServerMetadata | null;
}) {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([row]),
      }),
    }),
  };
}

function mockProjectionUpdateChain(
  updateCalls: Array<Record<string, unknown>>,
  applyPatch: (patch: Record<string, unknown>) => void,
) {
  return {
    set: (patch: Record<string, unknown>) => {
      updateCalls.push(patch);
      applyPatch(patch);
      return {
        where: () => Promise.resolve(undefined),
      };
    },
  };
}

function createMockDb(
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
  initialMetadata: ServerMetadata | null = null,
): {
  db: Db;
  updateCalls: Array<Record<string, unknown>>;
  getStatus: () => ServerDaemonStatus;
  getDaemon: () => ServerDaemonState;
  getMetadata: () => ServerMetadata | null;
} {
  const updateCalls: Array<Record<string, unknown>> = [];
  let daemon = mergeDaemonStatus(initialDaemon, statusOverrides);
  let metadata = initialMetadata;

  const applyPatch = (patch: Record<string, unknown>) => {
    if (patch.daemon) {
      daemon = patch.daemon as ServerDaemonState;
    }
    if (patch.metadata !== undefined) {
      metadata = patch.metadata as ServerMetadata | null;
    }
  };

  const db = {
    select: () => mockProjectionSelectRow({ daemon, metadata }),
    update: () => mockProjectionUpdateChain(updateCalls, applyPatch),
  } as unknown as Db;

  return {
    db,
    updateCalls,
    getStatus: () => daemon.status ?? buildDefaultDaemonStatus(),
    getDaemon: () => daemon,
    getMetadata: () => metadata,
  };
}

function statusFromPatch(
  patch: Record<string, unknown> | undefined,
): ServerDaemonStatus | undefined {
  return parseServerDaemonState(patch?.daemon)?.status ?? undefined;
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

const testGeo: ServerGeo = {
  country: "US",
  city: "San Francisco",
  capturedAt: "2020-01-01T00:00:00.000Z",
};

const testGeoUpdated: ServerGeo = {
  country: "NL",
  city: "Amsterdam",
  capturedAt: "2020-06-01T00:00:00.000Z",
};

Deno.test("projectServerDaemon online persists metadata.geo when remoteAddress is new", async () => {
  const { db, updateCalls } = createMockDb({ key: baseKey });

  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {
      hostname: "host-1",
      machineId: "mid-1",
      remoteAddress: "203.0.113.10",
      geo: testGeo,
    },
    connectedAt: "2020-01-01T00:00:00.000Z",
  });

  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.metadata, {
    hostname: "host-1",
    machineId: "mid-1",
    geo: testGeo,
  });
});

Deno.test("projectServerDaemon repeated online backfills metadata.geo when same IP and geo was missing", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  const cloudflareGeo: ServerGeo = {
    country: "US",
    city: "San Francisco",
    region: "California",
    asn: 13335,
    asOrganization: "Cloudflare, Inc.",
    datacenter: "SFO",
    capturedAt: "2020-06-01T00:00:00.000Z",
  };
  const { db, updateCalls } = createMockDb(
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
      lastSeenAt: recent,
      connectedAt,
    },
    { hostname: "host-1", machineId: "mid-1" },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {
      hostname: "host-1",
      machineId: "mid-1",
      remoteAddress: "203.0.113.10",
      geo: cloudflareGeo,
    },
    connectedAt: "2020-06-01T00:00:00.000Z",
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.metadata, {
    hostname: "host-1",
    machineId: "mid-1",
    geo: cloudflareGeo,
  });
});

Deno.test("projectServerDaemon repeated online skips write when only geo changed with same IP", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  const { db, updateCalls } = createMockDb(
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
      lastSeenAt: recent,
      connectedAt,
    },
    { hostname: "host-1", machineId: "mid-1", geo: testGeo },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {
      hostname: "host-1",
      machineId: "mid-1",
      remoteAddress: "203.0.113.10",
      geo: testGeoUpdated,
    },
    connectedAt: "2020-06-01T00:00:00.000Z",
  });

  assertEquals(wrote, false);
  assertEquals(updateCalls.length, 0);
});

Deno.test("projectServerDaemon repeated online refreshes geo when remoteAddress changes", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  const { db, updateCalls } = createMockDb(
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
      lastSeenAt: recent,
      connectedAt,
    },
    { hostname: "host-1", machineId: "mid-1", geo: testGeo },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {
      hostname: "host-1",
      machineId: "mid-1",
      remoteAddress: "198.51.100.20",
      geo: testGeoUpdated,
    },
    connectedAt: "2020-06-01T00:00:00.000Z",
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.metadata, {
    hostname: "host-1",
    machineId: "mid-1",
    geo: testGeoUpdated,
  });
});

Deno.test("projectServerDaemon identity trigger backfills metadata.geo when geo was missing", async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: {
        hostname: "host-1",
        machineId: "mid-1",
        remoteAddress: "203.0.113.10",
        agent: testAgent,
      },
    },
    {},
    { hostname: "host-1", machineId: "mid-1" },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "identity",
    identity: {
      remoteAddress: "203.0.113.10",
      geo: testGeo,
    },
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0]?.metadata, {
    hostname: "host-1",
    machineId: "mid-1",
    geo: testGeo,
  });
});

Deno.test("projectServerDaemon identity trigger skips metadata.geo when stored geo exists and IP unchanged", async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: {
        hostname: "host-1",
        machineId: "mid-1",
        remoteAddress: "203.0.113.10",
        agent: testAgent,
      },
    },
    {},
    { hostname: "host-1", machineId: "mid-1", geo: testGeo },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "identity",
    identity: {
      remoteAddress: "203.0.113.10",
      geo: testGeoUpdated,
    },
  });

  assertEquals(wrote, false);
  assertEquals(updateCalls.length, 0);
});

Deno.test("projectServerDaemon online sets status in daemon jsonb", async () => {
  const { db, updateCalls } = createMockDb({ key: baseKey });

  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: { hostname: "host-1", machineId: "mid-1" },
    connectedAt: "2020-01-01T00:00:00.000Z",
  });

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assert(status);
  assertEquals(status?.connected, true);
  assertEquals(status?.connectedAt, "2020-01-01T00:00:00.000Z");
  assertEquals(typeof status?.statusChangedAt, "string");
  assertEquals(typeof status?.lastSeenAt, "string");
  assertEquals(updateCalls[0]?.metadata, {
    hostname: "host-1",
    machineId: "mid-1",
  });
});

Deno.test("projectServerDaemon repeated online within 60s skips write", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  const { db, updateCalls } = createMockDb(
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

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: { hostname: "host-1", machineId: "mid-1" },
    connectedAt: "2020-06-01T00:00:00.000Z",
  });

  assertEquals(wrote, false);
  assertEquals(updateCalls.length, 0);
});

Deno.test("projectServerDaemon repeated online after 60s updates lastSeenAt only", async () => {
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, updateCalls, getStatus } = createMockDb(
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

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: { hostname: "host-1", machineId: "mid-1" },
    connectedAt: "2020-06-01T00:00:00.000Z",
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(typeof status?.lastSeenAt, "string");
  assertEquals(status?.connectedAt, connectedAt);
  assertEquals(status?.statusChangedAt, null);
  assertEquals(getStatus().connectedAt, connectedAt);
});

Deno.test("projectServerDaemon offline clears connected without touching lastSeenAt", async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: {
        hostname: "host-1",
        agent: testAgent,
      },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: "2020-01-01T00:00:00.000Z",
      connectedAt: "2020-01-01T00:00:00.000Z",
    },
  );

  await projectServerDaemon(db, serverId, { kind: "offline" });

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, false);
  assertEquals(typeof status?.disconnectedAt, "string");
  assertEquals(typeof status?.statusChangedAt, "string");
  assertEquals(status?.lastSeenAt, "2020-01-01T00:00:00.000Z");
});

Deno.test("onDaemonDisconnected projects disconnected status in daemon jsonb", async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: { hostname: "host-1" },
    },
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

Deno.test("projectServerDaemon disconnected matches offline status patch", async () => {
  const { db, updateCalls, getDaemon } = createMockDb(
    {
      key: baseKey,
      projection: { hostname: "host-1", agent: testAgent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: "2020-01-01T00:00:00.000Z",
    },
  );

  await projectServerDaemon(db, serverId, { kind: "disconnected" });

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, false);
  assertEquals(typeof status?.disconnectedAt, "string");
  assertEquals(status?.lastSeenAt, "2020-01-01T00:00:00.000Z");
  assert(updateCalls[0]?.daemon != null);
  assertEquals(getDaemon().projection?.agent, testAgent);
});

Deno.test("projectServerDaemon heartbeat within 60s skips write", async () => {
  const recent = new Date().toISOString();
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: { agent: testAgent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: recent,
    },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "heartbeat",
    agent: testAgent,
  });

  assertEquals(wrote, false);
  assertEquals(updateCalls.length, 0);
});

Deno.test("projectServerDaemon heartbeat after 60s updates lastSeenAt", async () => {
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: { agent: testAgent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: stale,
    },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "heartbeat",
    agent: testAgent,
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(typeof status?.lastSeenAt, "string");
  assertEquals(status?.connected, true);
});

Deno.test("projectServerDaemon heartbeat without agent after 60s updates lastSeenAt", async () => {
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: { hostname: "host-1", agent: testAgent },
    },
    {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: stale,
      connectedAt: "2020-01-01T00:00:00.000Z",
    },
  );

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "heartbeat",
  });

  assertEquals(wrote, true);
  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assert(status);
  assertEquals(typeof status?.lastSeenAt, "string");
  assertEquals(status?.lastSeenAt !== stale, true);
  assertEquals(status?.connected, true);
});

Deno.test("projectServerDaemon preserves server.daemon.key on write", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: { hostname: "host-1" },
  });

  await projectServerDaemon(db, serverId, {
    kind: "agent",
    agent: {
      commit: "new-commit",
      buildId: "new-build",
    },
  });

  assert(updateCalls.length >= 1);
  const projectionUpdate = updateCalls.find((call) => call.daemon != null);
  const merged = parseServerDaemonState(projectionUpdate?.daemon);
  assertEquals(merged?.key?.id, baseKey.id);
  assertEquals(merged?.key?.fingerprint, baseKey.fingerprint);
});

Deno.test("projectServerDaemon agent trigger updates jsonb only", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: { hostname: "host-1" },
  });

  await projectServerDaemon(db, serverId, {
    kind: "agent",
    agent: {
      commit: "new-commit",
      buildId: "new-build",
    },
  });

  assertEquals(updateCalls.length, 1);
  const status = statusFromPatch(updateCalls[0]);
  assertEquals(status?.connected, false);
  assertEquals(status?.lastSeenAt, null);
  assert(updateCalls[0]?.daemon != null);
});

Deno.test("projectServerDaemon identity trigger updates jsonb only", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      hostname: "old-host",
      agent: testAgent,
    },
  });

  await projectServerDaemon(db, serverId, {
    kind: "identity",
    identity: { hostname: "new-host" },
  });

  assert(updateCalls.length >= 1);
  const projectionUpdate = updateCalls.find((call) => call.daemon != null);
  const status = statusFromPatch(projectionUpdate);
  assertEquals(status?.connected, false);
  assertEquals(status?.lastSeenAt, null);
  const merged = parseServerDaemonState(projectionUpdate?.daemon);
  assertEquals(merged?.projection?.hostname, "new-host");
  assertEquals(merged?.projection?.agent, testAgent);
});

Deno.test("projectServerDaemon identity trigger preserves projection.update", async () => {
  const updatingProjection = {
    status: "updating" as const,
    requestId: "req-1",
    channel: "trunk",
    queuedAt: "2020-01-01T00:00:00.000Z",
  };
  const { db, getDaemon } = createMockDb({
    key: baseKey,
    projection: {
      hostname: "old-host",
      agent: testAgent,
      update: updatingProjection,
    },
  });

  await projectServerDaemon(db, serverId, {
    kind: "identity",
    identity: { hostname: "new-host" },
  });

  const merged = parseServerDaemonState(getDaemon());
  assertEquals(merged?.projection?.hostname, "new-host");
  assertEquals(merged?.projection?.agent, testAgent);
  assertEquals(merged?.projection?.update, updatingProjection);
});

Deno.test("projectServerDaemon online trigger preserves projection.update", async () => {
  const updatingProjection = {
    status: "updating" as const,
    requestId: "req-1",
    channel: "trunk",
    queuedAt: "2020-01-01T00:00:00.000Z",
  };
  const { db, getDaemon } = createMockDb({
    key: baseKey,
    projection: {
      hostname: "host-1",
      machineId: "mid-1",
      update: updatingProjection,
    },
  });

  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {
      hostname: "host-1",
      machineId: "mid-1",
      remoteAddress: "__direct__",
    },
    connectedAt: "2020-01-01T00:00:00.000Z",
  });

  const merged = parseServerDaemonState(getDaemon());
  assertEquals(merged?.projection?.remoteAddress, "__direct__");
  assertEquals(merged?.projection?.update, updatingProjection);
});

Deno.test("agentChanged detects optional field backfill for unchanged build", () => {
  const current = {
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

Deno.test("readProjectionsForServers reads status.connected as online", async () => {
  const connectedDaemon = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
    },
    status: {
      connected: true,
      daemonStatus: "online",
      connectedAt: "2020-06-01T12:00:00.000Z",
      lastSeenAt: "2020-06-01T12:05:00.000Z",
      disconnectedAt: null,
      statusChangedAt: "2020-06-01T12:00:00.000Z",
    },
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{
          id: serverId,
          daemon: connectedDaemon,
        }]),
      }),
    }),
  } as unknown as Db;

  const projections = await readProjectionsForServers(db, [serverId]);
  const read = projections.get(serverId);
  assert(read);
  assertEquals(read.connected, true);
  assertEquals(read.lastSeenAt, "2020-06-01T12:05:00.000Z");
  assertEquals(read.connectedAt, "2020-06-01T12:00:00.000Z");
  assertEquals("hostname" in read, false);
});

Deno.test("projectServerDaemon agent trigger backfills builtAt for unchanged build", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
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

Deno.test("projectServerDaemon update-expired writes projection.update as expired", async () => {
  const { db, getDaemon } = createMockDb({
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

  const wrote = await projectServerDaemon(db, serverId, {
    kind: "update-expired",
    requestId: "req-1",
    finishedAt: "2020-01-01T00:05:00.000Z",
  });

  assertEquals(wrote, true);
  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "expired");
  assertEquals(update?.requestId, "req-1");
  assertEquals(update?.finishedAt, "2020-01-01T00:05:00.000Z");
});

Deno.test("listConnectedServerIdsFromProjection includes status.connected rows", async () => {
  const connectedDaemon: ServerDaemonState = {
    key: baseKey,
    status: {
      connected: true,
      daemonStatus: "online",
      lastSeenAt: "2020-01-01T00:00:00.000Z",
      connectedAt: "2020-01-01T00:00:00.000Z",
      disconnectedAt: null,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([
          { id: serverId, daemon: connectedDaemon },
        ]),
      }),
    }),
  } as unknown as Db;

  const ids = await listConnectedServerIdsFromProjection(db);
  assertEquals(ids, [serverId]);
});

Deno.test("steadyStateInboundSkipsDbRead gates on lastSeenAt only", () => {
  const recentAt = new Date().toISOString();
  const agent = {
    commit: "abc123",
    buildId: "build-1",
    channel: "trunk" as const,
  };
  const snapshot = {
    serverId,
    version: 0,
    updatedAt: recentAt,
    connected: true,
    lastSeenAt: recentAt,
    agent,
  };

  assertEquals(
    steadyStateInboundSkipsDbRead(snapshot, {
      at: new Date(Date.now() + 1000).toISOString(),
      agent,
    }),
    true,
  );
});

function offlineDaemonState(
  id: string,
  disconnectedAt: string,
): { id: string; daemon: ServerDaemonState } {
  return {
    id,
    daemon: {
      key: baseKey,
      status: {
        connected: false,
        daemonStatus: "offline",
        lastSeenAt: disconnectedAt,
        connectedAt: "2020-01-01T00:00:00.000Z",
        disconnectedAt,
        statusChangedAt: disconnectedAt,
      },
    },
  };
}

Deno.test("listRecentlyOfflineServersForSweep returns recent offline rows only", async () => {
  const nowMs = Date.parse("2020-06-01T12:00:00.000Z");
  const recentAt = new Date(nowMs - 60_000).toISOString();
  const staleAt = new Date(nowMs - RECENT_OFFLINE_SWEEP_MS - 60_000).toISOString();
  const rows = [
    offlineDaemonState("srv-recent-1", recentAt),
    offlineDaemonState("srv-recent-2", recentAt),
    offlineDaemonState("srv-stale", staleAt),
    ...Array.from({ length: 20 }, (_, index) =>
      offlineDaemonState(`srv-old-${index}`, staleAt)
    ),
  ];

  const db = {
    select: () => ({
      from: () => ({
        where: (_predicate: unknown) => ({
          orderBy: (..._order: unknown[]) => Promise.resolve(
            rows.filter((row) => {
              const status = row.daemon.status;
              const recentTimestamp = status?.disconnectedAt ??
                status?.statusChangedAt;
              if (!recentTimestamp) return false;
              return Date.parse(recentTimestamp) >=
                nowMs - RECENT_OFFLINE_SWEEP_MS;
            }).sort((a, b) => {
              const aAt = a.daemon.status?.disconnectedAt ?? "";
              const bAt = b.daemon.status?.disconnectedAt ?? "";
              const byTime = bAt.localeCompare(aAt);
              if (byTime !== 0) return byTime;
              return a.id.localeCompare(b.id);
            }),
          ),
        }),
      }),
    }),
  } as unknown as Db;

  const candidates = await listRecentlyOfflineServersForSweep(db, { nowMs });

  assertEquals(candidates.length, 2);
  assert(candidates.every((row) => row.id.startsWith("srv-recent-")));
  assertEquals(candidates[0]?.offlineAt, recentAt);
  assertEquals(candidates[1]?.offlineAt, recentAt);
});

Deno.test("rotateSweepBatch selects candidates beyond the first budget on later ticks", () => {
  const items = Array.from({ length: 1_000 }, (_, index) => ({
    id: `srv-${String(index).padStart(4, "0")}`,
    connectedAt: null,
  }));

  const firstTick = rotateSweepBatch(items, 900, 0);
  const laterTick = rotateSweepBatch(items, 900, 60_000);

  assertEquals(firstTick.length, 900);
  assertEquals(laterTick.length, 900);
  assertEquals(firstTick[0]?.id, "srv-0000");
  assertEquals(laterTick[0]?.id, "srv-0900");
  assertEquals(
    firstTick.some((candidate) => candidate.id === "srv-0999"),
    false,
  );
  assertEquals(
    laterTick.some((candidate) => candidate.id === "srv-0999"),
    true,
  );
});
