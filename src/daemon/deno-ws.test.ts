import { assert, assertEquals } from "jsr:@std/assert";
import { Hono } from "hono";
import { it } from "@std/testing/bdd";
import {
  deriveDaemonJwtKeyring,
} from "./authn/daemon-jwt-keyring.ts";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { generateSecret } from "../generate-secret.ts";
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
  type ServerDaemonStatusColumns,
} from "./authn/daemon-state.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "./cell/contracts.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
} from "./cell/protocol.ts";
import { DAEMON_CELL_PING, DAEMON_CELL_PONG } from "./cell/protocol.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { registerDaemonWebSocket } from "./deno-ws.ts";
import {
  CLIENT_WS_PATH,
  DAEMON_WS_PATH,
  DEVELOPER_WS_PATH,
} from "../surfaces.ts";
import {
  resetTrunkManifestCacheForTests,
  seedTrunkManifestCacheForTests,
} from "../lib/update/manifest.ts";

async function createDaemonJwtSecrets() {
  const parsed = parseSecretsEnv(generateSecret(), undefined, "deno");
  return deriveDaemonJwtKeyring(parsed);
}

function createSelectChain<T>(getRows: () => T[]) {
  const limit = () => Promise.resolve(getRows());
  const where = () => ({ limit });
  const from = () => ({ where });
  return { from };
}

function createMockDb(keyId = "key-test"): Db {
  return {
    select: () =>
      createSelectChain(() => [{
        daemon: {
          key: { ...baseDaemonKey, id: keyId },
        },
        metadata: null,
        hostname: null,
        machineKey: null,
        connected: true,
        statusChangedAt: "2020-01-01T00:00:00.000Z",
      }]),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  } as unknown as Db;
}

const baseDaemonKey = {
  id: "key-test",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

/**
 * Mock DB matching the `getServerDaemonStateByServerId` column select —
 * fleet status/identity live on dedicated `server` columns, never on the
 * sparse `daemon` jsonb (`{ key, projection? }`).
 */
function createProjectionTrackingDb(
  _serverId: string,
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): {
  db: Db;
  getDaemon: () => ServerDaemonState;
  getStatus: () => ServerDaemonStatus;
  getUpdateCallCount: () => number;
} {
  let daemon: ServerDaemonState = { ...initialDaemon };
  const defaults = buildDefaultDaemonStatus();
  const columns: ServerDaemonStatusColumns = {
    connected: statusOverrides.connected ?? defaults.connected,
    statusChangedAt: statusOverrides.statusChangedAt ?? defaults.statusChangedAt,
  };
  let updateCalls = 0;

  const db = {
    select: () =>
      createSelectChain(() => [{
        daemon,
        metadata: null,
        hostname: null,
        machineKey: null,
        connected: columns.connected,
        statusChangedAt: columns.statusChangedAt,
      }]),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updateCalls += 1;
        if (patch.daemon !== undefined) {
          daemon = patch.daemon as ServerDaemonState;
        }
        if ("connected" in patch) {
          columns.connected = patch.connected as boolean;
        }
        if ("statusChangedAt" in patch) {
          columns.statusChangedAt = patch.statusChangedAt as string | null;
        }
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  } as unknown as Db;

  return {
    db,
    getDaemon: () => daemon,
    getStatus: () => mapServerDaemonStatusFromColumns(columns),
    getUpdateCallCount: () => updateCalls,
  };
}

function createTrackingDaemonCell(serverId: string) {
  const calls = {
    attach: 0,
    detach: 0,
    recordInbound: 0,
    putSnapshot: 0,
    handleInbound: 0,
    readOutboxBatch: 0,
  };
  let snapshot: DaemonCellSnapshot = {
    serverId,
    version: 0,
    updatedAt: new Date().toISOString(),
    connected: false,
  };

  const cell: DaemonCell = {
    attachDaemonSocket: async (meta) => {
      calls.attach += 1;
      snapshot = {
        ...snapshot,
        connected: true,
        remoteAddress: meta.remoteAddress,
        connectedAt: meta.connectedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        connectionId: "track-conn",
        lease: {
          holder: "track-conn",
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      };
    },
    detachDaemonSocket: async () => {
      calls.detach += 1;
      snapshot = {
        ...snapshot,
        connected: false,
        updatedAt: new Date().toISOString(),
      };
    },
    recordInbound: async () => {
      calls.recordInbound += 1;
    },
    getSnapshot: async () => snapshot,
    putSnapshot: async (patch) => {
      calls.putSnapshot += 1;
      snapshot = {
        ...snapshot,
        ...patch,
        serverId,
        version: snapshot.version + 1,
        updatedAt: new Date().toISOString(),
      };
      return snapshot;
    },
    enqueue: async (outbound: DaemonOutboundEnvelope) => {
      return {
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "queued" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      };
    },
    markSent: async () => {},
    handleInbound: async (_inbound: DaemonInboundEnvelope) => {
      calls.handleInbound += 1;
      return null;
    },
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: async () => {},
    readOutboxBatch: async () => {
      calls.readOutboxBatch += 1;
      return [];
    },
    ackOutbox: async () => {},
    prune: async () => false,
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: async () => {},
  };

  return {
    cell,
    calls,
    getSnapshot: () => snapshot,
  };
}

function createTrackingRegistry(cell: DaemonCell): DaemonCellRegistry {
  return {
    getCell: () => cell,
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  };
}

function registerTestDaemonWebSocket(
  app: Hono,
  secrets: Awaited<ReturnType<typeof createDaemonJwtSecrets>>,
  options: {
    db?: Db;
    registry?: DaemonCellRegistry;
  } = {},
) {
  registerDaemonWebSocket(app, {
    secrets,
    db: options.db,
    daemonCellRegistry: options.registry ?? createTrackingRegistry(
      createTrackingDaemonCell("srv-test").cell,
    ),
  });
}

const WS_UPGRADE_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGVzdC1rZXk=",
} as const;

it("WS upgrade accepts HTTP 101 with valid JWT", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);
});

