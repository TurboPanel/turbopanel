/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { generateDeliveryId, generateRequestId } from "./cell/protocol.ts";
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
        record: { status: string; result?: { stdout: string } } | null;
      };
      expect(doneBody.record).toBeNull();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = state.storage.sql.exec(
        "SELECT seq FROM outbox WHERE request_id = ?",
        requestId,
      );
      for (const _ of cursor) {
        throw new Error("expected terminal outbox row to be deleted");
      }
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

    const inboundResponse = await cellRpc(stub, serverId, "/rpc/inbound", {
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
    const inboundBody = await inboundResponse.json() as {
      record: { status: string; result?: { stdout: string } };
    };
    expect(inboundBody.record.status).toBe("done");
    expect(inboundBody.record.result?.stdout).toBe("test");

    const refetchedStub = env.DAEMON_CELL.getByName(serverId);
    const persistedResponse = await cellRpc(
      refetchedStub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: "GET" },
    );
    const persistedBody = await persistedResponse.json() as {
      record: unknown;
    };
    expect(persistedBody.record).toBeNull();
  });

  it("alarm expires old request rows", async () => {
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

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm();
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

  it("getByName accepts location hints", async () => {
    const stubWithHint = env.DAEMON_CELL.getByName("test-srv-3", {
      locationHint: "wnam",
    });
    expect(stubWithHint).toBeDefined();
  });

  it("hello message updates last_seen_at without ack", async () => {
    const serverId = "test-srv-hello";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    ws.send(JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      agent: { commit: "abc", buildId: "1" },
    }));

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        lastSeenAt?: string;
        agent?: { commit: string; buildId: string };
      };
      expect(snapshot.lastSeenAt).toBeTruthy();
      expect(snapshot.agent?.commit).toBe("abc");
      expect(snapshot.agent?.buildId).toBe("1");
    });

    ws.close(1000, "test done");
  });

  it("purge-cell clears storage and resets snapshot", async () => {
    const serverId = "test-srv-purge";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);
    ws.close(1000, "test done");

    const purgeResponse = await cellRpc(stub, serverId, "/rpc/purge-cell", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(purgeResponse.status).toBe(200);
    const purgeBody = await purgeResponse.json() as { ok: boolean };
    expect(purgeBody.ok).toBe(true);

    const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const snapshot = await snapshotResponse.json() as {
      connected: boolean;
    };
    expect(snapshot.connected).toBe(false);
  });

  it("websocket close marks snapshot disconnected immediately", async () => {
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

  it("idle alarm clears after outbox drains", async () => {
    const serverId = "test-srv-outbox-drain-alarm";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const at = new Date().toISOString();
    const messagePromise = waitForWebSocketMessage(ws);

    await cellRpc(stub, serverId, "/rpc/enqueue", {
      method: "POST",
      body: JSON.stringify({
        outbound: {
          kind: "command",
          deliveryId,
          requestId,
          at,
          command: "drain-alarm",
        },
      }),
    });

    await messagePromise;

    ws.send(JSON.stringify({
      type: "command-result",
      id: requestId,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      at: new Date().toISOString(),
    }));

    await waitFor(async () => {
      const alarm = await runInDurableObject(
        stub,
        async (_instance, state) => await state.storage.getAlarm(),
      );
      expect(alarm).toBeNull();
    });

    ws.close(1000, "test done");
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
        if (status === "missing") {
          throw new Error("expected outbox row to exist before reconnect");
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

      wsSendCommandResult(second.ws, requestId);

      await waitFor(async () => {
        await runInDurableObject(stub, async (_instance, state) => {
          const outboxCursor = state.storage.sql.exec(
            "SELECT seq FROM outbox WHERE delivery_id = ?",
            deliveryId,
          );
          for (const _ of outboxCursor) {
            throw new Error("expected acked outbox row to be deleted");
          }
          const requestCursor = state.storage.sql.exec(
            "SELECT request_id FROM requests WHERE request_id = ?",
            requestId,
          );
          for (const _ of requestCursor) {
            throw new Error("expected terminal request row to be deleted");
          }
        });
      });

      second.ws.close(1000, "test done");
    },
    15_000,
  );
});

function wsSendCommandResult(ws: WebSocket, requestId: string): void {
  ws.send(JSON.stringify({
    type: "command-result",
    id: requestId,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    at: new Date().toISOString(),
  }));
}
