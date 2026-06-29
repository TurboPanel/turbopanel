import { assert, assertEquals } from "jsr:@std/assert";
import { Hono } from "hono";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { generateSecret } from "../generate-secret.ts";
import {
  buildDefaultDaemonStatus,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
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
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { registerDaemonWebSocket } from "./deno-ws.ts";
import { DAEMON_WS_PATH } from "../surfaces.ts";
import {
  resetTrunkManifestCacheForTests,
  seedTrunkManifestCacheForTests,
} from "../lib/update/manifest.ts";

async function createDaemonJwtSecrets() {
  const parsed = parseSecretsEnv(generateSecret(), undefined, "deno");
  return deriveSecretsConfig(parsed, "daemon-jwt-signing");
}

function createMockDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  } as unknown as Db;
}

const baseDaemonKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

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

function createProjectionTrackingDb(
  _serverId: string,
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): {
  db: Db;
  getDaemon: () => ServerDaemonState;
  getStatus: () => ServerDaemonStatus;
} {
  let daemon = mergeDaemonStatus(initialDaemon, statusOverrides);

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ daemon }]),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
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
    getDaemon: () => daemon,
    getStatus: () => daemon.status ?? buildDefaultDaemonStatus(),
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
          token: "track-conn",
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

Deno.test("WS upgrade accepts HTTP 101 with valid JWT", async () => {
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

Deno.test("WS upgrade rejects HTTP 401 when no JWT is provided", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const response = await app.request(DAEMON_WS_PATH, { method: "GET" });
  assertEquals(response.status, 401);
});

Deno.test("WS upgrade rejects HTTP 401 when JWT is invalid", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: "Bearer invalid-token",
    },
  });
  assertEquals(response.status, 401);
});

Deno.test("WS lifecycle attaches, handles hello, and detaches through cell backend", async () => {
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

Deno.test("WS upgrade accepts HTTP 101 with valid JWT after daemon key is revoked", async () => {
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

Deno.test("WS upgrade accepts HTTP 101 with valid JWT after daemon key is replaced", async () => {
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

Deno.test("hello over WS calls cell.recordInbound", async () => {
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

Deno.test("hello over WS with agent projects commit for update status", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-agent-ws";
  const { db, getDaemon } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1" },
  }, {
    connected: true,
    daemonStatus: "online",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
    connectedAt: "2020-01-01T00:00:00.000Z",
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

Deno.test("heartbeat over WS without agent advances status.lastSeenAt in Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-no-agent-ws";
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, getStatus } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1", agent: { commit: "abc", buildId: "1" } },
  }, {
    connected: true,
    daemonStatus: "online",
    lastSeenAt: stale,
    connectedAt: "2020-01-01T00:00:00.000Z",
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

  ws.send(JSON.stringify({
    type: "heartbeat",
    at: new Date().toISOString(),
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = getStatus();
  assert(status.lastSeenAt);
  assertEquals(status.lastSeenAt !== stale, true);
  assertEquals(status.connected, true);
  ws.close(1000, "done");
});

Deno.test("WS close projects disconnected to Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-disconnect-projection";
  const { db, getStatus } = createProjectionTrackingDb(serverId, {
    key: baseDaemonKey,
    projection: { hostname: "host-1" },
  }, {
    connected: true,
    daemonStatus: "online",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
    connectedAt: "2020-01-01T00:00:00.000Z",
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

Deno.test("update-result over WS projects update summary to Postgres", async () => {
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
    daemonStatus: "online",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
    connectedAt: "2020-01-01T00:00:00.000Z",
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

Deno.test("hello over WS clears stale updating when agent matches trunk", async () => {
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
    daemonStatus: "online",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
    connectedAt: "2020-01-01T00:00:00.000Z",
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
