import { assert, assertEquals } from "jsr:@std/assert";
import type { Db } from "../../../db.ts";
import {
  cellKeyPattern,
  leaseKey,
  metaKey,
  onlineSetKey,
  requestsKey,
} from "./keys.ts";
import { createFakeRedisCellClient } from "./fake-redis-cell-client.ts";
import { createRedisDaemonCellRegistry } from "./registry.ts";
import type { RedisCellClient } from "./client.ts";
import type { RedisDaemonCell } from "./cell.ts";

function fakeRegistry(client = createFakeRedisCellClient()) {
  return createRedisDaemonCellRegistry({
    client: client as unknown as RedisCellClient,
  });
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("registry getCell returns the same RedisDaemonCell for a serverId", () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const a = registry.getCell("srv-a");
  const b = registry.getCell("srv-a");
  const c = registry.getCell("srv-b");
  assertEquals(a, b);
  assert(a !== c);
});

test("registry listOnlineServerIds reads the online set", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const serverA = "srv-online-a";
  const serverB = "srv-online-b";
  await client.sadd(onlineSetKey(), serverA, serverB);

  const ids = await registry.listOnlineServerIds();
  assertEquals(ids.includes(serverA), true);
  assertEquals(ids.includes(serverB), true);
});

test("registry maintain invokes prune for online and indexed servers", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const serverId = `maintain-${crypto.randomUUID()}`;

  const requestId = crypto.randomUUID();
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  await client.hset(`tp:cell:${serverId}:request:${requestId}`, {
    requestId,
    requestKind: "tunnel-token",
    status: "queued",
    createdAt: expiredAt,
    expiresAt: expiredAt,
    deliveries: "{}",
  });
  await client.zadd(`tp:cell:${serverId}:requests`, Date.parse(expiredAt), requestId);
  await client.sadd(onlineSetKey(), serverId);

  await registry.maintain();

  assertEquals(
    await client.hgetall(`tp:cell:${serverId}:request:${requestId}`),
    null,
  );
});

test("registry purge delegates to cell.purge", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const serverId = `purge-${crypto.randomUUID()}`;
  const cell = registry.getCell(serverId) as RedisDaemonCell;

  await cell.attachDaemonSocket({ keyId: "key-1" });
  await registry.purge(serverId);

  assertEquals((await client.scanKeys(cellKeyPattern(serverId))).length, 0);
});

test("registry close clears the injected fake client", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  await client.set("tp:test:key", "value");
  await registry.close();
  assertEquals(client.closed, true);
});

test("registry getSnapshots loads snapshots for multiple servers", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const cellA = registry.getCell("snap-a") as RedisDaemonCell;
  const cellB = registry.getCell("snap-b") as RedisDaemonCell;

  await cellA.attachDaemonSocket({
    keyId: "key-a",
    remoteAddress: "203.0.113.10",
  });
  await cellB.attachDaemonSocket({
    keyId: "key-b",
    remoteAddress: "203.0.113.11",
  });

  const snapshots = await registry.getSnapshots(["snap-a", "snap-b", "snap-missing"]);
  assertEquals(snapshots.get("snap-a")?.connected, true);
  assertEquals(snapshots.get("snap-a")?.remoteAddress, "203.0.113.10");
  assertEquals(snapshots.get("snap-b")?.connected, true);
  assertEquals(snapshots.get("snap-missing")?.connected, false);
});

test("registry reclaimOrphanedSocketLeasesOnStartup clears scanned lease keys", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const serverA = `reclaim-a-${crypto.randomUUID()}`;
  const serverB = `reclaim-b-${crypto.randomUUID()}`;

  await client.setnxPersistent(leaseKey(serverA), "holder-a");
  await client.hset(metaKey(serverA), {
    connected: "1",
    connectionId: "holder-a",
    connectedAt: new Date().toISOString(),
  });
  await client.setnxPersistent(leaseKey(serverB), "holder-b");
  await client.hset(metaKey(serverB), {
    connected: "1",
    connectionId: "holder-b",
    connectedAt: new Date().toISOString(),
  });

  await registry.reclaimOrphanedSocketLeasesOnStartup();

  assertEquals(await client.get(leaseKey(serverA)), null);
  assertEquals(await client.get(leaseKey(serverB)), null);
  assertEquals((await client.hgetall(metaKey(serverA)))?.connected, "0");
  assertEquals((await client.hgetall(metaKey(serverB)))?.connected, "0");
});

test("registry maintain prunes indexed servers not in the online set", async () => {
  const client = createFakeRedisCellClient();
  const registry = fakeRegistry(client);
  const serverId = `indexed-only-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  const expiredAt = new Date(Date.now() - 60_000).toISOString();

  await client.hset(`tp:cell:${serverId}:request:${requestId}`, {
    requestId,
    requestKind: "tunnel-token",
    status: "queued",
    createdAt: expiredAt,
    expiresAt: expiredAt,
    deliveries: "{}",
  });
  await client.zadd(requestsKey(serverId), Date.parse(expiredAt), requestId);

  await registry.maintain();

  assertEquals(
    await client.hgetall(`tp:cell:${serverId}:request:${requestId}`),
    null,
  );
  assertEquals((await client.smembers(onlineSetKey())).includes(serverId), false);
});

test("registry maintain includes servers from updating projection db query", async () => {
  const client = createFakeRedisCellClient();
  const updatingServerId = `db-proj-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  const expiredAt = new Date(Date.now() - 60_000).toISOString();

  await client.hset(`tp:cell:${updatingServerId}:request:${requestId}`, {
    requestId,
    requestKind: "tunnel-token",
    status: "queued",
    createdAt: expiredAt,
    expiresAt: expiredAt,
    deliveries: "{}",
  });
  await client.zadd(
    requestsKey(updatingServerId),
    Date.parse(expiredAt),
    requestId,
  );

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: updatingServerId }]),
      }),
    }),
  } as unknown as Db;

  const registry = createRedisDaemonCellRegistry({
    client: client as unknown as RedisCellClient,
    db,
  });

  await registry.maintain();

  assertEquals(
    await client.hgetall(`tp:cell:${updatingServerId}:request:${requestId}`),
    null,
  );
});
