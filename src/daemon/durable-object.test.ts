/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  buildDefaultDaemonStatus,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from "./authn/daemon-state.ts";
import {
  DaemonCellObject,
  setDaemonCellProjectionDbFactoryForTests,
} from "./cell/do.ts";
import { generateDeliveryId, generateRequestId, DAEMON_OFFLINE_SWEEP_MS } from "./cell/protocol.ts";

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

function mergeDaemonStatus(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): ServerDaemonState {
  return {
    ...daemon,
    status: {
      ...buildDefaultDaemonStatus(),
      ...(daemon.status ?? {}),
      ...statusOverrides,
    },
  };
}

function createProjectionRecordingDb(
  statusOverrides: Partial<ServerDaemonStatus> = {},
): {
  db: Db;
  updateCalls: Array<Record<string, unknown>>;
  getStatus: () => ServerDaemonStatus;
  setDaemonStatus: (patch: Partial<ServerDaemonStatus>) => void;
} {
  const updateCalls: Array<Record<string, unknown>> = [];
  let daemon = mergeDaemonStatus({
    key: {
      id: "key-1",
      algorithm: "Ed25519",
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
      fingerprint: "fp-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    },
    projection: { hostname: "host-1" },
  }, statusOverrides);

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            daemon,
            metadata: { hostname: "host-1" },
          }]),
        }),
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

  return {
    db,
    updateCalls,
    getStatus: () => daemon.status ?? buildDefaultDaemonStatus(),
    setDaemonStatus: (patch: Partial<ServerDaemonStatus>) => {
      daemon = mergeDaemonStatus(daemon, patch);
    },
  };
}

function statusFromPatch(
  patch: Record<string, unknown> | undefined,
): ServerDaemonStatus | undefined {
  const daemon = patch?.daemon as ServerDaemonState | undefined;
  return daemon?.status;
}

