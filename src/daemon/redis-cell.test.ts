import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import type { Db } from "../db.ts";
import {
  buildDefaultDaemonStatus,
  parseServerDaemonState,
  type ServerDaemonState,
} from "./authn/daemon-state.ts";
import { sweepStalePresence, onDaemonInbound, onDaemonConnected, onDaemonHeartbeat } from "./cell/control-plane-monitor.ts";
import { RedisDaemonCell } from "./cell/redis/cell.ts";
import {
  createRedisCellClient,
  type RedisCellClient,
} from "./cell/redis/client.ts";
import {
  createRedisDaemonCellRegistry,
  type RedisDaemonCellRegistry,
} from "./cell/redis/registry.ts";
import {
  cellKeyPattern,
  connKey,
  LEASE_TTL_MS,
  deliveryLeaseKey,
  leaseKey,
  metaKey,
  onlineSetKey,
  outboxKey,
  requestKey,
  snapshotKey,
  HEARTBEAT_COALESCE_MS,
} from "./cell/redis/keys.ts";
import { generateDeliveryId, generateRequestId, DAEMON_OFFLINE_SWEEP_MS } from "./cell/protocol.ts";

const DEFAULT_SOCKET = Deno.env.get("TURBOPANEL_REDIS_SOCKET") ??
  "/run/turbopanel/redis.sock";

async function redisAvailable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(DEFAULT_SOCKET);
    return stat.isSocket === true;
  } catch {
    return false;
  }
}

async function cleanupServerCell(
  client: RedisCellClient,
  serverId: string,
): Promise<void> {
  await client.deleteByPattern(cellKeyPattern(serverId));
  await client.srem(onlineSetKey(), serverId);
}

function withRedisCell(
  fn: (ctx: {
    client: RedisCellClient;
    registry: RedisDaemonCellRegistry;
    cell: RedisDaemonCell;
    serverId: string;
  }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping Redis cell test: socket not found at ${DEFAULT_SOCKET}`,
      );
      return;
    }

    const client = createRedisCellClient();
    const registry = createRedisDaemonCellRegistry();
    const serverId = `test-${crypto.randomUUID()}`;
    const cell = new RedisDaemonCell(client, serverId);

    try {
      await fn({ client, registry, cell, serverId });
    } finally {
      await cleanupServerCell(client, serverId);
      await registry.close();
    }
  };
}

function withDebugRedisCell(
  fn: (ctx: {
    client: RedisCellClient;
    registry: RedisDaemonCellRegistry;
    cell: RedisDaemonCell;
    serverId: string;
  }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping Redis cell test: socket not found at ${DEFAULT_SOCKET}`,
      );
      return;
    }

    const prev = Deno.env.get("TURBOPANEL_DAEMON_DEBUG");
    Deno.env.set("TURBOPANEL_DAEMON_DEBUG", "1");
    try {
      const client = createRedisCellClient();
      const registry = createRedisDaemonCellRegistry();
      const serverId = `test-${crypto.randomUUID()}`;
      const cell = new RedisDaemonCell(client, serverId);

      try {
        await fn({ client, registry, cell, serverId });
      } finally {
        await cleanupServerCell(client, serverId);
        await registry.close();
      }
    } finally {
      if (prev === undefined) {
        Deno.env.delete("TURBOPANEL_DAEMON_DEBUG");
      } else {
        Deno.env.set("TURBOPANEL_DAEMON_DEBUG", prev);
      }
    }
  };
}

function assertNoMisattributedStorage(
  storageByCallSite: Record<string, { reads: number; writes: number }>,
): void {
  assertEquals(storageByCallSite["unknown"], undefined);
  for (const [callSite, counts] of Object.entries(storageByCallSite)) {
    assert(
      counts.reads + counts.writes > 0,
      `expected non-zero storage ops for ${callSite}`,
    );
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test(
  "getDiagnostics returns redis counters after attach, inbound, enqueue, detach",
  withRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date().toISOString(),
    });

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: "diag-redis",
      commandType: "ping",
      payload: {},
    });

    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
    });

    const diag = await cell.getDiagnostics();
    assertEquals(diag.backend, "redis");
    assertEquals(diag.usesHibernationWebSocket, false);
    assertEquals(diag.constructorCalls, 1);
    assert(diag.wsAccepted >= 1);
    assert(diag.heartbeatCount >= 1);
    assert(diag.commandDispatchCount >= 1);
    assert(diag.wsClosed >= 1);
    assert(diag.cleanupCount >= 1);
    assertEquals(typeof diag.fetchByRoute.attachDaemonSocket, "number");
    assertEquals(typeof diag.storageReads, "number");
    assertEquals(typeof diag.storageWrites, "number");
    assertEquals(typeof diag.storageByCallSite, "object");
  }),
);