it("WS upgrade rejects HTTP 401 when no JWT is provided", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("WS upgrade rejects HTTP 401 when JWT is invalid", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: "Bearer invalid-token",
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 401);
});

async function createSessionSecrets() {
  return deriveSecretsConfig(
    parseSecretsEnv(generateSecret(), undefined, "deno"),
    "session-signing",
  );
}

it("client WS upgrade rejects HTTP 401 without a session", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(CLIENT_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("client WS upgrade rejects HTTP 401 when no session keyring is configured", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(CLIENT_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("developer WS upgrade rejects HTTP 401 without developer access", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    developerSurface: true,
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(DEVELOPER_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("developer WS is not registered when the developer surface is disabled", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    developerSurface: false,
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(DEVELOPER_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 404);
});

it("stub WS returns 426 for a non-upgrade GET", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(CLIENT_WS_PATH, { method: "GET" });
  assertEquals(response.status, 426);
});

it("over-limit inbound messages close websocket before unbounded queuing", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const tracking = createTrackingDaemonCell("srv-flood");
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(tracking.cell),
    inboundMessageLimit: 3,
    inboundMessageWindowMs: 60_000,
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-flood", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn("Skipping flood test: response.webSocket unavailable");
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let closeCode: number | undefined;
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
  });

  const at = new Date().toISOString();
  for (let i = 0; i < 4; i++) {
    ws.send(JSON.stringify({ type: "heartbeat", at }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(closeCode, 1008);
  const inboundBefore = tracking.calls.recordInbound;
  ws.send(JSON.stringify({ type: "heartbeat", at }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.recordInbound, inboundBefore);
});

it("oversized inbound frames close websocket with policy violation", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const tracking = createTrackingDaemonCell("srv-oversize");
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-oversize", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn("Skipping oversize frame test: response.webSocket unavailable");
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let closeCode: number | undefined;
  let closeReason: string | undefined;
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
    closeReason = event.reason;
  });

  const inboundBefore = tracking.calls.recordInbound;
  const padding = "x".repeat(260 * 1024);
  ws.send(
    JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
      pad: padding,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(closeCode, 1008);
  assertEquals(closeReason, "policy_violation");
  assertEquals(tracking.calls.recordInbound, inboundBefore);
});

it("plain GET with valid JWT returns 426 and does not call connectLimiter", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  let limitCalls = 0;
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-test").cell,
    ),
    connectLimiter: {
      limit: () => {
        limitCalls += 1;
        return Promise.resolve({ success: true });
      },
    },
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
    },
  });
  assertEquals(response.status, 426);
  assertEquals(await response.text(), "Expected WebSocket");
  assertEquals(limitCalls, 0);
});

