import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import type {
  DaemonCell,
  DaemonCellLiveness,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "./contracts.ts";
import {
  isStale,
  OFFLINE_SWEEP_STALE_MS,
  resetOfflineSweepNullGraceForTests,
  SELF_HEAL_SWEEP_BUDGET,
  sweepOnce,
  updateNullGraceBookkeeping,
} from "./offline-sweep.ts";
import type { Db } from "../../db.ts";

const serverId = "srv-offline-sweep-null-grace";

function connectedWithNullPing(): DaemonCellLiveness {
  return { connected: true, lastPingAtMs: null };
}

function connectedWithWarmPing(nowMs: number): DaemonCellLiveness {
  return { connected: true, lastPingAtMs: nowMs - 30_000 };
}

it("offline sweep first null auto-response observation is not stale", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const connectedAt = new Date(nowMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, nowMs);

  assertEquals(isStale(serverId, liveness, nowMs, connectedAt), false);
});

it("offline sweep repeated null past grace is stale", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const connectedAt = new Date(firstTickMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, firstTickMs);

  const laterMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  updateNullGraceBookkeeping(serverId, liveness, laterMs);

  assertEquals(isStale(serverId, liveness, laterMs, connectedAt), true);
});

it("offline sweep warm live ping is not stale within grace", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithWarmPing(nowMs);

  updateNullGraceBookkeeping(serverId, liveness, nowMs);

  assertEquals(isStale(serverId, liveness, nowMs, null), false);
});

it("offline sweep warm live ping clears null grace bookkeeping", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const nullLiveness = connectedWithNullPing();
  const connectedAt = new Date(firstTickMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, nullLiveness, firstTickMs);
  assertEquals(
    isStale(serverId, nullLiveness, firstTickMs, connectedAt),
    false,
  );

  const warmMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  const warmLiveness = connectedWithWarmPing(warmMs);
  updateNullGraceBookkeeping(serverId, warmLiveness, warmMs);

  assertEquals(isStale(serverId, warmLiveness, warmMs, connectedAt), false);
});

it("offline sweep disconnected liveness is stale immediately", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;

  updateNullGraceBookkeeping(
    serverId,
    { connected: false, lastPingAtMs: null },
    nowMs,
  );

  assertEquals(
    isStale(serverId, { connected: false, lastPingAtMs: null }, nowMs, null),
    true,
  );
});

it("offline sweep old connectedAt with null ping is not stale on first observation", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const oldConnectedAt = new Date(
    nowMs - OFFLINE_SWEEP_STALE_MS - 1,
  ).toISOString();

  assertEquals(isStale(serverId, liveness, nowMs, oldConnectedAt), false);
});

it("offline sweep old connectedAt becomes stale after null grace persists", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const oldConnectedAt = new Date(
    firstTickMs - OFFLINE_SWEEP_STALE_MS - 1,
  ).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, firstTickMs);

  const laterMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  updateNullGraceBookkeeping(serverId, liveness, laterMs);

  assertEquals(isStale(serverId, liveness, laterMs, oldConnectedAt), true);
});

// --- sweepOnce AE short-circuit cases ---

const ID_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ID_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

type FakeCell = DaemonCell & {
  checkLivenessCalls: number;
  liveness: DaemonCellLiveness;
};

function createFakeCell(liveness: DaemonCellLiveness): FakeCell {
  const cell = {
    checkLivenessCalls: 0,
    liveness,
    checkLiveness(): Promise<DaemonCellLiveness> {
      cell.checkLivenessCalls += 1;
      return Promise.resolve(cell.liveness);
    },
  } as FakeCell;
  return new Proxy(cell, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string") {
        return () => {
          throw new Error(
            `unexpected DaemonCell.${prop} call in sweepOnce test`,
          );
        };
      }
      return undefined;
    },
  });
}