test(
  "getDiagnostics populates storage counters when TURBOPANEL_DAEMON_DEBUG is enabled",
  withDebugRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date().toISOString(),
    });

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: "diag-redis-debug",
      commandType: "ping",
      payload: {},
    });

    const diag = await cell.getDiagnostics();
    assert(diag.storageReads > 0);
    assert(diag.storageWrites > 0);
    assert(Object.keys(diag.storageByCallSite).length > 0);
    assertNoMisattributedStorage(diag.storageByCallSite);
  }),
);

test(
  "storageByCallSite attributes Redis ops to the logical method without cross-attribution",
  withDebugRedisCell(async ({ cell }) => {
    await cell.reconcileStalePresence();
    let diag = await cell.getDiagnostics();
    assert(diag.storageByCallSite["reconcileStalePresence"]);
    assertNoMisattributedStorage(diag.storageByCallSite);

    await cell.getSnapshot();
    diag = await cell.getDiagnostics();
    assert(diag.storageByCallSite["getSnapshot"]);
    assertNoMisattributedStorage(diag.storageByCallSite);

    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const deliveryId = generateDeliveryId();
    const requestId = generateRequestId();
    const at = new Date().toISOString();

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId,
      requestId,
      at,
      commandId: "cmd-attrib",
      commandType: "daemon.ping",
      payload: {},
    });

    await cell.markSent(deliveryId, attached.connectionId, at);
    await cell.handleInbound({
      kind: "command-ack",
      requestId,
      at,
      daemonReceivedAt: at,
    });
    await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    });

    const consumer = `ws:${attached.connectionId}`;
    await cell.readOutboxBatch({ consumer, count: 10 });
    await cell.ackOutbox([deliveryId], consumer);

    await Promise.all([
      cell.getSnapshot(),
      cell.listRequests(),
    ]);

    diag = await cell.getDiagnostics();
    assert(diag.storageByCallSite["attachDaemonSocket"]);
    assert(diag.storageByCallSite["enqueue"]);
    assert(diag.storageByCallSite["markSent"]);
    assert(diag.storageByCallSite["handleInbound"]);
    assert(diag.storageByCallSite["readOutboxBatch"]);
    assert(diag.storageByCallSite["ackOutbox"]);
    assert(diag.storageByCallSite["listRequests"]);
    assertNoMisattributedStorage(diag.storageByCallSite);

    await cell.clearUpdateStatus();
    await cell.purge();

    diag = await cell.getDiagnostics();
    assert(diag.storageByCallSite["clearUpdateStatus"]);
    assert(diag.storageByCallSite["purge"]);
    assertNoMisattributedStorage(diag.storageByCallSite);
  }),
);

test(
  "attachDaemonSocket acquires lease and returns connectionId and lease holder",
  withRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    assertEquals(typeof attached.connectionId, "string");
    assertEquals(attached.lease.holder, attached.connectionId);
  }),
);

test(
  "second attachDaemonSocket throws while lease is held",
  withRedisCell(async ({ cell }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    await assertRejects(
      () =>
        cell.attachDaemonSocket({
          keyId: crypto.randomUUID(),
        }),
      Error,
      "daemon socket lease held",
    );
  }),
);

test(
  "detachDaemonSocket with correct connectionId releases lease",
  withRedisCell(async ({ cell }) => {
    const first = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    await cell.detachDaemonSocket({
      connectionId: first.connectionId,
    });
    const second = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    assertEquals(typeof second.connectionId, "string");
  }),
);

test(
  "detachDaemonSocket with wrong connectionId is a no-op",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    await cell.detachDaemonSocket({
      connectionId: "wrong-connection-id",
    });
    const leaseHolder = await client.get(leaseKey(serverId));
    assertEquals(leaseHolder, attached.connectionId);
  }),
);

