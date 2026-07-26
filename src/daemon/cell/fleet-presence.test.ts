import { assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import {
  buildDefaultDaemonStatus,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from "../authn/daemon-state.ts";
import type { DaemonCellRegistry, DaemonCellSnapshot } from "./contracts.ts";
// Canonical import path: ./server-status.ts (fleet-presence.ts is a re-export shim).
import { resolveFleetPresence } from "./server-status.ts";

const serverId = "srv-fleet-presence";

/**
 * Mock row shape mirrors `resolveFleetPresence`'s select — `daemon` jsonb
 * (`{ key, projection? }`, never `status`) plus dedicated fleet-status /
 * identity columns (`hostname`, `machineId`, `connected`, `daemonStatus`,
 * `lastSeenAt`, `connectedAt`, `disconnectedAt`, `statusChangedAt`).
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
  identity: { hostname?: string | null; machineId?: string | null } = {},
  metadata: ServerMetadata | null = null,
): MockRow {
  const status = { ...buildDefaultDaemonStatus(), ...statusOverrides };
  return {
    id: serverId,
    daemon,
    metadata,
    hostname: identity.hostname ?? "host-1",
    machineId: identity.machineId ?? null,
    connected: status.connected,
    daemonStatus: status.daemonStatus ?? "unknown",
    lastSeenAt: status.lastSeenAt,
    connectedAt: status.connectedAt,
    disconnectedAt: status.disconnectedAt,
    statusChangedAt: status.statusChangedAt,
  };
}

function createMockDb(row: MockRow): Db {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([row]),
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

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("resolveFleetPresence default path is Postgres-only (never calls getSnapshots)", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      ...baseDaemon.projection!,
      agent: { commit: "proj-commit", buildId: "proj-build" },
      remoteAddress: "203.0.113.1",
    },
  };
  const lastSeenAt = new Date().toISOString();
  const db = createMockDb(buildMockRow(projectedDaemon, {
    ...baseConnectedStatus,
    lastSeenAt,
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
  assertEquals(presence.get(serverId)?.lastInboundAt, lastSeenAt);
  assertEquals(presence.get(serverId)?.agent?.commit, "proj-commit");
  assertEquals(presence.get(serverId)?.remoteAddress, "203.0.113.1");
});

test("resolveFleetPresence default path never consults the online index (Postgres columns win)", async () => {
  // The default (no `withSnapshots`) path is Postgres-only by design — coarse
  // presence comes from `row.connected` / the projection, never from
  // `registry.listOnlineServerIds()`. A registry reporting this server online
  // does not override a Postgres-projected offline status.
  const db = createMockDb(buildMockRow(baseDaemon, {
    connected: false,
    daemonStatus: "offline",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, false);
});

test("resolveFleetPresence overlays live snapshot when projection marks offline with withSnapshots", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, {
    connected: false,
    daemonStatus: "offline",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  }));
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

test("resolveFleetPresence prefers live snapshot.connected over stale projection", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
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

test("resolveFleetPresence reflects the Postgres-projected connected column when snapshot is absent", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, {
    connected: true,
    daemonStatus: "online",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

test("resolveFleetPresence falls back to projection when registry unavailable", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const presence = await resolveFleetPresence(db, undefined, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

test("resolveFleetPresence treats stale lastSeenAt as disconnected", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
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

test("resolveFleetPresence reads __direct__ from projection for connected servers", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      ...baseDaemon.projection!,
      remoteAddress: "__direct__",
    },
  };
  const db = createMockDb(buildMockRow(projectedDaemon, {
    ...baseConnectedStatus,
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.directAttach, true);
  assertEquals(presence.get(serverId)?.remoteAddress, null);
});

test("resolveFleetPresence reads hostname and machineId from dedicated columns, ignoring stale projection values", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      hostname: "stale-projection-host",
      machineId: "stale-projection-mid",
    },
  };
  const db = createMockDb(buildMockRow(
    projectedDaemon,
    baseConnectedStatus,
    { hostname: "canonical-host", machineId: "canonical-mid" },
  ));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.hostname, "canonical-host");
  assertEquals(presence.get(serverId)?.machineId, "canonical-mid");
});

test("resolveFleetPresence keeps connected when lastSeenAt is fresh", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
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
