import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { RedisDaemonCell } from "./cell/redis/cell.ts";
import {
  createRedisCellClient,
  type RedisCellClient,
} from "./cell/redis/client.ts";
import { createRedisDaemonCellRegistry } from "./cell/redis/registry.ts";
import {
  leaseKey,
  metaKey,
  onlineSetKey,
  outboxKey,
  requestKey,
  requestsKey,
  snapshotKey,
} from "./cell/redis/keys.ts";
import {
  generateDeliveryId,
  generateRequestId,
  outboundEnvelopeToWireMessage,
} from "./cell/protocol.ts";

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
    registry: ReturnType<typeof createRedisDaemonCellRegistry>;
    cell: RedisDaemonCell;
    serverId: string;
  }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping ws-handlers regression test: Redis socket not found at ${DEFAULT_SOCKET}`,
      );
      return;
    }

    const client = createRedisCellClient();
    const registry = createRedisDaemonCellRegistry();
    const serverId = `ws-test-${crypto.randomUUID()}`;
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
  "cell-backed attach updates connected presence in snapshot",
  withRedisCell(async ({ cell, serverId }) => {
    const keyId = crypto.randomUUID();
    const attached = await cell.attachDaemonSocket({
      keyId,
      remoteAddress: "__direct__",
    });

    const snapshot = await cell.getSnapshot();
    assertEquals(snapshot.connected, true);
    assertEquals(snapshot.serverId, serverId);
    assertEquals(snapshot.remoteAddress, "__direct__");
    assertEquals(typeof attached.connectionId, "string");
  }),
);

Deno.test(
  "cell-backed recordInbound updates lastInboundAt and hostname",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const at = new Date().toISOString();

    await cell.recordInbound({
      connectionId: attached.connectionId,
      hostname: "test-host",
      at,
    });

    const snapshot = await cell.getSnapshot();
    assertEquals(snapshot.lastInboundAt, at);
    assertEquals(snapshot.hostname, "test-host");

    const leaseHolder = await client.get(leaseKey(serverId));
    assertEquals(leaseHolder, attached.connectionId);
  }),
);

Deno.test(
  "cell-backed inbound updates lastInboundAt via putSnapshot path",
  withRedisCell(async ({ cell }) => {
    await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    const at = new Date().toISOString();
    await cell.putSnapshot({ lastInboundAt: at });

    const snapshot = await cell.getSnapshot();
    assertEquals(snapshot.lastInboundAt, at);
  }),
);

Deno.test(
  "cell-backed outbox pump delivers queued command envelopes",
  withRedisCell(async ({ cell }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const consumer = `ws:${attached.connectionId}`;
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const at = new Date().toISOString();

    await cell.enqueue({
      kind: "command",
      deliveryId,
      requestId,
      at,
      command: "echo lifecycle",
    });

    const batch = await cell.readOutboxBatch({ consumer, count: 10 });
    assertEquals(batch.length, 1);

    const wire = outboundEnvelopeToWireMessage(batch[0]!);
    assertEquals(wire.type, "command");
    if (wire.type === "command") {
      assertEquals(wire.command, "echo lifecycle");
      assertEquals(wire.id, requestId);
    }

    await cell.ackOutbox([deliveryId], consumer);
    await cell.markSent(deliveryId, attached.connectionId);
  }),
);

Deno.test(
  "cell-backed disconnect cleanup clears connected presence",
  withRedisCell(async ({ cell, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    let online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));

    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
      leaseToken: attached.lease.token,
      reason: "closed",
    });

    const snapshot = await cell.getSnapshot();
    assertEquals(snapshot.connected, false);

    online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);

Deno.test(
  "cell-backed second attach is rejected while lease is held",
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