test(
  "enqueue appends to outbox and readOutboxBatch reads in order",
  withRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer = `ws:${attached.connectionId}`;
    const at = new Date().toISOString();
    const firstId = generateRequestId();
    const secondId = generateRequestId();

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId: firstId,
      at,
      commandId: "cmd-first",
      commandType: "daemon.ping",
      payload: {},
    });
    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId: secondId,
      at,
      commandId: "cmd-second",
      commandType: "daemon.ping",
      payload: {},
    });

    const batch = await cell.readOutboxBatch({ consumer, count: 10 });
    assertEquals(batch.length, 2);
    assertEquals(batch[0]?.requestId, firstId);
    assertEquals(batch[1]?.requestId, secondId);
  }),
);

test(
  "ackOutbox clears pending entries and drops outbox stream length",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer = `ws:${attached.connectionId}`;
    const deliveryId = generateDeliveryId();
    const requestId = generateRequestId();

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId,
      requestId,
      at: new Date().toISOString(),
      commandId: "cmd-echo",
      commandType: "daemon.ping",
      payload: {},
    });

    assertEquals(await client.xlen(outboxKey(serverId)), 1);

    const batch = await cell.readOutboxBatch({ consumer, count: 10 });
    assertEquals(batch.length, 1);
    await cell.ackOutbox([deliveryId], consumer);

    const pending = await cell.readOutboxBatch({
      consumer,
      count: 10,
    });
    assertEquals(pending.length, 0);
    assertEquals(await client.xlen(outboxKey(serverId)), 0);
  }),
);

test(
  "enqueue with the same deliveryId is idempotent",
  withRedisCell(async ({ cell, client, serverId }) => {
    const deliveryId = generateDeliveryId();
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    const envelope = {
      kind: "command-dispatch" as const,
      deliveryId,
      requestId,
      at,
      commandId: "cmd-once",
      commandType: "daemon.ping",
      payload: {},
    };

    const first = await cell.enqueue(envelope);
    const second = await cell.enqueue(envelope);
    assertEquals(first.requestId, second.requestId);

    const length = await client.xlen(outboxKey(serverId));
    assertEquals(length, 1);
  }),
);

test(
  "XAUTOCLAIM reclaims pending outbox entries after reconnect",
  withRedisCell(async ({ cell }) => {
    const firstAttach = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer1 = `ws:${firstAttach.connectionId}`;

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: "cmd-one",
      commandType: "daemon.ping",
      payload: { n: 1 },
    });
    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: "cmd-two",
      commandType: "daemon.ping",
      payload: { n: 2 },
    });

    const firstRead = await cell.readOutboxBatch({
      consumer: consumer1,
      count: 10,
    });
    assertEquals(firstRead.length, 2);

    await cell.detachDaemonSocket({
      connectionId: firstAttach.connectionId,
    });

    // Production attach uses minIdleMs=60_000 for XAUTOCLAIM; wait for idle threshold.
    await new Promise((resolve) => setTimeout(resolve, 61_000));

    const secondAttach = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer2 = `ws:${secondAttach.connectionId}`;

    const reclaimed = await cell.readOutboxBatch({
      consumer: consumer2,
      count: 10,
    });
    const requestIds = new Set(
      reclaimed
        .filter((entry) => entry.kind === "command-dispatch")
        .map((entry) => entry.requestId),
    );
    assertEquals(requestIds.size, 2);
  }),
);

test(
  "request record expires after TTL",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    await cell.enqueue(
      {
        kind: "command-dispatch",
        deliveryId: generateDeliveryId(),
        requestId,
        at: new Date().toISOString(),
        commandId: "cmd-expire",
        commandType: "daemon.ping",
        payload: {},
      },
      { ttlSeconds: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const record = await cell.getRequest(requestId);
    assertEquals(record, null);
  }),
);

test(
  "createRequestAndWait returns expired when no daemon responds",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    const record = await cell.createRequestAndWait(
      {
        kind: "command-dispatch",
        deliveryId: generateDeliveryId(),
        requestId,
        at: new Date().toISOString(),
        commandId: "cmd-noop",
        commandType: "daemon.ping",
        payload: {},
      },
      300,
    );
    assertEquals(record.status, "expired");
    assertEquals(await cell.getRequest(requestId), null);
    assertEquals(await cell.listRequests(), []);
  }),
);

