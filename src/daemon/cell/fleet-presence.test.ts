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
import {
  fleetPresenceToConnection,
  isServerConnected,
  resolveFleetPresence,
  resolveOnlineFleetPresence,
} from "./server-status.ts";
import {
  buildProjectionsFromDaemonRows,
} from "./postgres-projection.ts";

const serverId = "srv-fleet-presence";

/**
 * Mock row shape mirrors `resolveFleetPresence`'s select — `daemon` jsonb
 * (`{ key, projection? }`, never `status`) plus stored liveness columns
 * (`connected`, `statusChangedAt`) and identity columns.
 */
type MockRow = {
  id: string;
  daemon: ServerDaemonState;
  metadata: ServerMetadata | null;
  hostname: string | null;
  machineKey: string | null;
  connected: boolean;
  statusChangedAt: string | null;
};

function buildMockRow(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
  identity: { hostname?: string | null; machineKey?: string | null } = {},
  metadata: ServerMetadata | null = null,
): MockRow {
  const status = { ...buildDefaultDaemonStatus(), ...statusOverrides };
  return {
    id: serverId,
    daemon,
    metadata,
    hostname: identity.hostname ?? "host-1",
    machineKey: identity.machineKey ?? null,
    connected: status.connected,
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
  statusChangedAt: "2020-01-01T00:00:00.000Z",
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
      daemonBuild: { commit: "proj-commit", buildId: "proj-build" },
      remoteAddress: "203.0.113.1",
    },
  };
  const statusChangedAt = new Date().toISOString();
  const db = createMockDb(buildMockRow(projectedDaemon, {
    ...baseConnectedStatus,
    statusChangedAt,
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
  assertEquals(presence.get(serverId)?.lastInboundAt, null);
  assertEquals(presence.get(serverId)?.connectedAt, statusChangedAt);
  assertEquals(presence.get(serverId)?.daemonBuild?.commit, "proj-commit");
  assertEquals(presence.get(serverId)?.remoteAddress, "203.0.113.1");
});

test("resolveFleetPresence default path never consults the online index (Postgres columns win)", async () => {
  // The default (no `withSnapshots`) path is Postgres-only by design — coarse
  // presence comes from `row.connected` / the projection, never from
  // `registry.listOnlineServerIds()`. A registry reporting this server online
  // does not override a Postgres-projected offline status.
  const offlineAt = "2020-01-01T00:00:00.000Z";
  const db = createMockDb(buildMockRow(baseDaemon, {
    connected: false,
    statusChangedAt: offlineAt,
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, false);
  assertEquals(presence.get(serverId)?.connectedAt, null);
  assertEquals(presence.get(serverId)?.statusChangedAt, offlineAt);
});

test("resolveFleetPresence overlays live snapshot when projection marks offline with withSnapshots", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, {
    connected: false,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
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
    statusChangedAt: "2020-01-01T00:00:00.000Z",
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
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  }));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.directAttach, true);
  assertEquals(presence.get(serverId)?.remoteAddress, null);
  assertEquals(presence.get(serverId)?.connectedAt, "2020-01-01T00:00:00.000Z");
  assertEquals(presence.get(serverId)?.lastInboundAt, null);
});

test("resolveFleetPresence reads hostname and machineKey from dedicated columns, ignoring stale projection values", async () => {
  const projectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      hostname: "stale-projection-host",
      machineKey: "stale-projection-mid",
    },
  };
  const db = createMockDb(buildMockRow(
    projectedDaemon,
    baseConnectedStatus,
    { hostname: "canonical-host", machineKey: "canonical-mid" },
  ));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.hostname, "canonical-host");
  assertEquals(presence.get(serverId)?.machineKey, "canonical-mid");
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

test("resolveFleetPresence accepts preloaded rows and projections", async () => {
  const row = buildMockRow(baseDaemon, baseConnectedStatus);
  const projections = buildProjectionsFromDaemonRows([{
    id: serverId,
    daemon: baseDaemon,
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  }]);
  const db = {
    select: () => {
      throw new Error("db must not be queried when preloaded");
    },
  } as unknown as Db;
  const registry = createThrowingSnapshotRegistry();

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    preloaded: { rows: [row], projections },
  });
  assertEquals(presence.get(serverId)?.connected, true);
  assertEquals(presence.get(serverId)?.hostname, "host-1");
});

test("resolveFleetPresence returns empty map for empty serverIds", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const presence = await resolveFleetPresence(db, undefined, []);
  assertEquals(presence.size, 0);
});

test("fleetPresenceToConnection maps presence to connection shape", () => {
  const presence = {
    serverId,
    connected: true,
    hostname: "host-1",
    machineKey: null,
    remoteAddress: "203.0.113.1",
    directAttach: false,
    keyId: "key-1",
    connectedAt: "2020-01-01T00:00:00.000Z",
    statusChangedAt: "2020-01-01T00:00:00.000Z",
    lastInboundAt: "2020-01-01T00:00:01.000Z",
    keyLastUsedAt: null,
    geo: null,
    os: null,
    resources: null,
    timeSync: null,
    ips: null,
    docker: null,
  };

  const connection = fleetPresenceToConnection(presence);
  assertEquals(connection.id, serverId);
  assertEquals(connection.serverId, serverId);
  assertEquals(connection.hostname, "host-1");
  assertEquals(connection.authenticated, true);
  assertEquals(connection.connected, true);
  assertEquals(connection.remoteAddress, "203.0.113.1");
  assertEquals(connection.lastInboundAt, Date.parse("2020-01-01T00:00:01.000Z"));
});

