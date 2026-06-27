import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "../authn/daemon-state.ts";
import {
  agentChanged,
  mergeAgentPreserving,
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

const testAgent = {
  commit: "abc123",
  buildId: "build-1",
  channel: "trunk",
};

Deno.test("projectServerDaemon online writes lastSeenAt to cell snapshot", async () => {
  const putSnapshotPatches: Partial<import("./contracts.ts").DaemonCellSnapshot>[] =
    [];
  const cell = {
    putSnapshot: async (
      patch: Partial<import("./contracts.ts").DaemonCellSnapshot>,
    ) => {
      putSnapshotPatches.push(patch);
      return {
        serverId,
        version: putSnapshotPatches.length,
        updatedAt: new Date().toISOString(),
        connected: true,
        ...patch,
      };
    },
  };

  const { db } = createMockDb({ key: baseKey });

  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: { hostname: "host-1", machineId: "mid-1" },
    connectedAt: "2020-01-01T00:00:00.000Z",
  }, {
    cell: cell as unknown as import("./contracts.ts").DaemonCell,
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(putSnapshotPatches.length, 1);
  assertEquals(typeof putSnapshotPatches[0]?.lastSeenAt, "string");
});

Deno.test("projectServerDaemon offline writes lastSeenAt to cell", async () => {
  const putSnapshotPatches: Partial<import("./contracts.ts").DaemonCellSnapshot>[] =
    [];
  const cell = {
    putSnapshot: async (
      patch: Partial<import("./contracts.ts").DaemonCellSnapshot>,
    ) => {
      putSnapshotPatches.push(patch);
      return {
        serverId,
        version: putSnapshotPatches.length,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      };
    },
  };

  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  await projectServerDaemon(db, serverId, { kind: "offline" }, {
    cell: cell as unknown as import("./contracts.ts").DaemonCell,
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(updateCalls.length, 1);
  assertEquals(putSnapshotPatches.length, 1);
  assertEquals(typeof putSnapshotPatches[0]?.lastSeenAt, "string");
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.connected, false);
});

Deno.test("onDaemonDisconnected projects disconnected", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  await onDaemonDisconnected(db, serverId);

  assertEquals(updateCalls.length, 1);
  const merged = parseServerDaemonState(updateCalls[0]?.daemon);
  assertEquals(merged?.projection?.connected, false);
});

Deno.test("projectServerDaemon preserves server.daemon.key on write", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
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

Deno.test("projectServerDaemon disconnect preserves agent", async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      connected: true,
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

Deno.test("agentChanged detects optional field backfill for unchanged build", () => {
  const current = {
    connected: true,
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