test(
  "handleInbound retains update request row through pending window",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: true,
    });

    const record = await cell.getRequest(requestId);
    assertEquals(record?.status, "done");
    assertEquals(
      (await client.hgetall(requestKey(serverId, requestId)))?.status,
      "done",
    );

    const listed = await cell.listRequests(10, { requestKind: "update" });
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.requestId, requestId);
  }),
);

test(
  "clearUpdateStatus removes terminal update request rows",
  withRedisCell(async ({ cell, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: false,
      error: "reconcile failed",
    });

    const cleared = await cell.clearUpdateStatus();
    assertEquals(cleared.cleared, 1);
    assertEquals(
      await cell.listRequests(10, { requestKind: "update" }),
      [],
    );
  }),
);

function createProjectionTrackingDb(serverId: string): {
  db: Db;
  getDaemon: () => ServerDaemonState;
} {
  let daemon: ServerDaemonState = {
    key: {
      id: "key-1",
      algorithm: "Ed25519",
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
      fingerprint: "fp-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    },
    projection: {
      update: {
        status: "updating",
        requestId: "pending",
        channel: "trunk",
        queuedAt: new Date(Date.now() - 400_000).toISOString(),
      },
    },
    status: buildDefaultDaemonStatus(),
  };

  const selectLimit = () => Promise.resolve([{ id: serverId, daemon }]);

  const selectWhere = () => {
    const rows = daemon.projection?.update?.status === "updating"
      ? [{ id: serverId }]
      : [{ id: serverId, daemon }];
    return Object.assign(Promise.resolve(rows), { limit: selectLimit });
  };

  const db = {
    select: () => ({
      from: () => ({
        where: selectWhere,
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        if (patch.daemon) {
          daemon = patch.daemon as ServerDaemonState;
        }
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  } as unknown as Db;

  return { db, getDaemon: () => daemon };
}

function createSweepMockDb(initialDaemon: ServerDaemonState): {
  db: Db;
  updateCalls: Array<Record<string, unknown>>;
} {
  const updateCalls: Array<Record<string, unknown>> = [];
  let daemon = initialDaemon;

  const selectLimit = () => Promise.resolve([{ daemon, metadata: null }]);

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: selectLimit }),
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

test(
  "maintain expires offline in-flight update and projects Postgres state",
  withRedisCell(async ({ client, serverId }) => {
    const { db, getDaemon } = createProjectionTrackingDb(serverId);
    const registry = createRedisDaemonCellRegistry({ db });
    const cell = registry.getCell(serverId) as RedisDaemonCell;

    const requestId = generateRequestId();
    const queuedAt = new Date(Date.now() - 400_000).toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at: queuedAt,
      channel: "trunk",
    }, { ttlSeconds: 300 });

    await client.hset(requestKey(serverId, requestId), {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: queuedAt,
    });
    await client.srem(onlineSetKey(), serverId);

    await registry.maintain();

    assertEquals(await cell.getRequest(requestId), null);
    assertEquals(
      parseServerDaemonState(getDaemon())?.projection?.update?.status,
      "expired",
    );

    await registry.close();
  }),
);

test(
  "clearUpdateStatus expires stale in-flight update when allowStale is set",
  withRedisCell(async ({ cell, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    const cleared = await cell.clearUpdateStatus({
      allowStale: true,
      currentCommit: "same-commit",
      targetCommit: "same-commit",
    });
    assertEquals(cleared.cleared, 1);
    assertEquals(
      await cell.listRequests(10, { requestKind: "update" }),
      [],
    );
  }),
);

test(
  "command-dispatch ack is non-terminal then outcome completes correlation",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const ackAt = new Date().toISOString();
    const outcomeAt = new Date(Date.now() + 1000).toISOString();
    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId,
      at: ackAt,
      commandId: "cmd-1",
      commandType: "ping",
      payload: { target: "host" },
    });

    const ackRecord = await cell.handleInbound({
      kind: "command-ack",
      requestId,
      at: ackAt,
      daemonReceivedAt: ackAt,
    });
    assertEquals(ackRecord?.status, "acked");
    assertEquals(ackRecord?.ackAt, ackAt);
    assertEquals(ackRecord?.daemonReceivedAt, ackAt);
    assertEquals(ackRecord?.finishedAt, undefined);

    const persistedAck = await cell.getRequest(requestId);
    assertEquals(persistedAck?.status, "acked");
    assertEquals(persistedAck?.daemonReceivedAt, ackAt);
    assertEquals(
      (await client.hgetall(requestKey(serverId, requestId)))?.daemonReceivedAt,
      ackAt,
    );

    const daemonRespondedAt = new Date(Date.now() + 500).toISOString();
    const outcomeRecord = await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at: outcomeAt,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: ackAt,
      daemonRespondedAt,
    });
    assertEquals(outcomeRecord?.status, "done");
    assertEquals(outcomeRecord?.result, { pong: true });
    assertEquals(outcomeRecord?.finishedAt, outcomeAt);
    assertEquals(outcomeRecord?.daemonReceivedAt, ackAt);
    assertEquals(outcomeRecord?.daemonRespondedAt, daemonRespondedAt);

    const terminal = await cell.getRequest(requestId);
    assertEquals(terminal?.status, "done");
    assertEquals(terminal?.daemonReceivedAt, ackAt);
    assertEquals(terminal?.daemonRespondedAt, daemonRespondedAt);
  }),
);

