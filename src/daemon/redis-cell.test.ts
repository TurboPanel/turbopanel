import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { createRedisChallengeStore } from "./cell/challenge-store.ts";
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
  leaseKey,
  metaKey,
  monitorDeadlinesKey,
  onlineSetKey,
  outboxKey,
  requestKey,
  requestsKey,
  snapshotKey,
} from "./cell/redis/keys.ts";
import { generateDeliveryId, generateRequestId } from "./cell/protocol.ts";

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
  const requestIds = await client.zrangebyscore(
    requestsKey(serverId),
    "-inf",
    "+inf",
  );
  const keys = [
    metaKey(serverId),
    snapshotKey(serverId),
    outboxKey(serverId),
    requestsKey(serverId),
    leaseKey(serverId),
    ...requestIds.map((id) => requestKey(serverId, id)),
  ];
  if (keys.length > 0) await client.del(...keys);
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

Deno.test(
  "attachDaemonSocket acquires lease and returns connectionId and leaseToken",
  withRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    assertEquals(typeof attached.connectionId, "string");
    assertEquals(attached.lease.token, attached.connectionId);
    assertEquals(attached.lease.holder, attached.connectionId);
  }),
);

Deno.test(
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

Deno.test(
  "detachDaemonSocket with correct leaseToken releases lease",
  withRedisCell(async ({ cell }) => {
    const first = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    await cell.detachDaemonSocket({
      connectionId: first.connectionId,
      leaseToken: first.lease.token,
    });
    const second = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    assertEquals(typeof second.connectionId, "string");
  }),
);

Deno.test(
  "detachDaemonSocket with wrong leaseToken is a no-op",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
      leaseToken: "wrong-token",
    });
    const leaseHolder = await client.get(leaseKey(serverId));
    assertEquals(leaseHolder, attached.connectionId);
  }),
);

Deno.test(
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
      kind: "command",
      deliveryId: generateDeliveryId(),
      requestId: firstId,
      at,
      command: "first",
    });
    await cell.enqueue({
      kind: "command",
      deliveryId: generateDeliveryId(),
      requestId: secondId,
      at,
      command: "second",
    });

    const batch = await cell.readOutboxBatch({ consumer, count: 10 });
    assertEquals(batch.length, 2);
    assertEquals(batch[0]?.requestId, firstId);
    assertEquals(batch[1]?.requestId, secondId);
  }),
);

Deno.test(
  "ackOutbox clears pending entries for the consumer",
  withRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer = `ws:${attached.connectionId}`;
    const deliveryId = generateDeliveryId();
    const requestId = generateRequestId();

    await cell.enqueue({
      kind: "command",
      deliveryId,
      requestId,
      at: new Date().toISOString(),
      command: "echo",
    });

    const batch = await cell.readOutboxBatch({ consumer, count: 10 });
    assertEquals(batch.length, 1);
    await cell.ackOutbox([deliveryId], consumer);

    const pending = await cell.readOutboxBatch({
      consumer,
      count: 10,
    });
    assertEquals(pending.length, 0);
  }),
);

Deno.test(
  "enqueue with the same deliveryId is idempotent",
  withRedisCell(async ({ cell, client, serverId }) => {
    const deliveryId = generateDeliveryId();
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    const envelope = {
      kind: "command" as const,
      deliveryId,
      requestId,
      at,
      command: "once",
    };

    const first = await cell.enqueue(envelope);
    const second = await cell.enqueue(envelope);
    assertEquals(first.requestId, second.requestId);

    const length = await client.xlen(outboxKey(serverId));
    assertEquals(length, 1);
  }),
);

