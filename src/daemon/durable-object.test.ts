/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { generateDeliveryId, generateRequestId } from "./cell/protocol.ts";
import { MONITOR_OFFLINE_GRACE_MS } from "./cell/monitor-contracts.ts";
import type { DaemonCellObject } from "./cell/do.ts";

const CELL_HEADER = "X-Turbopanel-Cell-Server-Id";

function decodeJwtJti(token: string): string {
  const [, encodedPayload] = token.split(".");
  const padded = encodedPayload +
    "=".repeat((4 - (encodedPayload.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const payload = JSON.parse(atob(base64)) as { jti: string };
  return payload.jti;
}

async function issueTestDaemonJwt(
  serverId: string,
  keyId: string,
): Promise<string> {
  const secret = env.TURBOPANEL_SECRET ??
    "aa_daemon_cell_vitest_secret_value_aaaa_b";
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(secret, undefined, "workers"),
    "daemon-jwt-signing",
  );
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: keyId },
    secrets,
  );
  return issued.token;
}

function cellRpc(
  stub: DurableObjectStub,
  serverId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CELL_HEADER, serverId);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return stub.fetch(`https://do.internal${path}`, { ...init, headers });
}

async function openDaemonWebSocket(
  stub: DurableObjectStub,
  serverId: string,
  keyId = crypto.randomUUID(),
): Promise<{ ws: WebSocket; token: string; tokenId: string; keyId: string }> {
  const token = await issueTestDaemonJwt(serverId, keyId);
  const response = await stub.fetch("https://do.internal/ws/daemon/v1", {
    headers: {
      Authorization: `Bearer ${token}`,
      Upgrade: "websocket",
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("missing websocket");
  ws.accept();
  return { ws, token, tokenId: decodeJwtJti(token), keyId };
}

function waitForWebSocketMessage(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for websocket message"));
    }, timeoutMs);
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
    }, { once: true });
  });
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe("DaemonCellObject", () => {
  it("accepts hibernation-safe WebSocket attach with valid JWT", async () => {
    const serverId = "test-srv-1";
    const keyId = crypto.randomUUID();
    const stub = env.DAEMON_CELL.getByName(serverId);

    const { ws, tokenId } = await openDaemonWebSocket(stub, serverId, keyId);

    const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const snapshot = await snapshotResponse.json() as {
      connected: boolean;
      sessionId?: string;
    };
    expect(snapshot.connected).toBe(true);
    expect(snapshot.sessionId).toBe(tokenId);

    ws.close(1000, "test done");
  });

  it("delivers enqueued commands over websocket and completes on inbound result", async () => {
    const serverId = "test-srv-outbox";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const at = new Date().toISOString();

    const messagePromise = waitForWebSocketMessage(ws);

    const enqueueResponse = await cellRpc(stub, serverId, "/rpc/enqueue", {
      method: "POST",
      body: JSON.stringify({
        outbound: {
          kind: "command",
          deliveryId,
          requestId,
          at,
          command: "echo test",
        },
        opts: { ttlSeconds: 300 },
      }),
    });
    expect(enqueueResponse.status).toBe(200);

    const raw = await messagePromise;
    const msg = JSON.parse(raw) as {
      type: string;
      command?: string;
      id?: string;
    };
    expect(msg.type).toBe("command");
    expect(msg.command).toBe("echo test");
    expect(msg.id).toBe(requestId);

    ws.send(JSON.stringify({
      type: "command-result",
      id: requestId,
      exitCode: 0,
      stdout: "test",
      stderr: "",
      at: new Date().toISOString(),
    }));

    await waitFor(async () => {
      const doneResponse = await cellRpc(
        stub,
        serverId,
        `/rpc/request?requestId=${requestId}`,
        { method: "GET" },
      );
      const doneBody = await doneResponse.json() as {
        record: { status: string; result?: { stdout: string } };
      };
      expect(doneBody.record.status).toBe("done");
      expect(doneBody.record.result?.stdout).toBe("test");
    });

    ws.close(1000, "test done");
  });

  it(
    "evicts an existing websocket when a second attach succeeds for the same server",
    async () => {
      const serverId = "test-srv-dual";
      const stub = env.DAEMON_CELL.getByName(serverId);

      const first = await openDaemonWebSocket(stub, serverId);
      const second = await openDaemonWebSocket(stub, serverId);

      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        connected: boolean;
        sessionId?: string;
      };
      expect(snapshot.connected).toBe(true);
      expect(snapshot.sessionId).toBe(second.tokenId);

      const requestId = generateRequestId();
      const deliveryId = generateDeliveryId();
      const at = new Date().toISOString();
      let firstReceived = false;
      first.ws.addEventListener("message", () => {
        firstReceived = true;
      });
      const secondMessagePromise = waitForWebSocketMessage(second.ws);

      await cellRpc(stub, serverId, "/rpc/enqueue", {
        method: "POST",
        body: JSON.stringify({
          outbound: {
            kind: "command",
            deliveryId,
            requestId,
            at,
            command: "after-evict",
          },
        }),
      });

      const raw = await secondMessagePromise;
      const msg = JSON.parse(raw) as { type: string; command?: string };
      expect(msg.type).toBe("command");
      expect(msg.command).toBe("after-evict");
      expect(firstReceived).toBe(false);

      await waitFor(() => {
        expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(
          first.ws.readyState,
        );
      });

      second.ws.close(1000, "test done");
    },
    15_000,
  );

  it("persists outbox requests across RPC calls and stub re-fetch", async () => {
    const serverId = "test-srv-2";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const at = new Date().toISOString();

    const enqueueResponse = await cellRpc(stub, serverId, "/rpc/enqueue", {
      method: "POST",
      body: JSON.stringify({
        outbound: {
          kind: "command",
          deliveryId,
          requestId,
          at,
          command: "echo test",
        },
        opts: { ttlSeconds: 300 },
      }),
    });
    expect(enqueueResponse.status).toBe(200);

    const queuedResponse = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: "GET" },
    );
    const queuedBody = await queuedResponse.json() as {
      record: { status: string };
    };
    expect(queuedBody.record.status).toBe("queued");

    await cellRpc(stub, serverId, "/rpc/inbound", {
      method: "POST",
      body: JSON.stringify({
        inbound: {
          kind: "command-result",
          requestId,
          at,
          exitCode: 0,
          stdout: "test",
          stderr: "",
        },
      }),
    });

    const doneResponse = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: "GET" },
    );
    const doneBody = await doneResponse.json() as {
      record: { status: string; result?: { stdout: string } };
    };
    expect(doneBody.record.status).toBe("done");
    expect(doneBody.record.result?.stdout).toBe("test");

    const refetchedStub = env.DAEMON_CELL.getByName(serverId);
    const persistedResponse = await cellRpc(
      refetchedStub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: "GET" },
    );
    const persistedBody = await persistedResponse.json() as {
      record: { status: string };
    };
    expect(persistedBody.record.status).toBe("done");
  });

  it("prune removes expired request rows", async () => {
    const serverId = "test-srv-2-alarm";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const requestId = generateRequestId();

    await cellRpc(stub, serverId, "/rpc/enqueue", {
      method: "POST",
      body: JSON.stringify({
        outbound: {
          kind: "command",
          deliveryId: generateDeliveryId(),
          requestId,
          at: new Date().toISOString(),
          command: "short-lived",
        },
        opts: { ttlSeconds: 1 },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await cellRpc(stub, serverId, "/rpc/prune", {
      method: "POST",
      body: JSON.stringify({ now: Date.now() + 5000 }),
    });

    const response = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: "GET" },
    );
    const body = await response.json() as { record: unknown };
    expect(body.record).toBeNull();
  });

  it("getByName accepts location hints and generation suffixes", async () => {
    const stubWithHint = env.DAEMON_CELL.getByName("test-srv-3", {
      locationHint: "wnam",
    });
    expect(stubWithHint).toBeDefined();

    const generationOne = env.DAEMON_CELL.getByName("test-srv-3");
    const generationTwo = env.DAEMON_CELL.getByName("test-srv-3:g2");
    expect(generationOne.id.toString()).not.toBe(generationTwo.id.toString());
  });

  it("challenge issue and consume are single-use via RPC", async () => {
    const serverId = "test-srv-challenge";
    const stub = env.DAEMON_CELL.getByName(serverId);

    const issueResponse = await cellRpc(
      stub,
      serverId,
      "/rpc/challenge/issue",
      {
        method: "POST",
        body: JSON.stringify({
          serverId: "",
          keyId: "",
          ttlMs: 15_000,
        }),
      },
    );
    expect(issueResponse.status).toBe(200);
    const issued = await issueResponse.json() as {
      id: string;
      nonce: string;
      at: string;
    };
    expect(typeof issued.id).toBe("string");
    expect(typeof issued.nonce).toBe("string");
    expect(typeof issued.at).toBe("string");

    const firstConsume = await cellRpc(
      stub,
      serverId,
      "/rpc/challenge/consume",
      {
        method: "POST",
        body: JSON.stringify({ challengeId: issued.id }),
      },
    );
    const firstBody = await firstConsume.json() as {
      challenge: { id: string } | null;
    };
    expect(firstBody.challenge?.id).toBe(issued.id);

    const secondConsume = await cellRpc(
      stub,
      serverId,
      "/rpc/challenge/consume",
      {
        method: "POST",
        body: JSON.stringify({ challengeId: issued.id }),
      },
    );
    const secondBody = await secondConsume.json() as {
      challenge: unknown;
    };
    expect(secondBody.challenge).toBeNull();
  });

  it("applyMonitorSync via RPC stores resources", async () => {
    const serverId = "test-srv-monitor-sync";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const syncMsg = {
      kind: "monitor-sync",
      serverId,
      sequence: 1,
      at: new Date().toISOString(),
      protocolVersion: 1,
      instance: {},
      resources: [{
        resourceKey: "container:abc",
        kind: "container",
        status: "healthy",
      }],
    };

    const syncResponse = await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({ serverId, msg: syncMsg }),
    });
    expect(syncResponse.status).toBe(200);
    const syncBody = await syncResponse.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    expect(syncBody.acceptedSequence).toBe(1);

    const resourcesResponse = await cellRpc(
      stub,
      serverId,
      "/rpc/monitor/resources",
      {
        method: "GET",
      },
    );
    const resourcesBody = await resourcesResponse.json() as {
      resources: Array<{ resourceKey: string }>;
    };
    expect(
      resourcesBody.resources.some((row) =>
        row.resourceKey === "container:abc"
      ),
    ).toBe(true);
  });

  it("applyMonitorHeartbeat via RPC is idempotent on duplicate sequence", async () => {
    const serverId = "test-srv-monitor-heartbeat";
    const stub = env.DAEMON_CELL.getByName(serverId);
    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [],
        },
      }),
    });

    const heartbeat = {
      kind: "monitor-heartbeat",
      serverId,
      sequence: 2,
      at: new Date().toISOString(),
      instance: {},
    };
    const first = await cellRpc(stub, serverId, "/rpc/monitor/heartbeat", {
      method: "POST",
      body: JSON.stringify({ serverId, msg: heartbeat }),
    });
    const second = await cellRpc(stub, serverId, "/rpc/monitor/heartbeat", {
      method: "POST",
      body: JSON.stringify({ serverId, msg: heartbeat }),
    });
    const firstBody = await first.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    const secondBody = await second.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    expect(firstBody.acceptedSequence).toBe(2);
    expect(secondBody.acceptedSequence).toBe(2);
    expect(secondBody.resyncNeeded).toBe(false);
  });

  it("applyMonitorSync accepts newer sequence after heartbeat gap", async () => {
    const serverId = "test-srv-monitor-gap-resync";
    const stub = env.DAEMON_CELL.getByName(serverId);
    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [],
        },
      }),
    });

    const gapHeartbeat = await cellRpc(stub, serverId, "/rpc/monitor/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-heartbeat",
          serverId,
          sequence: 3,
          at: new Date().toISOString(),
          instance: {},
        },
      }),
    });
    const gapBody = await gapHeartbeat.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    expect(gapBody.resyncNeeded).toBe(true);
    expect(gapBody.acceptedSequence).toBe(1);

    const resync = await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 5,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [{
            resourceKey: "container:gap",
            kind: "container",
            status: "healthy",
          }],
        },
      }),
    });
    const resyncBody = await resync.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    expect(resyncBody.acceptedSequence).toBe(5);
    expect(resyncBody.resyncNeeded).toBe(false);
  });

  it("offline deadline processing marks resources offline after grace", async () => {
    const serverId = "test-srv-monitor-offline";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const staleAt = new Date(Date.now() - MONITOR_OFFLINE_GRACE_MS - 60_000)
      .toISOString();

    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: staleAt,
          protocolVersion: 1,
          instance: {},
          resources: [{
            resourceKey: "container:abc",
            kind: "container",
            status: "healthy",
          }],
        },
      }),
    });

    await cellRpc(stub, serverId, "/rpc/prune", {
      method: "POST",
      body: JSON.stringify({
        now: Date.now() + MONITOR_OFFLINE_GRACE_MS + 60_000,
      }),
    });

    const resourcesResponse = await cellRpc(
      stub,
      serverId,
      "/rpc/monitor/resources",
      {
        method: "GET",
      },
    );
    const resourcesBody = await resourcesResponse.json() as {
      resources: Array<{ status: string }>;
    };
    expect(resourcesBody.resources.some((row) => row.status === "offline"))
      .toBe(true);
  });

  it(
    "alarm() processes due offline deadlines and reschedules the next alarm",
    async () => {
      const serverId = "test-srv-monitor-alarm";
      const stub = env.DAEMON_CELL.getByName(serverId);
      const staleAt = new Date(Date.now() - MONITOR_OFFLINE_GRACE_MS - 60_000)
        .toISOString();

      await cellRpc(stub, serverId, "/rpc/monitor/sync", {
        method: "POST",
        body: JSON.stringify({
          serverId,
          msg: {
            kind: "monitor-sync",
            serverId,
            sequence: 1,
            at: staleAt,
            protocolVersion: 1,
            instance: {},
            resources: [{
              resourceKey: "container:alarm",
              kind: "container",
              status: "healthy",
            }],
          },
        }),
      });

      const alarmBefore = await runInDurableObject(
        stub,
        async (_instance, state) => await state.storage.getAlarm(),
      );
      expect(alarmBefore).not.toBeNull();

      await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
        state.storage.sql.exec(
          "UPDATE monitor_deadline SET due_at = ? WHERE deadline_name = 'offline'",
          new Date(Date.now() - 60_000).toISOString(),
        );
        await instance.alarm();
      });

      const resourcesResponse = await cellRpc(
        stub,
        serverId,
        "/rpc/monitor/resources",
        { method: "GET" },
      );
      const resourcesBody = await resourcesResponse.json() as {
        resources: Array<{ status: string }>;
      };
      expect(resourcesBody.resources.some((row) => row.status === "offline"))
        .toBe(true);

      await cellRpc(stub, serverId, "/rpc/monitor/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          serverId,
          msg: {
            kind: "monitor-heartbeat",
            serverId,
            sequence: 2,
            at: new Date().toISOString(),
            instance: {},
          },
        }),
      });

      const alarmAfter = await runInDurableObject(
        stub,
        async (_instance, state) => await state.storage.getAlarm(),
      );
      expect(alarmAfter).not.toBeNull();
      expect(alarmAfter).toBeGreaterThan(Date.now());
    },
  );

  it("drainNotificationCandidates via RPC returns unhealthy alerts", async () => {
    const serverId = "test-srv-monitor-drain";
    const stub = env.DAEMON_CELL.getByName(serverId);
    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [{
            resourceKey: "container:abc",
            kind: "container",
            status: "healthy",
          }],
        },
      }),
    });

    await cellRpc(stub, serverId, "/rpc/monitor/transition", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-transition",
          serverId,
          sequence: 2,
          at: new Date().toISOString(),
          events: [{
            resourceKey: "container:abc",
            kind: "container",
            fromStatus: "healthy",
            toStatus: "unhealthy",
            at: new Date().toISOString(),
          }],
          resources: [{
            resourceKey: "container:abc",
            kind: "container",
            status: "unhealthy",
          }],
        },
      }),
    });

    const drainResponse = await cellRpc(
      stub,
      serverId,
      "/rpc/monitor/drain-candidates",
      {
        method: "POST",
        body: JSON.stringify({ serverId }),
      },
    );
    const drainBody = await drainResponse.json() as {
      alerts: Array<{ resourceKey: string }>;
    };
    expect(drainBody.alerts.length).toBeGreaterThan(0);
  });

  it("prune removes stale monitor_metric_minute rows", async () => {
    const serverId = "test-srv-monitor-prune-metrics";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const staleAt = new Date(Date.now() - (73 * 60 * 60 * 1000)).toISOString();

    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: staleAt,
          protocolVersion: 1,
          instance: { cpu: { cores: 1 } },
          resources: [],
        },
      }),
    });

    await cellRpc(stub, serverId, "/rpc/prune", {
      method: "POST",
      body: JSON.stringify({ now: Date.now() }),
    });

    const metricsResponse = await cellRpc(
      stub,
      serverId,
      "/rpc/monitor/metrics?limit=100",
      { method: "GET" },
    );
    const metricsBody = await metricsResponse.json() as {
      metrics: Array<{ bucketAt: string }>;
    };
    expect(metricsBody.metrics.length).toBe(0);
  });

  it("idle websocket attach does not schedule a recurring outbox alarm", async () => {
    const serverId = "test-srv-idle-alarm";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const alarm = await runInDurableObject(
      stub,
      async (_instance, state) => await state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();

    ws.close(1000, "test done");
  });

  it("enqueue without websocket does not schedule an outbox pump alarm", async () => {
    const serverId = "test-srv-outbox-no-alarm";
    const stub = env.DAEMON_CELL.getByName(serverId);

    await cellRpc(stub, serverId, "/rpc/enqueue", {
      method: "POST",
      body: JSON.stringify({
        outbound: {
          kind: "command",
          deliveryId: generateDeliveryId(),
          requestId: generateRequestId(),
          at: new Date().toISOString(),
          command: "queued-without-socket",
        },
      }),
    });

    const alarm = await runInDurableObject(
      stub,
      async (_instance, state) => await state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it(
    "websocket stays open across one monitor heartbeat interval without instance pings",
    async () => {
      const serverId = "test-srv-idle-ws";
      const stub = env.DAEMON_CELL.getByName(serverId);
      const { ws } = await openDaemonWebSocket(stub, serverId);

      ws.send(JSON.stringify({
        type: "monitor.sync",
        from: "daemon",
        serverId,
        sequence: 1,
        at: new Date().toISOString(),
        protocolVersion: 1,
        instance: {},
        resources: [],
      }));

      await waitForWebSocketMessage(ws);

      await new Promise((resolve) => setTimeout(resolve, 65_000));

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close(1000, "test done");
    },
    75_000,
  );

  it("attach resets monitor sequence for reconnect sync", async () => {
    const serverId = "test-srv-reconnect-seq";
    const stub = env.DAEMON_CELL.getByName(serverId);

    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 4,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [{
            resourceKey: "container:reconnect",
            kind: "container",
            status: "healthy",
          }],
        },
      }),
    });

    await cellRpc(stub, serverId, "/rpc/attach", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        meta: { keyId: crypto.randomUUID() },
      }),
    });

    const emptySync = await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [],
        },
      }),
    });
    const emptyBody = await emptySync.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    expect(emptyBody.acceptedSequence).toBe(1);
    expect(emptyBody.resyncNeeded).toBe(false);

    const fullSync = await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 2,
          at: new Date().toISOString(),
          protocolVersion: 1,
          instance: {},
          resources: [{
            resourceKey: "container:reconnect",
            kind: "container",
            status: "degraded",
          }],
        },
      }),
    });
    const fullBody = await fullSync.json() as {
      acceptedSequence: number;
      resyncNeeded: boolean;
    };
    expect(fullBody.acceptedSequence).toBe(2);
    expect(fullBody.resyncNeeded).toBe(false);
  });

  it("websocket close marks snapshot disconnected", async () => {
    const serverId = "test-srv-ws-disconnect";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    ws.close(1000, "test done");
    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as { connected: boolean };
      expect(snapshot.connected).toBe(false);
    });
  });

  it("websocket close advances lastSeenAt on the cell snapshot", async () => {
    const serverId = "test-srv-ws-last-seen";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const connectedResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const connectedSnapshot = await connectedResponse.json() as {
      connected: boolean;
      lastSeenAt?: string;
    };
    expect(connectedSnapshot.connected).toBe(true);
    expect(connectedSnapshot.lastSeenAt).toBeTruthy();
    const connectedLastSeenMs = Date.parse(connectedSnapshot.lastSeenAt!);
    expect(Number.isNaN(connectedLastSeenMs)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));

    ws.close(1000, "test done");
    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        connected: boolean;
        lastSeenAt?: string;
      };
      expect(snapshot.connected).toBe(false);
      expect(snapshot.lastSeenAt).toBeTruthy();
      const disconnectedLastSeenMs = Date.parse(snapshot.lastSeenAt!);
      expect(disconnectedLastSeenMs).toBeGreaterThanOrEqual(connectedLastSeenMs);
    });
  });

  it("offline deadline processing advances lastSeenAt on the cell snapshot", async () => {
    const serverId = "test-srv-monitor-offline-last-seen";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const staleAt = new Date(Date.now() - MONITOR_OFFLINE_GRACE_MS - 60_000)
      .toISOString();

    const { ws } = await openDaemonWebSocket(stub, serverId);
    await cellRpc(stub, serverId, "/rpc/monitor/sync", {
      method: "POST",
      body: JSON.stringify({
        serverId,
        msg: {
          kind: "monitor-sync",
          serverId,
          sequence: 1,
          at: staleAt,
          protocolVersion: 1,
          instance: {},
          resources: [{
            resourceKey: "container:offline-last-seen",
            kind: "container",
            status: "healthy",
          }],
        },
      }),
    });

    const connectedResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const connectedSnapshot = await connectedResponse.json() as {
      lastSeenAt?: string;
    };
    expect(connectedSnapshot.lastSeenAt).toBeTruthy();
    const beforeOfflineMs = Date.parse(connectedSnapshot.lastSeenAt!);

    ws.close(1000, "test done");
    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as { connected: boolean };
      expect(snapshot.connected).toBe(false);
    });

    await cellRpc(stub, serverId, "/rpc/prune", {
      method: "POST",
      body: JSON.stringify({
        now: Date.now() + MONITOR_OFFLINE_GRACE_MS + 60_000,
      }),
    });

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        lastSeenAt?: string;
      };
      expect(snapshot.lastSeenAt).toBeTruthy();
      const afterOfflineMs = Date.parse(snapshot.lastSeenAt!);
      expect(afterOfflineMs).toBeGreaterThanOrEqual(beforeOfflineMs);
    });
  });

  it(
    "stale websocket close does not mark a newer attach offline",
    async () => {
      const serverId = "test-srv-stale-close";
      const stub = env.DAEMON_CELL.getByName(serverId);

      const first = await openDaemonWebSocket(stub, serverId);
      const second = await openDaemonWebSocket(stub, serverId);

      await waitFor(() => {
        expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(
          first.ws.readyState,
        );
      });

      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        connected: boolean;
        sessionId?: string;
      };
      expect(snapshot.connected).toBe(true);
      expect(snapshot.sessionId).toBe(second.tokenId);

      second.ws.close(1000, "test done");
    },
    15_000,
  );

  it(
    "requeues and redelivers outbox commands after socket closes during delivery",
    async () => {
      const serverId = "test-srv-outbox-reconnect";
      const stub = env.DAEMON_CELL.getByName(serverId);
      const requestId = generateRequestId();
      const deliveryId = generateDeliveryId();
      const at = new Date().toISOString();

      const first = await openDaemonWebSocket(stub, serverId);
      let firstReceived = false;
      first.ws.addEventListener("message", () => {
        firstReceived = true;
      });

      const enqueueResponse = cellRpc(stub, serverId, "/rpc/enqueue", {
        method: "POST",
        body: JSON.stringify({
          outbound: {
            kind: "command",
            deliveryId,
            requestId,
            at,
            command: "retry-after-reconnect",
          },
        }),
      });
      first.ws.close(4000, "simulate delivery failure");
      await enqueueResponse;

      await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
        const cursor = state.storage.sql.exec(
          "SELECT status FROM outbox WHERE delivery_id = ?",
          deliveryId,
        );
        let status = "missing";
        for (const row of cursor) {
          status = String(row.status ?? "");
        }
        if (status === "acked") {
          throw new Error("outbox item was acked before reconnect test could run");
        }
        if (status === "inflight") {
          state.storage.sql.exec(
            `UPDATE outbox SET sent_at = ? WHERE delivery_id = ?`,
            new Date(Date.now() - 60_000).toISOString(),
            deliveryId,
          );
          await instance.alarm();
        }
      });

      const second = await openDaemonWebSocket(stub, serverId);
      const raw = await waitForWebSocketMessage(second.ws);
      const msg = JSON.parse(raw) as {
        type: string;
        command?: string;
        id?: string;
      };
      expect(msg.type).toBe("command");
      expect(msg.command).toBe("retry-after-reconnect");
      expect(msg.id).toBe(requestId);
      expect(firstReceived).toBe(false);

      second.ws.close(1000, "test done");
    },
    15_000,
  );
});