test(
  "createRequestAndWait resolves after command-dispatch ack then outcome",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    const outbound = {
      kind: "command-dispatch" as const,
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      commandId: "cmd-2",
      commandType: "echo",
      payload: { message: "hi" },
    };

    const waitPromise = cell.createRequestAndWait(outbound, 5000);
    await cell.enqueue(outbound);

    await cell.handleInbound({
      kind: "command-ack",
      requestId,
      at,
      daemonReceivedAt: at,
    });

    const mid = await cell.getRequest(requestId);
    assertEquals(mid?.status, "acked");

    await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at: new Date().toISOString(),
      ok: true,
      result: { echoed: "hi" },
    });

    const record = await waitPromise;
    assertEquals(record.status, "done");
    assertEquals(record.result, { echoed: "hi" });
  }),
);

test(
  "handleInbound retains update request row through pending window",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: true,
    });

    const record = await cell.getRequest(requestId);
    assertEquals(record?.status, "done");
    assertEquals(
      (await client.hgetall(requestKey(serverId, requestId)))?.status,
      "done",
    );

    const listed = await cell.listRequests(10, { requestKind: "update" });
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.requestId, requestId);
  }),
);

test(
  "timed-out request is not delivered after reconnect",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const outbound = {
      kind: "command-dispatch" as const,
      deliveryId,
      requestId,
      at: new Date().toISOString(),
      commandId: "cmd-stale",
      commandType: "daemon.ping",
      payload: {},
    };

    const expired = await cell.createRequestAndWait(outbound, 300);
    assertEquals(expired.status, "expired");
    assertEquals(await cell.getRequest(requestId), null);

    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const batch = await cell.readOutboxBatch({
      consumer: `ws:${attached.connectionId}`,
      count: 10,
    });
    assertEquals(
      batch.some((entry) => entry.requestId === requestId),
      false,
    );
  }),
);

test(
  "createRequestAndWait resolves done when command-dispatch ack then outcome arrive",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    const outbound = {
      kind: "command-dispatch" as const,
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      commandId: "cmd-wait",
      commandType: "daemon.ping",
      payload: {},
    };

    const waitPromise = cell.createRequestAndWait(outbound, 5000);
    await cell.enqueue(outbound);
    await cell.handleInbound({
      kind: "command-ack",
      requestId,
      at,
      daemonReceivedAt: at,
    });
    await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    });

    const record = await waitPromise;
    assertEquals(record.status, "done");
    assertEquals(record.result, { pong: true });
  }),
);

test(
  "listOnlineServerIds tracks attach and detach",
  withRedisCell(async ({ cell, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    let online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));

    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
    });
    online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);

test(
  "reconcileStalePresence removes stale online entry when lease expired",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    await client.del(leaseKey(serverId));
    const demoted = await cell.reconcileStalePresence();
    assert(demoted);

    const online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));

    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
    });
  }),
);

test(
  "reconcileStalePresence demotes when lastInboundAt exceeds offline sweep threshold",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
      .toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    });
    await client.del(leaseKey(serverId));

    const demoted = await cell.reconcileStalePresence();
    assert(demoted);

    const online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);

