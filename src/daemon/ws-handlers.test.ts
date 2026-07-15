import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { RedisDaemonCell } from "./cell/redis/cell.ts";
import { it } from "@std/testing/bdd";
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

it(
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

it(
  "cell-backed recordInbound updates lastInboundAt",
  withRedisCell(async ({ cell, client, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });
    const at = new Date().toISOString();

    await cell.recordInbound({
      connectionId: attached.connectionId,
      at,
    });

    const snapshot = await cell.getSnapshot();
    assertEquals(snapshot.lastInboundAt, at);

    const leaseHolder = await client.get(leaseKey(serverId));
    assertEquals(leaseHolder, attached.connectionId);
  }),
);

it(
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

it(
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
      kind: "command-dispatch",
      deliveryId,
      requestId,
      at,
      commandId: "cmd-lifecycle",
      commandType: "daemon.ping",
      payload: {},
    });

    const batch = await cell.readOutboxBatch({ consumer, count: 10 });
    assertEquals(batch.length, 1);

    const wire = outboundEnvelopeToWireMessage(batch[0]!);
    assertEquals(wire.type, "command-dispatch");
    if (wire.type === "command-dispatch") {
      assertEquals(wire.commandId, "cmd-lifecycle");
      assertEquals(wire.commandType, "daemon.ping");
      assertEquals(wire.id, requestId);
    }

    await cell.ackOutbox([deliveryId], consumer);
    await cell.markSent(deliveryId, attached.connectionId);
  }),
);

it(
  "cell-backed disconnect cleanup clears connected presence",
  withRedisCell(async ({ cell, registry, serverId }) => {
    const attached = await cell.attachDaemonSocket({
      keyId: crypto.randomUUID(),
    });

    let online = await registry.listOnlineServerIds();
    assert(online.includes(serverId));

    await cell.detachDaemonSocket({
      connectionId: attached.connectionId,
      reason: "closed",
    });

    const snapshot = await cell.getSnapshot();
    assertEquals(snapshot.connected, false);

    online = await registry.listOnlineServerIds();
    assert(!online.includes(serverId));
  }),
);

it(
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

function skipLineComment(source: string, index: number): number {
  let i = index + 2;
  while (i < source.length && source[i] !== "\n") i += 1;
  return i;
}

function skipBlockComment(source: string, index: number): number {
  let i = index + 2;
  while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
    i += 1;
  }
  return i + 2;
}

function skipQuotedString(source: string, index: number, quote: string): number {
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      i = skipLineComment(source, i);
      continue;
    }

    if (ch === "/" && next === "*") {
      i = skipBlockComment(source, i);
      continue;
    }

    if (ch === "'" || ch === '"') {
      i = skipQuotedString(source, i, ch);
      out += " ";
      continue;
    }

    if (ch === "`") {
      i = skipQuotedString(source, i, "`");
      out += " ";
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

it("do.ts source stays hibernation-safe (no timers or server.accept)", async () => {
  const doPath = new URL("./cell/do.ts", import.meta.url);
  const source = await Deno.readTextFile(doPath);
  const stripped = stripCommentsAndStrings(source);

  assertEquals(/\bsetInterval\b/.test(stripped), false);
  assertEquals(/\bsetTimeout\b/.test(stripped), false);
  assertEquals(/\bscheduler\.wait\b/.test(stripped), false);
  assertEquals(/\bserver\.accept\s*\(/.test(stripped), false);
  assertEquals(/\bacceptWebSocket\b/.test(stripped), true);
});

it("do.ts projection DB ops stay time-bounded (no unbounded await that blocks hibernation)", async () => {
  const doPath = new URL("./cell/do.ts", import.meta.url);
  const source = await Deno.readTextFile(doPath);
  const stripped = stripCommentsAndStrings(source);

  // The projection helper MUST wrap the caller's fn in the hard client-side
  // deadline — a stalled Hyperdrive round-trip must never hold the DO awake.
  assertEquals(/\brunWithDbTimeout\s*\(/.test(stripped), true);
  // And it must still force-close the pool afterwards.
  assertEquals(/\bendDbConnection\s*\(/.test(stripped), true);
});

it("do-registry and workers-ws use stable getByName DO ids", async () => {
  const registryPath = new URL("./cell/do-registry.ts", import.meta.url);
  const workersWsPath = new URL("./workers-ws.ts", import.meta.url);

  for (const filePath of [registryPath, workersWsPath]) {
    const source = await Deno.readTextFile(filePath);
    const stripped = stripCommentsAndStrings(source);
    assertEquals(/\bgetByName\s*\(/.test(stripped), true);
    assertEquals(/\bnewUniqueId\s*\(/.test(stripped), false);
    assertEquals(/\bidFromName\s*\(/.test(stripped), false);
  }
});