test("fleetPresenceToConnection uses zero lastInboundAt when absent", () => {
  const connection = fleetPresenceToConnection({
    serverId,
    connected: false,
    hostname: null,
    machineKey: null,
    remoteAddress: null,
    directAttach: false,
    keyId: null,
    connectedAt: null,
    statusChangedAt: null,
    lastInboundAt: null,
    keyLastUsedAt: null,
    geo: null,
    os: null,
    resources: null,
    timeSync: null,
    ips: null,
    docker: null,
  });
  assertEquals(connection.lastInboundAt, 0);
  assertEquals(connection.connectedAt, "");
});

test("resolveFleetPresence enriches os / resources / timeSync / ips / docker / geo from metadata", async () => {
  const metadata: ServerMetadata = {
    os: {
      family: "linux",
      id: "debian",
      version: "13.5",
      codename: "trixie",
      prettyName: "Debian GNU/Linux 13 (trixie)",
    },
    resources: {
      cpu: { coreCount: 4, threadCount: 8 },
      memory: { totalBytes: 16_000_000_000 },
      swap: { totalBytes: 2_000_000_000 },
    },
    timeSync: {
      timezone: "UTC",
      ntpEnabled: true,
      ntpSynced: true,
    },
    docker: {
      version: "28.3.3",
      composeVersion: "2.39.1",
    },
    ips: [
      { address: "10.0.0.5", version: 4, scope: "private" },
      { address: "203.0.113.50", version: 4, scope: "public" },
    ],
    geo: {
      country: "US",
      region: "TX",
      city: "Austin",
      latitude: "30.27",
      longitude: "-97.74",
      capturedAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const db = createMockDb(
    buildMockRow(baseDaemon, baseConnectedStatus, {}, metadata),
  );
  const registry = createThrowingSnapshotRegistry();

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  const row = presence.get(serverId);
  assertEquals(row?.os?.id, "debian");
  assertEquals(row?.resources?.cpu?.threadCount, 8);
  assertEquals(row?.timeSync?.timezone, "UTC");
  assertEquals(row?.docker?.version, "28.3.3");
  assertEquals(row?.docker?.composeVersion, "2.39.1");
  assertEquals(row?.ips?.find((ip) => ip.scope === "public")?.address, "203.0.113.50");
  assertEquals(row?.geo?.country, "US");
});

test("resolveFleetPresence treats invalid snapshot lastInbound timestamps as disconnected", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const registry = createSnapshotRegistry({
    snapshots: new Map([
      [
        serverId,
        {
          serverId,
          version: 1,
          updatedAt: new Date().toISOString(),
          connected: true,
          connectedAt: new Date().toISOString(),
          lastInboundAt: "not-a-date",
        },
      ],
    ]),
  });

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, false);
});

test("resolveFleetPresence withSnapshots but no registry stays on Postgres columns", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, {
    connected: false,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  }));

  const presence = await resolveFleetPresence(db, undefined, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, false);
  assertEquals(presence.get(serverId)?.lastInboundAt, null);
});

test("resolveFleetPresence prefers projection keyId then falls back to daemon key id", async () => {
  const withProjectionKey: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      ...baseDaemon.projection!,
      keyId: "proj-key",
      remoteAddress: "203.0.113.9",
    },
  };
  const db = createMockDb(
    buildMockRow(withProjectionKey, baseConnectedStatus),
  );
  const presence = await resolveFleetPresence(
    db,
    createThrowingSnapshotRegistry(),
    [serverId],
  );
  assertEquals(presence.get(serverId)?.keyId, "proj-key");

  const keyOnly = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const keyOnlyPresence = await resolveFleetPresence(
    keyOnly,
    createThrowingSnapshotRegistry(),
    [serverId],
  );
  assertEquals(keyOnlyPresence.get(serverId)?.keyId, "key-1");
});

test("resolveFleetPresence falls back lastInboundAt through lastSeenAt then connectedAt", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const connectedAt = new Date().toISOString();
  const registry = createSnapshotRegistry({
    snapshots: new Map([
      [
        serverId,
        {
          serverId,
          version: 1,
          updatedAt: connectedAt,
          connected: true,
          connectedAt,
          // No lastInboundAt / lastSeenAt — connectedAt keeps the socket fresh.
        },
      ],
    ]),
  });

  const presence = await resolveFleetPresence(db, registry, [serverId], {
    withSnapshots: true,
  });
  assertEquals(presence.get(serverId)?.connected, true);
  assertEquals(presence.get(serverId)?.lastInboundAt, connectedAt);
});

test("isServerConnected reads Postgres projection by default", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const registry = createThrowingSnapshotRegistry();

  const connected = await isServerConnected(db, registry, serverId);
  assertEquals(connected, true);
});

test("resolveOnlineFleetPresence returns presence for online server ids", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [serverId] });

  const rows = await resolveOnlineFleetPresence(db, registry);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.serverId, serverId);
  assertEquals(rows[0]?.connected, true);
});

test("resolveOnlineFleetPresence returns empty when no servers are online", async () => {
  const db = createMockDb(buildMockRow(baseDaemon, baseConnectedStatus));
  const registry = createThrowingSnapshotRegistry({ onlineIds: [] });

  const rows = await resolveOnlineFleetPresence(db, registry);
  assertEquals(rows, []);
});