test(
  "attach and onDaemonConnected projects online status to postgres",
  withRedisCell(async ({ cell, serverId }) => {
    const connectedAt = new Date().toISOString();
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: false,
        daemonStatus: "offline",
      },
    });

    await onDaemonConnected(db, serverId, cell, connectedAt);

    assertEquals(updateCalls.length, 1);
    const status = (updateCalls[0]?.daemon as ServerDaemonState)?.status;
    assertEquals(status?.connected, true);
    assertEquals(status?.connectedAt, connectedAt);
  }),
);

test(
  "onDaemonHeartbeat debounces postgres lastSeenAt to at most once per 60s",
  withRedisCell(async ({ cell, serverId }) => {
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: true,
        daemonStatus: "online",
        lastSeenAt: staleAt,
        connectedAt: staleAt,
      },
    });

    await onDaemonHeartbeat(db, serverId, cell);
    assertEquals(updateCalls.length, 1);

    await onDaemonHeartbeat(db, serverId, cell);
    assertEquals(updateCalls.length, 1);
  }),
);

test(
  "sweepStalePresence projects offline when reconcileStalePresence demotes",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
      .toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    });
    await client.del(leaseKey(serverId));

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: true,
        daemonStatus: "online",
        lastSeenAt: staleAt,
      },
    });

    await sweepStalePresence(db, registry);

    assertEquals(updateCalls.length, 1);
    const status = (updateCalls[0]?.daemon as ServerDaemonState)?.status;
    assertEquals(status?.connected, false);
  }),
);

test(
  "reconcileStalePresence demotes when lastInboundAt exceeds offline sweep threshold",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
      .toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    });
    await client.del(leaseKey(serverId));

    const demoted = await cell.reconcileStalePresence();
    assert(demoted);

    const online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);


test(
  "attach and onDaemonConnected projects online status to postgres",
  withRedisCell(async ({ cell, serverId }) => {
    const connectedAt = new Date().toISOString();
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: false,
        daemonStatus: "offline",
      },
    });

    await onDaemonConnected(db, serverId, cell, connectedAt);

    assertEquals(updateCalls.length, 1);
    const status = (updateCalls[0]?.daemon as ServerDaemonState)?.status;
    assertEquals(status?.connected, true);
    assertEquals(status?.connectedAt, connectedAt);
  }),
);

test(
  "onDaemonHeartbeat debounces postgres lastSeenAt to at most once per 60s",
  withRedisCell(async ({ cell, serverId }) => {
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: true,
        daemonStatus: "online",
        lastSeenAt: staleAt,
        connectedAt: staleAt,
      },
    });

    await onDaemonHeartbeat(db, serverId, cell);
    assertEquals(updateCalls.length, 1);

    await onDaemonHeartbeat(db, serverId, cell);
    assertEquals(updateCalls.length, 1);
  }),
);

test(
  "sweepStalePresence projects offline when reconcileStalePresence demotes",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
      .toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    });
    await client.del(leaseKey(serverId));

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: true,
        daemonStatus: "online",
        lastSeenAt: staleAt,
      },
    });

    await sweepStalePresence(db, registry);

    assertEquals(updateCalls.length, 1);
    const status = (updateCalls[0]?.daemon as ServerDaemonState)?.status;
    assertEquals(status?.connected, false);
  }),
);

test(
  "inbound after stale sweep restores postgres online status",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
      .toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    });
    await client.del(leaseKey(serverId));

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: false,
        daemonStatus: "offline",
        lastSeenAt: staleAt,
        disconnectedAt: staleAt,
      },
    });

    await sweepStalePresence(db, registry);

    const at = new Date().toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at,
      agent: { commit: "recovered", buildId: "1", channel: "trunk" },
    });
    await onDaemonInbound(db, serverId, cell, {
      at,
      agent: { commit: "recovered", buildId: "1", channel: "trunk" },
    });

    const meta = await client.hgetall(metaKey(serverId));
    assertEquals(meta?.connected, "1");

    const online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));

    assertEquals(updateCalls.length, 2);
    const status = (updateCalls.at(-1)?.daemon as ServerDaemonState)
      ?.status;
    assertEquals(status?.connected, true);
    assertEquals(status?.daemonStatus, "online");
  }),
);

