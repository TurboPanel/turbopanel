import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
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
  leaseKey,
  metaKey,
  onlineSetKey,
  outboxKey,
  requestKey,
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
  "ackOutbox clears pending entries and drops outbox stream length",
  withRedisCell(async ({ cell, client, serverId }) => {
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
    const requestId = generateRequestId();
    const record = await cell.createRequestAndWait(
      {
        kind: "command",
        deliveryId: generateDeliveryId(),
        requestId,
        at: new Date().toISOString(),
        command: "noop",
      },
      300,
    );
    assertEquals(record.status, "expired");
    assertEquals(await cell.getRequest(requestId), null);
    assertEquals(await cell.listRequests(), []);
  }),
);

Deno.test(
  "timed-out request is not delivered after reconnect",
  withRedisCell(async ({ cell }) => {
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const outbound = {
      kind: "command" as const,
      deliveryId,
      requestId,
      at: new Date().toISOString(),
      command: "stale-command",
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

Deno.test(
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

Deno.test(
  "attach uses persistent daemon socket lease",
  withRedisCell(async ({ cell, client, serverId }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const ttl = await client.pttl(leaseKey(serverId));
    assertEquals(ttl, -1);
  }),
);

Deno.test(
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

Deno.test(
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

Deno.test(
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

Deno.test(
  "purge deletes historical connection hashes after reconnect",
  withRedisCell(async ({ cell, client, serverId }) => {
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

Deno.test(
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

Deno.test(
  "handleInbound deletes non-update request row on terminal status",
  withRedisCell(async ({ cell, client, serverId }) => {
    const requestId = generateRequestId();
    const at = new Date().toISOString();
    await cell.enqueue({
      kind: "command",
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      command: "done",
    });

    await cell.handleInbound({
      kind: "command-result",
      requestId,
      at,
      exitCode: 0,
      stdout: "",
      stderr: "",
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

Deno.test(
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