function createFakeRegistry(
  cells: Map<string, FakeCell>,
): DaemonCellRegistry {
  return {
    getCell(id: string): DaemonCell {
      const cell = cells.get(id);
      if (!cell) throw new Error(`no fake cell for ${id}`);
      return cell;
    },
    listOnlineServerIds(): Promise<string[]> {
      return Promise.resolve([...cells.keys()]);
    },
    getSnapshots(): Promise<Map<string, DaemonCellSnapshot>> {
      return Promise.resolve(new Map());
    },
    purge(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function inertEnv(): CloudflareBindings {
  return {} as CloudflareBindings;
}

function inertDb(): Db {
  return {} as Db;
}

it("sweepOnce: AE-active connected server skips checkLiveness", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([[ID_A, cell]]);
  const disconnected: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () =>
      Promise.resolve(new Map([[ID_A, Date.now()]])),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 0);
  assertEquals(disconnected, []);
});

it("sweepOnce: connected absent from AE set is probed and demoted", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({ connected: false, lastPingAtMs: null });
  const cells = new Map([[ID_A, cell]]);
  const disconnected: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () =>
      Promise.resolve([{ id: ID_A, connectedAt: new Date().toISOString() }]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: (_db, id) => {
      disconnected.push(id);
      return Promise.resolve();
    },
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cell.checkLivenessCalls, 1);
  assertEquals(disconnected, [ID_A]);
});

it("sweepOnce: AE unavailable (null) falls back to check-all", async () => {
  resetOfflineSweepNullGraceForTests();
  const cellA = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cellB = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([
    [ID_A, cellA],
    [ID_B, cellB],
  ]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(null),
    listConnected: () =>
      Promise.resolve([
        { id: ID_A, connectedAt: new Date().toISOString() },
        { id: ID_B, connectedAt: new Date().toISOString() },
      ]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cellA.checkLivenessCalls, 1);
  assertEquals(cellB.checkLivenessCalls, 1);
});

it("sweepOnce: AE resolve throws falls back to check-all", async () => {
  resetOfflineSweepNullGraceForTests();
  const cellA = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cellB = createFakeCell({ connected: true, lastPingAtMs: Date.now() });
  const cells = new Map([
    [ID_A, cellA],
    [ID_B, cellB],
  ]);

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.reject(new Error("ae boom")),
    listConnected: () =>
      Promise.resolve([
        { id: ID_A, connectedAt: new Date().toISOString() },
        { id: ID_B, connectedAt: new Date().toISOString() },
      ]),
    listRecentlyOffline: () => Promise.resolve([]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => Promise.resolve(),
  });

  assertEquals(cellA.checkLivenessCalls, 1);
  assertEquals(cellB.checkLivenessCalls, 1);
});

it("sweepOnce: AE-active self-heal is capped by SELF_HEAL_SWEEP_BUDGET", async () => {
  resetOfflineSweepNullGraceForTests();
  const overBudget = SELF_HEAL_SWEEP_BUDGET + 50;
  const sampleAtMs = Date.now();
  const offlineAt = new Date(sampleAtMs - 60_000).toISOString();
  const recentlyOffline = Array.from({ length: overBudget }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return {
      id,
      connectedAt: new Date().toISOString(),
      offlineAt,
    };
  });
  const activeById = new Map(
    recentlyOffline.map((r) => [r.id, sampleAtMs] as const),
  );
  const cells = new Map(
    recentlyOffline.map((r) => [
      r.id,
      createFakeCell({ connected: true, lastPingAtMs: Date.now() }),
    ]),
  );
  const healed: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    resolveActiveServerIds: () => Promise.resolve(activeById),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () => Promise.resolve(recentlyOffline),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => {
      throw new Error(
        "AE-direct heal must not call onConnected (cell path)",
      );
    },
    onConnectedFromEvidence: (_db, id) => {
      healed.push(id);
      return Promise.resolve();
    },
  });

  assertEquals(healed.length, SELF_HEAL_SWEEP_BUDGET);
  // Direct AE heal skips checkLiveness — none of the budgeted cells should
  // have been probed (all were AE-active with post-offline evidence).
  for (const cell of cells.values()) {
    assertEquals(cell.checkLivenessCalls, 0);
  }
});

