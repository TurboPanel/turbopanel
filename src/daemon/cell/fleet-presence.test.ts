import { assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import {
  buildDefaultDaemonStatus,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from "../authn/daemon-state.ts";
import type { DaemonCellRegistry, DaemonCellSnapshot } from "./contracts.ts";
// Canonical import path: ./server-status.ts (fleet-presence.ts is a re-export shim).
import { resolveFleetPresence } from "./server-status.ts";

const serverId = "srv-fleet-presence";

function mergeDaemonStatus(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): ServerDaemonState {
  return {
    ...daemon,
    status: {
      ...buildDefaultDaemonStatus(),
      ...(daemon.status ?? {}),
      ...statusOverrides,
    },
  };
}

function createMockDb(
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): Db {
  const daemon = mergeDaemonStatus(initialDaemon, statusOverrides);
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{
          id: serverId,
          daemon,
          metadata: { hostname: "host-1" },
        }]),
      }),
    }),
  } as unknown as Db;
  return db;
}

function createThrowingSnapshotRegistry(
  options: { onlineIds?: string[] } = {},
): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error("getSnapshots must not be called on default path");
    },
    listOnlineServerIds: async () => options.onlineIds ?? [],
    getSnapshots: async () => {
      throw new Error("getSnapshots must not be called on default path");
    },
    purge: async () => {},
  };
}

function createSnapshotRegistry(
  options: {
    onlineIds?: string[];
    snapshots?: Map<string, DaemonCellSnapshot>;
  } = {},
): DaemonCellRegistry {
  const snapshots = options.snapshots ?? new Map<string, DaemonCellSnapshot>();
  return {
    getCell: () => {
      throw new Error("not used in fleet presence tests");
    },
    listOnlineServerIds: async () => options.onlineIds ?? [],
    getSnapshots: async (ids: string[]) => {
      const result = new Map<string, DaemonCellSnapshot>();
      for (const id of ids) {
        const snapshot = snapshots.get(id);
        if (snapshot) result.set(id, snapshot);
      }
      return result;
    },
    purge: async () => {},
  };
}

const baseDaemon: ServerDaemonState = {
  key: {
    id: "key-1",
    algorithm: "Ed25519",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
    fingerprint: "fp-1",
    createdAt: "2020-01-01T00:00:00.000Z",
  },
  projection: {
    hostname: "host-1",
  },
};

const baseConnectedStatus: Partial<ServerDaemonStatus> = {
  connected: true,
  daemonStatus: "online",
  connectedAt: "2020-01-01T00:00:00.000Z",
  lastSeenAt: "2020-01-01T00:00:00.000Z",
};

Deno.test("resolveFleetPresence default path is Postgres-only (never calls getSnapshots)", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      ...baseDaemon.projection!,
      agent: { commit: "proj-commit", buildId: "proj-build" },
      remoteAddress: "203.0.113.1",
    },
  };
  const lastSeenAt = new Date().toISOString();
  const db = createMockDb(projectedDaemon, {
    ...baseConnectedStatus,
    lastSeenAt,
  });
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
  assertEquals(presence.get(serverId)?.lastInboundAt, lastSeenAt);
  assertEquals(presence.get(serverId)?.agent?.commit, "proj-commit");
  assertEquals(presence.get(serverId)?.remoteAddress, "203.0.113.1");
});

Deno.test("resolveFleetPresence online index corrects stale offline projection without snapshots", async () => {
  const db = createMockDb(baseDaemon, {
    connected: false,
    daemonStatus: "offline",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  });
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

Deno.test("resolveFleetPresence overlays live snapshot when projection marks offline with withSnapshots", async () => {
  const db = createMockDb(baseDaemon, {
    connected: false,
    daemonStatus: "offline",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  });
  const freshLastSeen = new Date().toISOString();
  const registry = createSnapshotRegistry({
    onlineIds: [],
    snapshots: new Map([
      [serverId, {
        serverId,
        version: 1,
        updatedAt: freshLastSeen,
        connected: true,
        lastSeenAt: freshLastSeen,
        lastInboundAt: freshLastSeen,
      }],
    ]),
  });

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, true);
  assertEquals(presence.get(serverId)?.lastInboundAt, freshLastSeen);
});

Deno.test("resolveFleetPresence prefers live snapshot.connected over stale projection", async () => {
  const db = createMockDb(baseDaemon, baseConnectedStatus);
  const registry = createSnapshotRegistry({
    onlineIds: [serverId],
    snapshots: new Map([
      [serverId, {
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        lastSeenAt: new Date().toISOString(),
      }],
    ]),
  });

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, false);
});

Deno.test("resolveFleetPresence uses online index when snapshot is absent", async () => {
  const db = createMockDb(baseDaemon, {
    connected: false,
    daemonStatus: "offline",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  });
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

Deno.test("resolveFleetPresence falls back to projection when registry unavailable", async () => {
  const db = createMockDb(baseDaemon, baseConnectedStatus);
  const presence = await resolveFleetPresence(db, undefined, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

Deno.test("resolveFleetPresence treats stale lastSeenAt as disconnected", async () => {
  const db = createMockDb(baseDaemon, baseConnectedStatus);
  const staleLastSeen = new Date(Date.now() - 90_000).toISOString();
  const registry = createSnapshotRegistry({
    snapshots: new Map([
      [serverId, {
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: true,
        lastSeenAt: staleLastSeen,
      }],
    ]),
  });

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, false);
});

Deno.test("resolveFleetPresence reads __direct__ from projection for connected servers", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      ...baseDaemon.projection!,
      remoteAddress: "__direct__",
    },
  };
  const db = createMockDb(projectedDaemon, {
    ...baseConnectedStatus,
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  });
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.directAttach, true);
  assertEquals(presence.get(serverId)?.remoteAddress, null);
});

Deno.test("resolveFleetPresence reads hostname and machineId from metadata over projection", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      hostname: "stale-projection-host",
      machineId: "stale-projection-mid",
    },
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{
          id: serverId,
          daemon: mergeDaemonStatus(projectedDaemon, baseConnectedStatus),
          metadata: {
            hostname: "canonical-host",
            machineId: "canonical-mid",
          },
        }]),
      }),
    }),
  } as unknown as Db;
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.hostname, "canonical-host");
  assertEquals(presence.get(serverId)?.machineId, "canonical-mid");
});

Deno.test("resolveFleetPresence keeps connected when lastSeenAt is fresh", async () => {
  const db = createMockDb(baseDaemon, baseConnectedStatus);
  const freshLastSeen = new Date().toISOString();
  const registry = createSnapshotRegistry({
    snapshots: new Map([
      [serverId, {
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: true,
        lastSeenAt: freshLastSeen,
      }],
    ]),
  });

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, true);
});
