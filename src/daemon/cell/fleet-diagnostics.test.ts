import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type {
  CellDiagnostics,
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from "./contracts.ts";
import {
  broadcastEchoToFleet,
  collectFleetCellDiagnostics,
  collectFleetCommands,
  enqueueEchoToServer,
  listFleetServerIds,
} from "./fleet-diagnostics.ts";

const serverA = "srv-fleet-a";
const serverB = "srv-fleet-b";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function createStubCell(
  overrides: Partial<DaemonCell> & {
    listRequestsImpl?: (
      limit?: number,
      filter?: { requestKind?: string },
    ) => Promise<PendingRequestRecord[]>;
    enqueueImpl?: DaemonCell["enqueue"];
  } = {},
): DaemonCell {
  return {
    attachDaemonSocket: async () => {
      throw new Error("not used");
    },
    detachDaemonSocket: async () => {},
    recordInbound: async () => {},
    getSnapshot: async () => ({
      serverId: serverA,
      version: 0,
      updatedAt: "",
      connected: false,
    }),
    putSnapshot: async () => ({
      serverId: serverA,
      version: 0,
      updatedAt: "",
      connected: false,
    }),
    enqueue: overrides.enqueueImpl ?? (async () => {
      throw new Error("not used");
    }),
    markSent: async () => {},
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: overrides.listRequestsImpl ?? (async () => []),
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
    getDiagnostics: overrides.getDiagnostics,
    ...overrides,
  };
}

function createRegistry(
  cells: Record<string, DaemonCell>,
): DaemonCellRegistry {
  return {
    getCell: (serverId) => {
      const cell = cells[serverId];
      if (!cell) throw new Error(`missing cell ${serverId}`);
      return cell;
    },
    listOnlineServerIds: async () => Object.keys(cells),
    getSnapshots: async () => new Map(),
    purge: async () => {},
  };
}

test("listFleetServerIds returns all server ids from Postgres", async () => {
  const db = {
    select: () => ({
      from: () => Promise.resolve([{ id: serverA }, { id: serverB }]),
    }),
  } as unknown as Db;

  const ids = await listFleetServerIds(db);
  assertEquals(ids, [serverA, serverB]);
});

test("collectFleetCommands merges command-dispatch rows across servers", async () => {
  const recordA: PendingRequestRecord = {
    serverId: serverA,
    requestId: "req-a",
    requestKind: "command-dispatch",
    status: "done",
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z",
    command: "daemon.ping",
    finishedAt: "2020-01-01T00:00:01.000Z",
    result: { exitCode: 0, stdout: "pong" },
  };
  const recordB: PendingRequestRecord = {
    serverId: serverB,
    requestId: "req-b",
    requestKind: "command-dispatch",
    status: "sent",
    createdAt: "2020-01-02T00:00:00.000Z",
    expiresAt: "2020-01-03T00:00:00.000Z",
    command: "server.reboot",
  };

  const registry = createRegistry({
    [serverA]: createStubCell({
      listRequestsImpl: async (_limit, filter) => {
        assertEquals(filter?.requestKind, "command-dispatch");
        return [recordA];
      },
    }),
    [serverB]: createStubCell({
      listRequestsImpl: async () => [recordB],
    }),
  });

  const commands = await collectFleetCommands(registry, [serverA, serverB], 10);
  assertEquals(commands.length, 2);
  assertEquals(commands[0]?.id, "req-a");
  assertEquals(commands[0]?.status, "done");
  assertEquals(commands[0]?.exitCode, 0);
  assertEquals(commands[0]?.stdout, "pong");
  assertEquals(commands[1]?.id, "req-b");
  assertEquals(commands[1]?.status, "pending");
});

test("collectFleetCommands respects the limit on merged results", async () => {
  const records: PendingRequestRecord[] = Array.from({ length: 5 }, (_, i) => ({
    serverId: serverA,
    requestId: `req-${i}`,
    requestKind: "command-dispatch",
    status: "done",
    createdAt: `2020-01-0${i + 1}T00:00:00.000Z`,
    expiresAt: "2020-01-10T00:00:00.000Z",
    command: "daemon.ping",
  }));

  const registry = createRegistry({
    [serverA]: createStubCell({
      listRequestsImpl: async () => records,
    }),
  });

  const commands = await collectFleetCommands(registry, [serverA], 2);
  assertEquals(commands.length, 2);
  assertEquals(commands[0]?.id, "req-3");
  assertEquals(commands[1]?.id, "req-4");
});

test("enqueueEchoToServer enqueues an echo envelope", async () => {
  let enqueuedKind: string | undefined;
  const registry = createRegistry({
    [serverA]: createStubCell({
      enqueueImpl: async (outbound) => {
        enqueuedKind = outbound.kind;
        return {
          serverId: serverA,
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          status: "queued",
          createdAt: outbound.at,
          expiresAt: outbound.at,
        };
      },
    }),
  });

  await enqueueEchoToServer(registry, serverA, { hello: "world" });
  assertEquals(enqueuedKind, "echo");
});

test("broadcastEchoToFleet counts successful enqueues and skips failures", async () => {
  const registry = createRegistry({
    [serverA]: createStubCell({
      enqueueImpl: async () => ({
        serverId: serverA,
        requestId: "req-1",
        requestKind: "echo",
        status: "queued",
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-02T00:00:00.000Z",
      }),
    }),
    [serverB]: createStubCell({
      enqueueImpl: async () => {
        throw new Error("enqueue failed");
      },
    }),
  });

  const sent = await broadcastEchoToFleet(registry, [serverA, serverB], {
    probe: true,
  });
  assertEquals(sent, 1);
});

test("collectFleetCellDiagnostics returns empty when debug is disabled", async () => {
  const registry = createRegistry({
    [serverA]: createStubCell({
      getDiagnostics: async () => ({
        backend: "durable-object",
        usesHibernationWebSocket: true,
        constructorCalls: 0,
        wsAccepted: 0,
        wsClosed: 0,
        alarmInvocations: 0,
        heartbeatCount: 0,
        commandDispatchCount: 0,
        cleanupCount: 0,
        fetchByRoute: {},
        storageReads: 0,
        storageWrites: 0,
        storageByCallSite: {},
      }),
    }),
  });

  const entries = await collectFleetCellDiagnostics(registry, [serverA], {
    debugEnabled: false,
  });
  assertEquals(entries, []);
});

test("collectFleetCellDiagnostics collects diagnostics from cells that expose them", async () => {
  const diagnostics: CellDiagnostics = {
    backend: "durable-object",
    usesHibernationWebSocket: true,
    constructorCalls: 1,
    wsAccepted: 1,
    wsClosed: 0,
    alarmInvocations: 0,
    heartbeatCount: 0,
    commandDispatchCount: 0,
    cleanupCount: 0,
    fetchByRoute: { "/rpc/liveness": 3 },
    storageReads: 0,
    storageWrites: 0,
    storageByCallSite: {},
  };

  const registry = createRegistry({
    [serverA]: createStubCell({
      getDiagnostics: async () => diagnostics,
    }),
    [serverB]: createStubCell({
      getDiagnostics: undefined,
    }),
  });

  const entries = await collectFleetCellDiagnostics(
    registry,
    [serverA, serverB],
    { debugEnabled: true },
  );
  assertEquals(entries.length, 1);
  assertEquals(entries[0]?.serverId, serverA);
  assertEquals(entries[0]?.diagnostics, diagnostics);
});

test("collectFleetCellDiagnostics skips cells that throw", async () => {
  const registry = createRegistry({
    [serverA]: createStubCell({
      getDiagnostics: async () => {
        throw new Error("diagnostics failed");
      },
    }),
  });

  const entries = await collectFleetCellDiagnostics(registry, [serverA], {
    debugEnabled: true,
  });
  assertEquals(entries, []);
});
