import { assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "../authn/daemon-state.ts";
import type { DaemonCellRegistry } from "./contracts.ts";
import { onDaemonHeartbeat } from "./control-plane-monitor.ts";
import { resolveFleetPresence } from "./fleet-presence.ts";

const serverId = "srv-heartbeat-agent";

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

function createTrackingDb(initialDaemon: ServerDaemonState): {
  db: Db;
  getDaemon: () => ServerDaemonState;
} {
  let daemon = initialDaemon;

  const row = {
    id: serverId,
    daemon,
    metadata: { hostname: "host-1" },
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ daemon }]),
          then: (
            resolve: (value: unknown) => void,
            reject?: (reason: unknown) => void,
          ) => {
            row.daemon = daemon;
            return Promise.resolve([row]).then(resolve, reject);
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        if (patch.daemon) {
          daemon = patch.daemon as ServerDaemonState;
          row.daemon = daemon;
        }
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  } as unknown as Db;

  return { db, getDaemon: () => daemon };
}

function createEmptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error("not used");
    },
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  };
}

Deno.test("onDaemonHeartbeat projects agent.commit for update status via resolveFleetPresence", async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      connected: true,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  const agent = {
    commit: "heartbeat-commit",
    buildId: "heartbeat-build",
    channel: "trunk" as const,
  };

  await onDaemonHeartbeat(db, serverId, {} as never, agent);

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