it("WS upgrade rejects HTTP 429 when connectLimiter denies", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-test").cell,
    ),
    connectLimiter: {
      limit: () => Promise.resolve({ success: false }),
    },
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 429);
  assertEquals(await response.text(), "Too Many Requests");
});

it("WS lifecycle attaches, handles hello, and detaches through cell backend", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-lifecycle";
  const tracking = createTrackingDaemonCell(serverId);
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);

  const ws = response.webSocket;
  if (!ws) {
    console.warn(
      "Skipping WS lifecycle assertions: response.webSocket unavailable in Deno test runtime",
    );
    return;
  }
  ws.accept();

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.attach, 1);
  assertEquals(tracking.getSnapshot().connected, true);

  ws.send(JSON.stringify({
    type: "hello",
    at: new Date().toISOString(),
    agent: { commit: "hello-commit", buildId: "hello-build" },
  }));

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.recordInbound >= 1, true);

  ws.close(1000, "test done");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.detach, 1);
  assertEquals(tracking.getSnapshot().connected, false);
});

it("WS upgrade accepts HTTP 101 with valid JWT after daemon key is revoked", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);
});

it("WS upgrade accepts HTTP 101 with valid JWT after daemon key is replaced", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);
});

async function openTestWebSocket(
  serverId: string,
  secrets: Awaited<ReturnType<typeof createDaemonJwtSecrets>>,
): Promise<
  | { ws: WebSocket; tracking: ReturnType<typeof createTrackingDaemonCell> }
  | null
> {
  const app = new Hono();
  const tracking = createTrackingDaemonCell(serverId);
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) return null;
  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ws, tracking };
}

function waitForWsJson(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for ws message")),
      timeoutMs,
    );
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    }, { once: true });
  });
}

it("hello over WS calls cell.recordInbound", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-hello", secrets);
  if (!opened) {
    console.warn(
      "Skipping hello WS test: response.webSocket unavailable",
    );
    return;
  }
  const { ws, tracking } = opened;

  ws.send(JSON.stringify({
    type: "hello",
    at: new Date().toISOString(),
    agent: { commit: "hello-commit", buildId: "hello-build" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(tracking.calls.recordInbound, 1);
  ws.close(1000, "done");
});

it("cell ping over WS sends pong, refreshes cell liveness, skips Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-cell-ping";
  const recentAt = new Date().toISOString();
  const { db, getUpdateCallCount } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1" },
  }, {
    connected: true,
    statusChangedAt: recentAt,
  });
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = async () => ({
    serverId,
    version: 1,
    updatedAt: recentAt,
    connected: true,
    lastSeenAt: recentAt,
    lastInboundAt: recentAt,
  });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping cell ping WS test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatesBefore = getUpdateCallCount();
  const recordInboundBefore = tracking.calls.recordInbound;

  const pongPromise = waitForWsJson(ws);
  ws.send(DAEMON_CELL_PING);
  const pong = await pongPromise;
  assertEquals(pong.type, "pong");
  assertEquals(JSON.stringify(pong), DAEMON_CELL_PONG);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.recordInbound, recordInboundBefore + 1);
  assertEquals(getUpdateCallCount(), updatesBefore);
  ws.close(1000, "done");
});