test(
  "heartbeat updates lastSeenAt in meta",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    await client.hset(metaKey(serverId), { lastInboundAt: staleAt, lastSeenAt: staleAt });

    const at = new Date().toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at,
    });

    const meta = await client.hgetall(metaKey(serverId));
    assertEquals(meta?.lastSeenAt, at);
  }),
);

test(
  "heartbeat is coalesced within 60s",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    await client.hset(metaKey(serverId), { lastInboundAt: staleAt, lastSeenAt: staleAt });

    const firstAt = new Date().toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: firstAt,
    });

    const secondAt = new Date(Date.now() + 1000).toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: secondAt,
    });

    const meta = await client.hgetall(metaKey(serverId));
    assertEquals(meta?.lastSeenAt, firstAt);
  }),
);

test(
  "delivery lease operations do not affect attached daemon socket lease",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const socketLeaseHolder = await client.get(leaseKey(serverId));
    assertEquals(socketLeaseHolder, attached.connectionId);

    const deliveryHolder = "delivery-consumer-1";
    const claimed = await cell.claimDeliveryLease(deliveryHolder, LEASE_TTL_MS);
    assert(claimed);
    assertEquals(claimed?.holder, deliveryHolder);

    assertEquals(await client.get(leaseKey(serverId)), attached.connectionId);
    assertEquals(await client.get(deliveryLeaseKey(serverId)), deliveryHolder);

    const renewed = await cell.renewDeliveryLease(deliveryHolder, LEASE_TTL_MS);
    assert(renewed);
    assertEquals(await client.get(leaseKey(serverId)), attached.connectionId);

    await cell.releaseDeliveryLease(deliveryHolder);
    assertEquals(await client.get(deliveryLeaseKey(serverId)), null);
    assertEquals(await client.get(leaseKey(serverId)), attached.connectionId);
  }),
);

test(
  "attach uses persistent daemon socket lease",
  withRedisCell(async ({ cell, client, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const ttl = await client.pttl(leaseKey(serverId));
    assertEquals(ttl, -1);
  }),
);

test(
  "recordInbound within coalesce window does not trigger postgres projection",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const recentAt = new Date().toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: recentAt,
      lastSeenAt: recentAt,
    });

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date(Date.now() + 1000).toISOString(),
    });

    const { db, updateCalls } = createSweepMockDb({
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: "host-1" },
      status: {
        ...buildDefaultDaemonStatus(),
        connected: true,
        daemonStatus: "online",
        lastSeenAt: recentAt,
        connectedAt: recentAt,
      },
    });

    await onDaemonInbound(db, serverId, cell, {
      at: new Date(Date.now() + 1000).toISOString(),
    });

    assertEquals(updateCalls.length, 0);
  }),
);

test(
  "coalesced pure-ping recordInbound skips Redis storage within coalesce window",
  withDebugRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const diagAfterFirstResp = await cell.getDiagnostics();
    const writesAfterAttach = diagAfterFirstResp.storageByCallSite["recordInbound"]?.writes ?? 0;
    const readsAfterAttach = diagAfterFirstResp.storageByCallSite["recordInbound"]?.reads ?? 0;

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date().toISOString(),
    });

    const diagAfterSecond = await cell.getDiagnostics();
    const writesAfterSecond = diagAfterSecond.storageByCallSite["recordInbound"]?.writes ?? 0;
    const readsAfterSecond = diagAfterSecond.storageByCallSite["recordInbound"]?.reads ?? 0;

    expect(writesAfterSecond).toBe(writesAfterAttach);
    expect(readsAfterSecond).toBe(readsAfterAttach);

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date(Date.now() + HEARTBEAT_COALESCE_MS + 1000).toISOString(),
    });

    const diagAfterWindow = await cell.getDiagnostics();
    const writesAfterWindow = diagAfterWindow.storageByCallSite["recordInbound"]?.writes ?? 0;
    const readsAfterWindow = diagAfterWindow.storageByCallSite["recordInbound"]?.reads ?? 0;

    expect(writesAfterWindow).toBeGreaterThan(writesAfterAttach);
    expect(readsAfterWindow).toBeGreaterThan(readsAfterAttach);
  }),
);

test(
  "coalesced recordInbound does not bump lastSeenAt within 60s",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const metaBefore = await client.hgetall(metaKey(serverId));
    const lastSeenBefore = metaBefore?.lastSeenAt;

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date().toISOString(),
    });

    const metaAfter = await client.hgetall(metaKey(serverId));
    assertEquals(metaAfter?.lastSeenAt, lastSeenBefore);
  }),
);