Deno.test(
  "XAUTOCLAIM reclaims pending outbox entries after reconnect",
  withRedisCell(async ({ cell }) => {
    const firstAttach = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer1 = `ws:${firstAttach.connectionId}`;

    await cell.enqueue({
      kind: "command",
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      command: "one",
    });
    await cell.enqueue({
      kind: "command",
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      command: "two",
    });

    const firstRead = await cell.readOutboxBatch({
      consumer: consumer1,
      count: 10,
    });
    assertEquals(firstRead.length, 2);

    await cell.detachDaemonSocket({
      connectionId: firstAttach.connectionId,
      leaseToken: firstAttach.lease.token,
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
    const commands = reclaimed
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.command);
    assert(commands.includes("one"));
    assert(commands.includes("two"));
  }),
);

Deno.test(
  "challenge store expires after TTL",
  withRedisCell(async ({ client }) => {
    const store = createRedisChallengeStore(client, 1000);
    const issued = await store.issue();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const consumed = await store.consume({ challengeId: issued.id });
    assertEquals(consumed, null);
  }),
);

Deno.test(
  "request record expires after TTL",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    await cell.enqueue(
      {
        kind: "command",
        deliveryId: generateDeliveryId(),
        requestId,
        at: new Date().toISOString(),
        command: "expire-me",
      },
      { ttlSeconds: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const record = await cell.getRequest(requestId);
    assertEquals(record, null);
  }),
);

Deno.test(
  "createRequestAndWait returns expired when no daemon responds",
  withRedisCell(async ({ cell }) => {
    const record = await cell.createRequestAndWait(
      {
        kind: "command",
        deliveryId: generateDeliveryId(),
        requestId: generateRequestId(),
        at: new Date().toISOString(),
        command: "noop",
      },
      300,
    );
    assertEquals(record.status, "expired");
  }),
);

Deno.test(
  "createRequestAndWait resolves done when inbound result arrives",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    const outbound = {
      kind: "command" as const,
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      command: "echo hi",
    };

    const waitPromise = cell.createRequestAndWait(outbound, 5000);
    await cell.enqueue(outbound);
    await cell.handleInbound({
      kind: "command-result",
      requestId,
      at,
      exitCode: 0,
      stdout: "hi",
      stderr: "",
    });

    const record = await waitPromise;
    assertEquals(record.status, "done");
    assertEquals(record.result, { exitCode: 0, stdout: "hi", stderr: "" });
  }),
);

Deno.test(
  "listOnlineServerIds tracks attach and detach",
  withRedisCell(async ({ cell, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    let online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));

    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
      leaseToken: attached.lease.token,
    });
    online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);

Deno.test(
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
      leaseToken: attached.lease.token,
    });
  }),
);

Deno.test(
  "createRedisChallengeStore issue returns id, nonce, and at",
  withRedisCell(async ({ client }) => {
    const store = createRedisChallengeStore(client);
    const challenge = await store.issue();
    assertEquals(typeof challenge.id, "string");
    assertEquals(typeof challenge.nonce, "string");
    assertEquals(typeof challenge.at, "string");
  }),
);

Deno.test(
  "createRedisChallengeStore consume is single-use",
  withRedisCell(async ({ client }) => {
    const store = createRedisChallengeStore(client);
    const issued = await store.issue();
    const first = await store.consume({ challengeId: issued.id });
    assertEquals(first?.id, issued.id);
    const second = await store.consume({ challengeId: issued.id });
    assertEquals(second, null);
  }),
);

Deno.test(
  "createRedisChallengeStore consume rejects mismatched serverId",
  withRedisCell(async ({ client }) => {
    const store = createRedisChallengeStore(client);
    const serverId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const issued = await store.issue({ serverId, keyId });
    const consumed = await store.consume({
      challengeId: issued.id,
      serverId: crypto.randomUUID(),
      keyId,
    });
    assertEquals(consumed, null);
  }),
);

Deno.test(
  "createRedisChallengeStore consume rejects mismatched keyId",
  withRedisCell(async ({ client }) => {
    const store = createRedisChallengeStore(client);
    const serverId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const issued = await store.issue({ serverId, keyId });
    const consumed = await store.consume({
      challengeId: issued.id,
      serverId,
      keyId: crypto.randomUUID(),
    });
    assertEquals(consumed, null);
  }),
);

Deno.test(
  "createRedisChallengeStore consume returns null when TTL elapsed",
  withRedisCell(async ({ client }) => {
    const store = createRedisChallengeStore(client, 1000);
    const issued = await store.issue();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const consumed = await store.consume({ challengeId: issued.id });
    assertEquals(consumed, null);
  }),
);

function monitorSyncEnvelope(
  serverId: string,
  resources: Array<{
    resourceKey: string;
    kind: "container";
    status: "healthy" | "unhealthy" | "degraded";
  }>,
  sequence = 1,
) {
  return {
    kind: "monitor-sync" as const,
    serverId,
    sequence,
    at: new Date().toISOString(),
    protocolVersion: 1 as const,
    instance: {},
    resources,
  };
}

Deno.test(
  "applyMonitorSync full reconcile stores resources",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
        { resourceKey: "container:b", kind: "container", status: "healthy" },
      ]),
    );
    const resources = await cell.listMonitorResources(serverId);
    assertEquals(resources.length, 2);
  }),
);

Deno.test(
  "applyMonitorHeartbeat applies resource delta",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
        { resourceKey: "container:b", kind: "container", status: "healthy" },
      ]),
    );

    await cell.applyMonitorHeartbeat({
      kind: "monitor-heartbeat",
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      instance: {},
      resources: [{
        resourceKey: "container:a",
        kind: "container",
        status: "degraded",
      }],
    });

    const resources = await cell.listMonitorResources(serverId);
    const a = resources.find((row) => row.resourceKey === "container:a");
    const b = resources.find((row) => row.resourceKey === "container:b");
    assertEquals(a?.status, "degraded");
    assertEquals(b?.status, "healthy");
  }),
);