it("sweepOnce: AE-direct self-heal never calls registry.getCell or getSnapshot", async () => {
  resetOfflineSweepNullGraceForTests();
  const connectedAt = "2020-01-01T00:00:00.000Z";
  const offlineAt = "2020-01-01T00:00:00.000Z";
  const aeLatestMs = Date.parse("2020-01-01T00:01:00.000Z");
  const getCellCalls: string[] = [];
  const healed: Array<{ id: string; connectedAt?: string | null }> = [];

  const registry: DaemonCellRegistry = {
    getCell(id: string): DaemonCell {
      getCellCalls.push(id);
      throw new Error(
        `AE-direct heal must not call registry.getCell(${id})`,
      );
    },
    listOnlineServerIds(): Promise<string[]> {
      return Promise.resolve([]);
    },
    getSnapshots(): Promise<Map<string, DaemonCellSnapshot>> {
      throw new Error("getSnapshots must not be called");
    },
    purge(): Promise<void> {
      return Promise.resolve();
    },
  };

  await sweepOnce(inertEnv(), inertDb(), {
    registry,
    resolveActiveServerIds: () =>
      Promise.resolve(new Map([[ID_A, aeLatestMs]])),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () =>
      Promise.resolve([{ id: ID_A, connectedAt, offlineAt }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: () => {
      throw new Error("AE-direct heal must not call onConnected");
    },
    onConnectedFromEvidence: (_db, id, at) => {
      healed.push({ id, connectedAt: at });
      return Promise.resolve();
    },
  });

  assertEquals(getCellCalls, []);
  assertEquals(healed, [{ id: ID_A, connectedAt }]);
});

it("sweepOnce: probed self-heal still uses onConnected after checkLiveness", async () => {
  resetOfflineSweepNullGraceForTests();
  const cell = createFakeCell({
    connected: true,
    lastPingAtMs: Date.now() - 30_000,
  });
  const cells = new Map([[ID_A, cell]]);
  const probedHealed: string[] = [];
  const directHealed: string[] = [];

  await sweepOnce(inertEnv(), inertDb(), {
    registry: createFakeRegistry(cells),
    // AE map is non-null but empty — recently-offline ID_A is not AE-active,
    // so it goes through the probed heal path.
    resolveActiveServerIds: () => Promise.resolve(new Map()),
    listConnected: () => Promise.resolve([]),
    listRecentlyOffline: () =>
      Promise.resolve([{
        id: ID_A,
        connectedAt: new Date().toISOString(),
        offlineAt: new Date().toISOString(),
      }]),
    onDisconnected: () => Promise.resolve(),
    onConnected: (_db, id) => {
      probedHealed.push(id);
      return Promise.resolve();
    },
    onConnectedFromEvidence: (_db, id) => {
      directHealed.push(id);
      return Promise.resolve();
    },
  });

  assertEquals(cell.checkLivenessCalls, 1);
  assertEquals(probedHealed, [ID_A]);
  assertEquals(directHealed, []);
});

it(
  "sweepOnce: clean disconnect after metrics sample does not AE-direct heal",
  async () => {
    resetOfflineSweepNullGraceForTests();
    // Metrics sample lands, then a clean webSocketClose projects offline.
    // The pre-disconnect sample is still inside the AE liveness window — that
    // alone must not undo the offline projection without checkLiveness.
    const nowMs = 1_700_000_000_000;
    const sampleAtMs = nowMs - 30_000;
    const offlineAt = new Date(nowMs - 20_000).toISOString();
    const cell = createFakeCell({ connected: false, lastPingAtMs: null });
    const cells = new Map([[ID_A, cell]]);
    const directHealed: string[] = [];
    const probedHealed: string[] = [];

    await sweepOnce(inertEnv(), inertDb(), {
      registry: createFakeRegistry(cells),
      resolveActiveServerIds: () =>
        Promise.resolve(new Map([[ID_A, sampleAtMs]])),
      listConnected: () => Promise.resolve([]),
      listRecentlyOffline: () =>
        Promise.resolve([{
          id: ID_A,
          connectedAt: new Date(nowMs - 120_000).toISOString(),
          offlineAt,
        }]),
      onDisconnected: () => Promise.resolve(),
      onConnected: (_db, id) => {
        probedHealed.push(id);
        return Promise.resolve();
      },
      onConnectedFromEvidence: (_db, id) => {
        directHealed.push(id);
        return Promise.resolve();
      },
    });

    assertEquals(directHealed, []);
    assertEquals(cell.checkLivenessCalls, 1);
    // Cell reports disconnected — probed path must not heal either.
    assertEquals(probedHealed, []);
  },
);