describe("DaemonCellObject", () => {
  beforeEach(() => {
    setDaemonCellProjectionDbFactoryForTests(null);
  });

  afterEach(() => {
    setDaemonCellProjectionDbFactoryForTests(null);
  });
  it("projects connect to Postgres after websocket attach", async () => {
    const serverId = "test-srv-proj-connect";
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
      daemonStatus: "offline",
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    await waitFor(() => {
      const connectedPatch = updateCalls.find((patch) =>
        statusFromPatch(patch)?.connected === true
      );
      expect(connectedPatch).toBeDefined();
      const status = statusFromPatch(connectedPatch);
      expect(status?.connectedAt).toEqual(expect.any(String));
      expect(status?.statusChangedAt).toEqual(expect.any(String));
      expect(status?.lastSeenAt).toEqual(expect.any(String));
    });

    ws.close(1000, "test done");
  });

  it("projects disconnect to Postgres after websocket close", async () => {
    const serverId = "test-srv-proj-disconnect";
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      daemonStatus: "online",
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    await waitFor(() => {
      expect(updateCalls.some((patch) =>
        statusFromPatch(patch)?.connected === true
      )).toBe(true);
    });

    ws.close(1000, "test done");

    await waitFor(() => {
      const disconnectedPatch = updateCalls.find((patch) =>
        statusFromPatch(patch)?.connected === false
      );
      expect(disconnectedPatch).toBeDefined();
      expect(statusFromPatch(disconnectedPatch)?.disconnectedAt).toEqual(
        expect.any(String),
      );
    });
  });

  it("debounces heartbeat projection writes to at most once per 60s", async () => {
    const serverId = "test-srv-proj-heartbeat-debounce";
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    const { db, updateCalls, setDaemonStatus } = createProjectionRecordingDb({
      connected: true,
      daemonStatus: "online",
      connectedAt: staleAt,
      lastSeenAt: staleAt,
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    setDaemonStatus({
      connected: true,
      daemonStatus: "online",
      lastSeenAt: staleAt,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE cell_meta SET last_seen_at = ? WHERE server_id = ?",
        staleAt,
        serverId,
      );
    });

    const countBeforeHeartbeat = updateCalls.length;

    ws.send(JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
    }));

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(countBeforeHeartbeat);
    });

    const countAfterFirstHeartbeat = updateCalls.length;

    ws.send(JSON.stringify({
      type: "heartbeat",
      at: new Date(Date.now() + 1000).toISOString(),
    }));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(updateCalls.length).toBe(countAfterFirstHeartbeat);

    ws.close(1000, "test done");
  }, 10_000);

  it("projects connect to Postgres after websocket attach", async () => {
    const serverId = "test-srv-proj-connect";
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
      daemonStatus: "offline",
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    await waitFor(() => {
      const connectedPatch = updateCalls.find((patch) =>
        statusFromPatch(patch)?.connected === true
      );
      expect(connectedPatch).toBeDefined();
      const status = statusFromPatch(connectedPatch);
      expect(status?.connectedAt).toEqual(expect.any(String));
      expect(status?.statusChangedAt).toEqual(expect.any(String));
      expect(status?.lastSeenAt).toEqual(expect.any(String));
    });

    ws.close(1000, "test done");
  });

  it("projects disconnect to Postgres after websocket close", async () => {
    const serverId = "test-srv-proj-disconnect";
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      daemonStatus: "online",
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    await waitFor(() => {
      expect(updateCalls.some((patch) =>
        statusFromPatch(patch)?.connected === true
      )).toBe(true);
    });

    ws.close(1000, "test done");

    await waitFor(() => {
      const disconnectedPatch = updateCalls.find((patch) =>
        statusFromPatch(patch)?.connected === false
      );
      expect(disconnectedPatch).toBeDefined();
      expect(statusFromPatch(disconnectedPatch)?.disconnectedAt).toEqual(
        expect.any(String),
      );
    });
  });

  it("debounces heartbeat projection writes to at most once per 60s", async () => {
    const serverId = "test-srv-proj-heartbeat-debounce";
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    const { db, updateCalls, setDaemonStatus } = createProjectionRecordingDb({
      connected: true,
      daemonStatus: "online",
      connectedAt: staleAt,
      lastSeenAt: staleAt,
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    setDaemonStatus({
      connected: true,
      daemonStatus: "online",
      lastSeenAt: staleAt,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE cell_meta SET last_seen_at = ? WHERE server_id = ?",
        staleAt,
        serverId,
      );
    });

    const countBeforeHeartbeat = updateCalls.length;

    ws.send(JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
    }));

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(countBeforeHeartbeat);
    });

    const countAfterFirstHeartbeat = updateCalls.length;

    ws.send(JSON.stringify({
      type: "heartbeat",
      at: new Date(Date.now() + 1000).toISOString(),
    }));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(updateCalls.length).toBe(countAfterFirstHeartbeat);

    ws.close(1000, "test done");
  }, 10_000);

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

  it("heartbeat without agent updates last_seen_at on the cell snapshot", async () => {
    const serverId = "test-srv-heartbeat-no-agent";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const connectedResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const connectedSnapshot = await connectedResponse.json() as {
      lastSeenAt?: string;
    };
    expect(connectedSnapshot.lastSeenAt).toBeTruthy();
    const connectedLastSeenMs = Date.parse(connectedSnapshot.lastSeenAt!);

    await new Promise((resolve) => setTimeout(resolve, 25));

    ws.send(JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
    }));

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        lastSeenAt?: string;
      };
      expect(snapshot.lastSeenAt).toBeTruthy();
      const heartbeatLastSeenMs = Date.parse(snapshot.lastSeenAt!);
      expect(heartbeatLastSeenMs).toBeGreaterThanOrEqual(connectedLastSeenMs);
    });

    ws.close(1000, "test done");
  });

  it("heartbeat without agent updates last_seen_at on the cell snapshot", async () => {
    const serverId = "test-srv-heartbeat-no-agent";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const connectedResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const connectedSnapshot = await connectedResponse.json() as {
      lastSeenAt?: string;
    };
    expect(connectedSnapshot.lastSeenAt).toBeTruthy();
    const connectedLastSeenMs = Date.parse(connectedSnapshot.lastSeenAt!);

    await new Promise((resolve) => setTimeout(resolve, 25));

    ws.send(JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
    }));

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as {
        lastSeenAt?: string;
      };
      expect(snapshot.lastSeenAt).toBeTruthy();
      const heartbeatLastSeenMs = Date.parse(snapshot.lastSeenAt!);
      expect(heartbeatLastSeenMs).toBeGreaterThanOrEqual(connectedLastSeenMs);
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

  it("idle websocket attach schedules stale-sweep alarm", async () => {
    const serverId = "test-srv-idle-alarm";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const { alarm, lastSeenAt } = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const scheduled = await state.storage.getAlarm();
        const cursor = state.storage.sql.exec(
          "SELECT last_seen_at FROM cell_meta WHERE server_id = ?",
          serverId,
        );
        let seenAt: string | null = null;
        for (const row of cursor) {
          seenAt = String(row.last_seen_at ?? "");
        }
        return { alarm: scheduled, lastSeenAt: seenAt };
      },
    );
    expect(alarm).not.toBeNull();
    expect(lastSeenAt).toBeTruthy();
    const expectedSweepAt = Date.parse(lastSeenAt!) + DAEMON_OFFLINE_SWEEP_MS;
    expect(alarm).toBeGreaterThanOrEqual(expectedSweepAt - 1000);
    expect(alarm).toBeLessThanOrEqual(expectedSweepAt + 1000);

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

  it("outbox drain retains stale-sweep alarm while socket stays attached", async () => {
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
      expect(alarm).not.toBeNull();
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

  it("snapshot read does not recreate cell_meta for a missing server", async () => {
    const serverId = "test-srv-readonly-missing";
    const stub = env.DAEMON_CELL.getByName(serverId);

    const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const snapshot = await snapshotResponse.json() as { connected: boolean };
    expect(snapshot.connected).toBe(false);

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = state.storage.sql.exec("SELECT server_id FROM cell_meta");
      for (const _ of cursor) {
        throw new Error("expected snapshot read to not create cell_meta");
      }
    });
  });

  it("snapshot read after purge does not recreate cell_meta", async () => {
    const serverId = "test-srv-readonly-purge";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);
    ws.close(1000, "test done");

    const purgeResponse = await cellRpc(stub, serverId, "/rpc/purge-cell", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(purgeResponse.status).toBe(200);

    const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
      method: "GET",
    });
    const snapshot = await snapshotResponse.json() as { connected: boolean };
    expect(snapshot.connected).toBe(false);

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = state.storage.sql.exec("SELECT server_id FROM cell_meta");
      for (const _ of cursor) {
        throw new Error("expected snapshot read to not recreate cell_meta");
      }
    });
  });

  it("alarm sweeps stale connected cells based on last_seen_at", async () => {
    const serverId = "test-srv-alarm-stale";
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      daemonStatus: "online",
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    setDaemonCellProjectionDbFactoryForTests(() => db);

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
      const snapshot = await snapshotResponse.json() as { connected: boolean };
      expect(snapshot.connected).toBe(true);
    });

    const staleLastSeen = new Date(
      Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000,
    ).toISOString();

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      state.storage.sql.exec(
        "UPDATE cell_meta SET last_seen_at = ? WHERE server_id = ?",
        staleLastSeen,
        serverId,
      );
      await instance.alarm();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = state.storage.sql.exec(
        "SELECT connected FROM cell_meta WHERE server_id = ?",
        serverId,
      );
      let connected: number | null = null;
      for (const row of cursor) {
        connected = Number(row.connected);
      }
      expect(connected).toBe(0);
    });

    await waitFor(() => {
      const offlinePatch = updateCalls.find((patch) =>
        statusFromPatch(patch)?.connected === false
      );
      expect(offlinePatch).toBeDefined();
    });

    ws.close(1000, "test done");
  });

  it("hello after stale sweep restores runtime connected flag", async () => {
    const serverId = "test-srv-alarm-stale-recover";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const staleLastSeen = new Date(
      Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000,
    ).toISOString();

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      state.storage.sql.exec(
        "UPDATE cell_meta SET last_seen_at = ? WHERE server_id = ?",
        staleLastSeen,
        serverId,
      );
      await instance.alarm();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = state.storage.sql.exec(
        "SELECT connected FROM cell_meta WHERE server_id = ?",
        serverId,
      );
      for (const row of cursor) {
        expect(Number(row.connected)).toBe(0);
      }
    });

    ws.send(JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      agent: { commit: "recovered", buildId: "1" },
    }));

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as { connected: boolean };
      expect(snapshot.connected).toBe(true);
    });

    ws.close(1000, "test done");
  });

  it("hello after stale sweep restores runtime connected flag", async () => {
    const serverId = "test-srv-alarm-stale-recover";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const { ws } = await openDaemonWebSocket(stub, serverId);

    const staleLastSeen = new Date(
      Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000,
    ).toISOString();

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      state.storage.sql.exec(
        "UPDATE cell_meta SET last_seen_at = ? WHERE server_id = ?",
        staleLastSeen,
        serverId,
      );
      await instance.alarm();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = state.storage.sql.exec(
        "SELECT connected FROM cell_meta WHERE server_id = ?",
        serverId,
      );
      for (const row of cursor) {
        expect(Number(row.connected)).toBe(0);
      }
    });

    ws.send(JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      agent: { commit: "recovered", buildId: "1" },
    }));

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, "/rpc/snapshot", {
        method: "GET",
      });
      const snapshot = await snapshotResponse.json() as { connected: boolean };
      expect(snapshot.connected).toBe(true);
    });

    ws.close(1000, "test done");
  });
});