test(
  "cell ping recordInbound refreshes lastSeenAt and prevents stale demotion",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000)
      .toISOString();
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    });

    const pingAt = new Date().toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: pingAt,
    });

    const meta = await client.hgetall(metaKey(serverId));
    assertEquals(meta?.lastSeenAt, pingAt);
    assertEquals(meta?.connected, "1");

    const demoted = await cell.reconcileStalePresence();
    assertEquals(demoted, false);

    const online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));
  }),
);

test(
  "coalesced heartbeat persists agent on first heartbeat after attach",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const agent = {
      commit: "abc123",
      buildId: "build-1",
      builtAt: new Date().toISOString(),
      channel: "trunk" as const,
    };

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date().toISOString(),
      agent,
    });

    const meta = await client.hgetall(metaKey(serverId));
    assertEquals(meta?.agent, JSON.stringify(agent));
  }),
);

test(
  "purge deletes all cell keys and removes from online set",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    await cell.purge();

    assertEquals(await client.get(metaKey(serverId)), null);
    assertEquals(await client.get(snapshotKey(serverId)), null);
    assertEquals(await client.get(outboxKey(serverId)), null);
    assertEquals(await client.get(leaseKey(serverId)), null);

    const online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);

test(
  "purge deletes historical connection hashes after reconnect",
  withRedisCell(async ({ cell, client, serverId }) => {
    const first = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    await cell.detachDaemonSocket({
      connectionId: first.connectionId,
    });

    const second = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    assert(
      (await client.hgetall(connKey(serverId, first.connectionId))) !== null,
    );
    assert(
      (await client.hgetall(connKey(serverId, second.connectionId))) !== null,
    );

    await cell.purge();

    assertEquals(
      await client.scanKeys(cellKeyPattern(serverId)),
      [],
    );
  }),
);

test(
  "heartbeat past one interval keeps server online and advances lastSeenAt",
  withRedisCell(async ({ cell, client, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const firstAt = new Date().toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: firstAt,
    });

    await new Promise((resolve) => setTimeout(resolve, 61_000));

    const secondAt = new Date().toISOString();
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: secondAt,
    });

    const online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));

    const meta = await client.hgetall(metaKey(serverId));
    assertEquals(meta?.connected, "1");
    assertEquals(meta?.lastSeenAt, secondAt);
    assert(Date.parse(meta?.lastSeenAt ?? "") > Date.parse(firstAt));
  }),
);

test(
  "handleInbound deletes non-update request row on terminal status",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      commandId: "cmd-done",
      commandType: "daemon.ping",
      payload: {},
    });

    await cell.handleInbound({
      kind: "command-ack",
      requestId,
      at,
      daemonReceivedAt: at,
    });
    await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    });

    const record = await cell.getRequest(requestId);
    assertEquals(record?.status, "done");
    assertEquals(
      await client.hgetall(requestKey(serverId, requestId)),
      null,
    );
    assertEquals(await cell.listRequests(), []);
  }),
);

test(
  "handleInbound retains update request row through pending window",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: true,
    });

    const record = await cell.getRequest(requestId);
    assertEquals(record?.status, "done");
    assertEquals(
      (await client.hgetall(requestKey(serverId, requestId)))?.status,
      "done",
    );

    const listed = await cell.listRequests(10, { requestKind: "update" });
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.requestId, requestId);
  }),
);

test(
  "handleInbound retains update request row through pending window",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: true,
    });

    const record = await cell.getRequest(requestId);
    assertEquals(record?.status, "done");
    assertEquals(
      (await client.hgetall(requestKey(serverId, requestId)))?.status,
      "done",
    );

    const listed = await cell.listRequests(10, { requestKind: "update" });
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.requestId, requestId);
  }),
);

test(
  "clearUpdateStatus removes terminal update request rows",
  withRedisCell(async ({ cell, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "update",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: "trunk",
    });

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: false,
      error: "reconcile failed",
    });

    const cleared = await cell.clearUpdateStatus();
    assertEquals(cleared.cleared, 1);
    assertEquals(
      await cell.listRequests(10, { requestKind: "update" }),
      [],
    );
  }),
);

