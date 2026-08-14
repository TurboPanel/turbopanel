import { assertEquals } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import type {
  CellDiagnostics,
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "./contracts.ts";
import {
  fetchDaemonCellDiagnostics,
  fetchDaemonServerCell,
} from "./server-diagnostics.ts";

const serverId = "srv-diagnostics";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const sampleDiagnostics: CellDiagnostics = {
  backend: "redis",
  usesHibernationWebSocket: false,
  constructorCalls: 1,
  wsAccepted: 2,
  wsClosed: 0,
  alarmInvocations: 0,
  heartbeatCount: 5,
  commandDispatchCount: 1,
  cleanupCount: 0,
  fetchByRoute: {},
  storageReads: 10,
  storageWrites: 3,
  storageByCallSite: {},
};

function createRegistry(
  cell: Partial<DaemonCell>,
): DaemonCellRegistry {
  const fullCell = {
    attachDaemonSocket: async () => {
      throw new Error("not used");
    },
    detachDaemonSocket: async () => {},
    recordInbound: async () => {},
    getSnapshot: async () => ({
      serverId: "",
      version: 0,
      updatedAt: "",
      connected: false,
    }),
    putSnapshot: async () => ({
      serverId: "",
      version: 0,
      updatedAt: "",
      connected: false,
    }),
    enqueue: async () => {
      throw new Error("not used");
    },
    markSent: async () => {},
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async () => {
      throw new Error("not used");
    },
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: async () => {},
    readOutboxBatch: async () => [],
    ackOutbox: async () => {},
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: async () => {},
    ...cell,
  } satisfies DaemonCell;

  return {
    getCell: () => fullCell,
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  };
}

test("fetchDaemonServerCell returns 503 when registry is unavailable", async () => {
  const db = {} as Db;
  const result = await fetchDaemonServerCell(db, undefined, serverId);
  assertEquals(result, {
    ok: false,
    status: 503,
    error: "Daemon cell registry unavailable",
  });
});

test("fetchDaemonServerCell returns 404 when snapshot has no serverId", async () => {
  const db = {} as Db;
  const registry = createRegistry({
    getSnapshot: async () => ({
      serverId: "",
      version: 0,
      updatedAt: "2020-01-01T00:00:00.000Z",
      connected: false,
    }),
  });

  const result = await fetchDaemonServerCell(db, registry, serverId);
  assertEquals(result, {
    ok: false,
    status: 404,
    error: "server not found",
  });
});

test("fetchDaemonServerCell returns snapshot when cell exists", async () => {
  const db = {} as Db;
  const snapshot: DaemonCellSnapshot = {
    serverId,
    version: 2,
    updatedAt: "2020-01-02T00:00:00.000Z",
    connected: true,
    connectedAt: "2020-01-02T00:00:00.000Z",
  };
  const registry = createRegistry({
    getSnapshot: async () => snapshot,
  });

  const result = await fetchDaemonServerCell(db, registry, serverId);
  assertEquals(result, { ok: true, snapshot });
});

test("fetchDaemonCellDiagnostics rejects when debug is disabled", async () => {
  const registry = createRegistry({});
  const result = await fetchDaemonCellDiagnostics(registry, serverId, {
    debugEnabled: false,
  });
  assertEquals(result, {
    ok: false,
    status: 404,
    error: "daemon debug disabled",
  });
});

test("fetchDaemonCellDiagnostics rejects when registry is missing", async () => {
  const result = await fetchDaemonCellDiagnostics(undefined, serverId, {
    debugEnabled: true,
  });
  assertEquals(result, {
    ok: false,
    status: 404,
    error: "daemon debug disabled",
  });
});

test("fetchDaemonCellDiagnostics rejects when getDiagnostics is unavailable", async () => {
  const registry = createRegistry({
    getDiagnostics: undefined,
  });
  const result = await fetchDaemonCellDiagnostics(registry, serverId, {
    debugEnabled: true,
  });
  assertEquals(result, {
    ok: false,
    status: 404,
    error: "diagnostics unavailable",
  });
});

test("fetchDaemonCellDiagnostics returns diagnostics when debug is enabled", async () => {
  const registry = createRegistry({
    getDiagnostics: async () => sampleDiagnostics,
  });
  const result = await fetchDaemonCellDiagnostics(registry, serverId, {
    debugEnabled: true,
  });
  assertEquals(result, { ok: true, diagnostics: sampleDiagnostics });
});

test("fetchDaemonCellDiagnostics surfaces storage counters for billing audits", async () => {
  const withCallSites: CellDiagnostics = {
    ...sampleDiagnostics,
    storageReads: 42,
    storageWrites: 7,
    storageByCallSite: {
      "sql:getSnapshot": { reads: 2, writes: 0 },
      "setAlarm": { reads: 0, writes: 1 },
    },
  };
  const registry = createRegistry({
    getDiagnostics: async () => withCallSites,
  });
  const result = await fetchDaemonCellDiagnostics(registry, serverId, {
    debugEnabled: true,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.diagnostics.storageReads, 42);
  assertEquals(result.diagnostics.storageWrites, 7);
  assertEquals(result.diagnostics.storageByCallSite["sql:getSnapshot"]?.reads, 2);
  assertEquals(result.diagnostics.storageByCallSite["setAlarm"]?.writes, 1);
});