describe("command-dispatch correlation", () => {
  it("ack is non-terminal then outcome completes over RPC inbound", async () => {
    const serverId = "test-srv-command-dispatch";
    const stub = env.DAEMON_CELL.getByName(serverId);
    const requestId = generateRequestId();
    const deliveryId = generateDeliveryId();
    const ackAt = new Date().toISOString();
    const outcomeAt = new Date(Date.now() + 1000).toISOString();

    await cellRpc(stub, serverId, "/rpc/enqueue", {
      method: "POST",
      body: JSON.stringify({
        outbound: {
          kind: "command-dispatch",
          deliveryId,
          requestId,
          at: ackAt,
          commandId: "cmd-do-1",
          commandType: "ping",
          payload: { target: "host" },
        },
      }),
    });

    const ackResponse = await cellRpc(stub, serverId, "/rpc/inbound", {
      method: "POST",
      body: JSON.stringify({
        inbound: {
          kind: "command-ack",
          requestId,
          at: ackAt,
          daemonReceivedAt: ackAt,
        },
      }),
    });
    const ackBody = await ackResponse.json() as {
      record: {
        status: string;
        ackAt?: string;
        finishedAt?: string;
        daemonReceivedAt?: string;
      } | null;
    };
    expect(ackBody.record?.status).toBe("acked");
    expect(ackBody.record?.ackAt).toBe(ackAt);
    expect(ackBody.record?.daemonReceivedAt).toBe(ackAt);
    expect(ackBody.record?.finishedAt).toBeUndefined();

    const midResponse = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: "GET" },
    );
    const midBody = await midResponse.json() as {
      record: { status: string; daemonReceivedAt?: string } | null;
    };
    expect(midBody.record?.status).toBe("acked");
    expect(midBody.record?.daemonReceivedAt).toBe(ackAt);

    const daemonRespondedAt = new Date(Date.now() + 500).toISOString();
    const outcomeResponse = await cellRpc(stub, serverId, "/rpc/inbound", {
      method: "POST",
      body: JSON.stringify({
        inbound: {
          kind: "command-outcome",
          requestId,
          at: outcomeAt,
          ok: true,
          result: { pong: true },
          daemonReceivedAt: ackAt,
          daemonRespondedAt,
        },
      }),
    });
    const outcomeBody = await outcomeResponse.json() as {
      record: {
        status: string;
        result?: { pong: boolean };
        finishedAt?: string;
        daemonReceivedAt?: string;
        daemonRespondedAt?: string;
      } | null;
    };
    expect(outcomeBody.record?.status).toBe("done");
    expect(outcomeBody.record?.result).toEqual({ pong: true });
    expect(outcomeBody.record?.finishedAt).toBe(outcomeAt);
    expect(outcomeBody.record?.daemonReceivedAt).toBe(ackAt);
    expect(outcomeBody.record?.daemonRespondedAt).toBe(daemonRespondedAt);

    const waitResponse = await cellRpc(stub, serverId, "/rpc/wait-request", {
      method: "POST",
      body: JSON.stringify({ requestId, timeoutMs: 100 }),
    });
    const waitBody = await waitResponse.json() as {
      record: {
        status: string;
        daemonReceivedAt?: string;
        daemonRespondedAt?: string;
      } | null;
    };
    expect(waitBody.record?.status).toBe("done");
    expect(waitBody.record?.daemonReceivedAt).toBe(ackAt);
    expect(waitBody.record?.daemonRespondedAt).toBe(daemonRespondedAt);
  });

  it("delivers command-dispatch over websocket and completes on ack then outcome", async () => {
    const serverId = "test-srv-command-dispatch-ws";
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
          kind: "command-dispatch",
          deliveryId,
          requestId,
          at,
          commandId: "cmd-ws-1",
          commandType: "ping",
          payload: { n: 1 },
        },
      }),
    });

    const raw = await messagePromise;
    const msg = JSON.parse(raw) as {
      type: string;
      id?: string;
      commandId?: string;
      commandType?: string;
      payload?: unknown;
    };
    expect(msg.type).toBe("command-dispatch");
    expect(msg.id).toBe(requestId);
    expect(msg.commandId).toBe("cmd-ws-1");
    expect(msg.commandType).toBe("ping");
    expect(msg.payload).toEqual({ n: 1 });

    ws.send(JSON.stringify({
      type: "command-ack",
      id: requestId,
      at,
      daemonReceivedAt: at,
    }));

    await waitFor(async () => {
      const ackResponse = await cellRpc(
        stub,
        serverId,
        `/rpc/request?requestId=${requestId}`,
        { method: "GET" },
      );
      const ackBody = await ackResponse.json() as {
        record: { status: string } | null;
      };
      expect(ackBody.record?.status).toBe("acked");
    });

    const outcomeAt = new Date().toISOString();
    ws.send(JSON.stringify({
      type: "command-outcome",
      id: requestId,
      at: outcomeAt,
      ok: true,
      result: { pong: true },
    }));

    await waitFor(async () => {
      const doneResponse = await cellRpc(stub, serverId, "/rpc/wait-request", {
        method: "POST",
        body: JSON.stringify({ requestId, timeoutMs: 100 }),
      });
      const doneBody = await doneResponse.json() as {
        record: { status: string; result?: { pong: boolean } } | null;
      };
      expect(doneBody.record?.status).toBe("done");
      expect(doneBody.record?.result).toEqual({ pong: true });
    });

    ws.close(1000, "test done");
  });
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