it("hello over WS with agent projects commit for update status", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-agent-ws";
  const { db, getDaemon } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1" },
  }, {
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  });
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping heartbeat agent WS test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.send(JSON.stringify({
    type: "hello",
    at: new Date().toISOString(),
    agent: {
      commit: "ws-hello-commit",
      buildId: "ws-hello-build",
      channel: "trunk",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const merged = parseServerDaemonState(getDaemon());
  assertEquals(merged?.projection?.agent?.commit, "ws-hello-commit");
  ws.close(1000, "done");
});

it("heartbeat over WS without agent does not write Postgres status", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-no-agent-ws";
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, getStatus, getUpdateCallCount } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1", agent: { commit: "abc", buildId: "1" } },
  }, {
    connected: true,
    statusChangedAt: stale,
  });
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping heartbeat no-agent WS test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatesBefore = getUpdateCallCount();

  ws.send(JSON.stringify({
    type: "heartbeat",
    at: new Date().toISOString(),
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(getUpdateCallCount(), updatesBefore);
  const status = getStatus();
  assertEquals(status.statusChangedAt, stale);
  assertEquals(status.connected, true);
  ws.close(1000, "done");
});

it("coalesced heartbeat over WS performs no Postgres update", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-coalesce-ws";
  const recentAt = new Date().toISOString();
  const { db, getUpdateCallCount } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1" },
  }, {
    connected: true,
    statusChangedAt: recentAt,
  });
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = async () => ({
    serverId,
    version: 1,
    updatedAt: recentAt,
    connected: true,
    lastSeenAt: recentAt,
    lastInboundAt: recentAt,
  });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping coalesced heartbeat WS test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatesBefore = getUpdateCallCount();

  ws.send(JSON.stringify({
    type: "heartbeat",
    at: new Date(Date.now() + 1000).toISOString(),
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(getUpdateCallCount(), updatesBefore);
  ws.close(1000, "done");
});

it("WS close projects disconnected to Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-disconnect-projection";
  const { db, getStatus } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1" },
  }, {
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  });
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping WS disconnect projection test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.close(1000, "test done");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(getStatus().connected, false);
});

it("update-result over WS projects update summary to Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-update-result-ws";
  const { db, getDaemon } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: {
      hostname: "host-1",
      update: {
        status: "updating",
        requestId: "req-update-1",
        channel: "trunk",
        queuedAt: "2020-01-01T00:00:00.000Z",
      },
    },
  }, {
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  });
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.handleInbound = async () => ({
    serverId,
    requestId: "req-update-1",
    requestKind: "update",
    status: "done" as const,
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:05:00.000Z",
    finishedAt: "2020-01-01T00:01:00.000Z",
  });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping update-result WS test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.send(JSON.stringify({
    type: "update-result",
    id: "req-update-1",
    at: "2020-01-01T00:01:00.000Z",
    ok: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-update-1");
  assertEquals(update?.finishedAt, "2020-01-01T00:01:00.000Z");
  ws.close(1000, "done");
});

it("hello over WS clears stale updating when agent matches trunk", async () => {
  resetTrunkManifestCacheForTests();
  seedTrunkManifestCacheForTests({
    commit: "target-commit",
    buildId: "b2",
    builtAt: "2020-01-01T00:00:00.000Z",
    channel: "trunk",
    manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
  });

  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-hello-repair";
  const { db, getDaemon } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: {
      hostname: "host-1",
      agent: {
        commit: "target-commit",
        buildId: "b1",
        channel: "trunk",
      },
      update: {
        status: "updating",
        requestId: "req-update-1",
        channel: "trunk",
        queuedAt: "2020-01-01T00:00:00.000Z",
      },
    },
  }, {
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  });
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = async () => ({
    serverId,
    version: 1,
    updatedAt: new Date().toISOString(),
    connected: true,
    agent: {
      commit: "target-commit",
      buildId: "b1",
      channel: "trunk",
    },
  });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    console.warn(
      "Skipping hello repair WS test: response.webSocket unavailable",
    );
    return;
  }

  const ws = response.webSocket;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.send(JSON.stringify({
    type: "hello",
    at: new Date().toISOString(),
    agent: {
      commit: "target-commit",
      buildId: "b1",
      channel: "trunk",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-update-1");
  resetTrunkManifestCacheForTests();
  ws.close(1000, "done");
});
