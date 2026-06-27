import { assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "../authn/daemon-state.ts";
import type { DaemonCellRegistry, DaemonCellSnapshot } from "./contracts.ts";
import { resolveFleetPresence } from "./fleet-presence.ts";

const serverId = "srv-fleet-presence";

function createMockDb(initialDaemon: ServerDaemonState): Db {
  let daemon = initialDaemon;
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

function createMockRegistry(
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
    connected: true,
    lastProjectedAt: "2020-01-01T00:00:00.000Z",
  },
};

Deno.test("resolveFleetPresence prefers live snapshot.connected over stale projection", async () => {
  const db = createMockDb(baseDaemon);
  const registry = createMockRegistry({
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

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, false);
});

Deno.test("resolveFleetPresence uses online index when snapshot is absent", async () => {
  const disconnectedDaemon: ServerDaemonState = {
    ...baseDaemon,
    projection: {
      ...baseDaemon.projection!,
      connected: false,
    },
  };
  const db = createMockDb(disconnectedDaemon);
  const registry = createMockRegistry({ onlineIds: [serverId] });

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

Deno.test("resolveFleetPresence falls back to projection when registry unavailable", async () => {
  const db = createMockDb(baseDaemon);
  const presence = await resolveFleetPresence(db, undefined, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});

Deno.test("resolveFleetPresence treats stale lastSeenAt as disconnected", async () => {
  const db = createMockDb(baseDaemon);
  const staleLastSeen = new Date(Date.now() - 90_000).toISOString();
  const registry = createMockRegistry({
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

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, false);
});

Deno.test("resolveFleetPresence keeps connected when lastSeenAt is fresh", async () => {
  const db = createMockDb(baseDaemon);
  const freshLastSeen = new Date().toISOString();
  const registry = createMockRegistry({
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

  const presence = await resolveFleetPresence(db, registry, [serverId]);
  assertEquals(presence.get(serverId)?.connected, true);
});
