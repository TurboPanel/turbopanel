/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db.ts";
import { setDaemonCellProjectionDbFactoryForTests } from "./do.ts";
import { createDurableObjectDaemonCellRegistry } from "./do-registry.ts";
import {
  generateDeliveryId,
  generateRequestId,
} from "./protocol.ts";

function createNoopProjectionDb(): Db {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
    $client: { end: async () => undefined },
  } as unknown as Db;
  return db;
}

function createOnlineListDb(serverIds: string[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(serverIds.map((id) => ({ id }))),
      }),
    }),
  } as unknown as Db;
}

beforeEach(() => {
  setDaemonCellProjectionDbFactoryForTests(createNoopProjectionDb);
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe("createDurableObjectDaemonCellRegistry", () => {
  it("reuses the same cell instance per serverId", () => {
    const registry = createDurableObjectDaemonCellRegistry(env);
    const first = registry.getCell("test-srv-registry-cache");
    const second = registry.getCell("test-srv-registry-cache");
    expect(first).toBe(second);
    expect(first).not.toBe(registry.getCell("test-srv-registry-other"));
  });

  it("getSnapshot and putSnapshot round-trip runtime flags", async () => {
    const serverId = "test-srv-registry-snapshot";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);

    const attach = await cell.attachDaemonSocket({
      keyId: "key-registry",
      remoteAddress: "203.0.113.50",
      connectedAt: new Date().toISOString(),
    });
    expect(attach.connectionId).toBeTruthy();

    const before = await cell.getSnapshot();
    expect(before.connected).toBe(true);

    const patched = await cell.putSnapshot({ connected: true });
    expect(patched.connected).toBe(true);

    await cell.detachDaemonSocket({
      connectionId: attach.connectionId,
      reason: "registry test",
    });
    const after = await cell.getSnapshot();
    expect(after.connected).toBe(false);
  });

  it("enqueue, listRequests, markSent, and handleInbound correlate a command", async () => {
    const serverId = "test-srv-registry-command";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const at = new Date().toISOString();

    const queued = await cell.enqueue({
      kind: "command-dispatch",
      deliveryId,
      requestId,
      at,
      commandId: "cmd-registry",
      commandType: "daemon.ping",
      payload: {},
    });
    expect(queued.status).toBe("queued");

    const listed = await cell.listRequests(10, "command-dispatch");
    expect(listed.some((row) => row.requestId === requestId)).toBe(true);

    await cell.markSent(deliveryId, "conn-registry", at);

    const acked = await cell.handleInbound({
      kind: "command-ack",
      requestId,
      at,
      daemonReceivedAt: at,
    });
    expect(acked?.status).toBe("acked");

    const done = await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    });
    expect(done?.status).toBe("done");
    expect(await cell.getRequest(requestId)).toMatchObject({ status: "done" });
  });

  it("waitForRequest returns a terminal record without blocking the DO", async () => {
    const serverId = "test-srv-registry-wait";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const at = new Date().toISOString();

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId,
      requestId,
      at,
      commandId: "cmd-wait",
      commandType: "daemon.ping",
      payload: {},
    });

    await cell.handleInbound({
      kind: "command-outcome",
      requestId,
      at,
      ok: true,
      result: { ok: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    });

    const record = await cell.waitForRequest(requestId, 2000);
    expect(record?.status).toBe("done");
  });

  it("delivery lease claim, renew, and release succeed", async () => {
    const serverId = "test-srv-registry-lease";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);

    const claimed = await cell.claimDeliveryLease("consumer-a", 60_000);
    expect(claimed?.holder).toBe("consumer-a");
    expect(claimed?.expiresAt).toBeTruthy();

    const renewed = await cell.renewDeliveryLease("consumer-a", 60_000);
    expect(renewed?.holder).toBe("consumer-a");

    await cell.releaseDeliveryLease("consumer-a");
  });

  it("readOutboxBatch and ackOutbox drain queued envelopes", async () => {
    const serverId = "test-srv-registry-outbox";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();

    await cell.enqueue({
      kind: "command-dispatch",
      deliveryId,
      requestId,
      at: new Date().toISOString(),
      commandId: "cmd-outbox",
      commandType: "daemon.ping",
      payload: {},
    });

    const envelopes = await cell.readOutboxBatch({
      consumer: "registry-test",
      count: 5,
    });
    expect(envelopes.some((entry) => entry.requestId === requestId)).toBe(true);

    await cell.ackOutbox([deliveryId], "registry-test");
  });

  it("clearUpdateStatus removes terminal update rows", async () => {
    const serverId = "test-srv-registry-clear-update";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);
    const requestId = generateRequestId();
    const at = new Date().toISOString();

    await cell.enqueue(
      {
        kind: "update",
        deliveryId: generateDeliveryId(),
        requestId,
        at,
        channel: "trunk",
      },
      { ttlSeconds: 300 },
    );

    await cell.handleInbound({
      kind: "update-result",
      requestId,
      at,
      ok: true,
    });

    const result = await cell.clearUpdateStatus();
    expect(result.cleared).toBeGreaterThanOrEqual(1);
  });

  it("getDiagnostics and checkLiveness expose cell probes", async () => {
    const serverId = "test-srv-registry-diagnostics";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);

    const diag = await cell.getDiagnostics();
    expect(diag.backend).toBe("durable-object");

    const liveness = await cell.checkLiveness();
    expect(liveness.connected).toBe(false);
    expect(liveness.lastPingAtMs).toBeNull();
  });

  it("recordInbound accepts heartbeat metadata", async () => {
    const serverId = "test-srv-registry-record-inbound";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);

    await cell.attachDaemonSocket({
      keyId: "key-inbound",
      remoteAddress: "203.0.113.51",
    });

    await expect(cell.recordInbound({
      at: new Date().toISOString(),
      agent: { commit: "abc", buildId: "1", channel: "trunk" },
    })).resolves.toBeUndefined();

    const snapshot = await cell.getSnapshot();
    expect(snapshot.connected).toBe(true);
  });

  it("getSnapshots batches snapshot reads", async () => {
    const registry = createDurableObjectDaemonCellRegistry(env);
    const ids = ["test-srv-registry-batch-a", "test-srv-registry-batch-b"];
    const map = await registry.getSnapshots(ids);
    expect(map.size).toBe(2);
    for (const id of ids) {
      expect(map.get(id)?.connected).toBe(false);
    }
  });

  it("listOnlineServerIds reads connected rows from Postgres", async () => {
    const db = createOnlineListDb(["online-a", "online-b"]);
    const registry = createDurableObjectDaemonCellRegistry(env, db);
    await expect(registry.listOnlineServerIds()).resolves.toEqual([
      "online-a",
      "online-b",
    ]);
  });

  it("listOnlineServerIds returns empty when db is absent", async () => {
    const registry = createDurableObjectDaemonCellRegistry(env);
    await expect(registry.listOnlineServerIds()).resolves.toEqual([]);
  });

  it("purge wipes cell state via registry", async () => {
    const serverId = "test-srv-registry-purge";
    const registry = createDurableObjectDaemonCellRegistry(env);
    const cell = registry.getCell(serverId);

    await cell.attachDaemonSocket({ keyId: "key-purge" });
    await registry.purge(serverId);

    const snapshot = await cell.getSnapshot();
    expect(snapshot.connected).toBe(false);
  });

  it("uses location hints when resolving stubs", async () => {
    const serverId = "test-srv-registry-location";
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{
              metadata: {},
              options: { cellLocationHint: "wnam" },
            }]),
          }),
        }),
      }),
    } as unknown as Db;
    const registry = createDurableObjectDaemonCellRegistry(env, db);
    const cell = registry.getCell(serverId);
    const snapshot = await cell.getSnapshot();
    expect(snapshot.connected).toBe(false);
    expect(snapshot.serverId).toBe(serverId);
  });
});
