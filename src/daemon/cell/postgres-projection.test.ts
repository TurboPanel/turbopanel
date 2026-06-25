import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "../authn/daemon-state.ts";
import {
  PROJECTION_SUMMARY_REFRESH_MS,
  projectServerDaemon,
} from "./postgres-projection.ts";
import { onDaemonDisconnected } from "./control-plane-monitor.ts";

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