Deno.test(
  "applyMonitorSync schedules offline deadline entry",
  withRedisCell(async ({ cell, client, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
      ]),
    );

    const deadlines = await client.zrangebyscore(
      monitorDeadlinesKey(serverId),
      "-inf",
      "+inf",
    );
    assert(deadlines.includes("offline"));
  }),
);

Deno.test(
  "duplicate still-healthy heartbeats do not append duplicate events",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
      ]),
    );

    const heartbeat = {
      kind: "monitor-heartbeat" as const,
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      instance: {},
      resources: [{
        resourceKey: "container:a",
        kind: "container" as const,
        status: "healthy" as const,
      }],
    };
    await cell.applyMonitorHeartbeat(heartbeat);
    await cell.applyMonitorHeartbeat({
      ...heartbeat,
      sequence: 3,
    });

    const events = await cell.listMonitorEvents(serverId, 100);
    const forResource = events.filter((event) =>
      event.resourceKey === "container:a"
    );
    assert(forResource.length <= 1);
  }),
);

Deno.test(
  "applyMonitorSync accepts newer sequence after heartbeat gap",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [], 1),
    );

    const gap = await cell.applyMonitorHeartbeat({
      kind: "monitor-heartbeat",
      serverId,
      sequence: 3,
      at: new Date().toISOString(),
      instance: {},
    });
    assertEquals(gap.resyncNeeded, true);
    assertEquals(gap.acceptedSequence, 1);

    const resync = await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:gap", kind: "container", status: "healthy" },
      ], 5),
    );
    assertEquals(resync.acceptedSequence, 5);
    assertEquals(resync.resyncNeeded, false);

    const resources = await cell.listMonitorResources(serverId);
    assertEquals(
      resources.some((row) => row.resourceKey === "container:gap"),
      true,
    );
  }),
);

Deno.test(
  "drainNotificationCandidates returns and clears candidates",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
      ]),
    );

    await cell.applyMonitorTransition({
      kind: "monitor-transition",
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      events: [{
        resourceKey: "container:a",
        kind: "container",
        fromStatus: "healthy",
        toStatus: "unhealthy",
        at: new Date().toISOString(),
      }],
      resources: [{
        resourceKey: "container:a",
        kind: "container",
        status: "unhealthy",
      }],
    });

    const first = await cell.drainNotificationCandidates(serverId);
    assertEquals(first.length, 1);
    const second = await cell.drainNotificationCandidates(serverId);
    assertEquals(second.length, 0);
  }),
);

Deno.test(
  "alert cooldown suppresses duplicate unhealthy notifications",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
      ]),
    );

    const transition = {
      kind: "monitor-transition" as const,
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      events: [{
        resourceKey: "container:a",
        kind: "container" as const,
        fromStatus: "healthy" as const,
        toStatus: "unhealthy" as const,
        at: new Date().toISOString(),
      }],
      resources: [{
        resourceKey: "container:a",
        kind: "container" as const,
        status: "unhealthy" as const,
      }],
    };
    await cell.applyMonitorTransition(transition);
    await cell.applyMonitorTransition({
      ...transition,
      sequence: 3,
      events: [{
        resourceKey: "container:a",
        kind: "container",
        fromStatus: "unhealthy",
        toStatus: "unhealthy",
        at: new Date().toISOString(),
      }],
    });

    const drained = await cell.drainNotificationCandidates(serverId);
    assertEquals(drained.length, 1);
  }),
);

Deno.test(
  "recovery closes open alert and emits recovery candidate",
  withRedisCell(async ({ cell, serverId }) => {
    await cell.applyMonitorSync(
      monitorSyncEnvelope(serverId, [
        { resourceKey: "container:a", kind: "container", status: "healthy" },
      ]),
    );

    await cell.applyMonitorTransition({
      kind: "monitor-transition",
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      events: [{
        resourceKey: "container:a",
        kind: "container",
        fromStatus: "healthy",
        toStatus: "unhealthy",
        at: new Date().toISOString(),
      }],
      resources: [{
        resourceKey: "container:a",
        kind: "container",
        status: "unhealthy",
      }],
    });

    await cell.applyMonitorTransition({
      kind: "monitor-transition",
      serverId,
      sequence: 3,
      at: new Date().toISOString(),
      events: [{
        resourceKey: "container:a",
        kind: "container",
        fromStatus: "unhealthy",
        toStatus: "healthy",
        at: new Date().toISOString(),
      }],
      resources: [{
        resourceKey: "container:a",
        kind: "container",
        status: "healthy",
      }],
    });

    const resources = await cell.listMonitorResources(serverId);
    const recovered = resources.find((row) =>
      row.resourceKey === "container:a"
    );
    assertEquals(recovered?.status, "healthy");
  }),
);
