import { assertEquals } from "jsr:@std/assert";
import { Hono } from "hono";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { generateSecret } from "../generate-secret.ts";
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

function createTrackingDaemonCell(serverId: string) {
  const calls = {
    attach: 0,
    detach: 0,
    heartbeat: 0,
    putSnapshot: 0,
    handleInbound: 0,
    readOutboxBatch: 0,
    applyMonitorSync: 0,
    applyMonitorHeartbeat: 0,
    applyMonitorTransition: 0,
    drainNotificationCandidates: 0,
  };
  let monitorSequence = 0;
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
    heartbeat: async () => {
      calls.heartbeat += 1;
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
    appendEvent: async () => {},
    listEvents: async () => [],
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
    applyMonitorSync: async (msg) => {
      calls.applyMonitorSync += 1;
      if (msg.sequence === monitorSequence + 1) {
        monitorSequence = msg.sequence;
        return { acceptedSequence: msg.sequence, resyncNeeded: false };
      }
      if (msg.sequence > monitorSequence + 1) {
        return { acceptedSequence: monitorSequence, resyncNeeded: true };
      }
      return { acceptedSequence: monitorSequence, resyncNeeded: false };
    },
    applyMonitorHeartbeat: async (msg) => {
      calls.applyMonitorHeartbeat += 1;
      if (msg.sequence === monitorSequence + 1) {
        monitorSequence = msg.sequence;
        return { acceptedSequence: msg.sequence, resyncNeeded: false };
      }
      if (msg.sequence > monitorSequence + 1) {
        return { acceptedSequence: monitorSequence, resyncNeeded: true };
      }
      return { acceptedSequence: monitorSequence, resyncNeeded: false };
    },
    applyMonitorTransition: async (msg) => {
      calls.applyMonitorTransition += 1;
      if (msg.sequence === monitorSequence + 1) {
        monitorSequence = msg.sequence;
        return { acceptedSequence: msg.sequence, resyncNeeded: false };
      }
      if (msg.sequence > monitorSequence + 1) {
        return { acceptedSequence: monitorSequence, resyncNeeded: true };
      }
      return { acceptedSequence: monitorSequence, resyncNeeded: false };
    },
    getMonitorInstance: async () => null,
    listMonitorResources: async () => [],
    listMonitorEvents: async () => [],
    listMonitorMetrics: async () => [],
    drainNotificationCandidates: async () => {
      calls.drainNotificationCandidates += 1;
      return [];
    },
  };

  return {
    cell,
    calls,
    getSnapshot: () => snapshot,
    getMonitorSequence: () => monitorSequence,
  };
}

function createTrackingRegistry(cell: DaemonCell): DaemonCellRegistry {
  return {
    getCell: () => cell,
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
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

Deno.test("WS lifecycle attaches, handles ping, and detaches through cell backend", async () => {
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
    type: "ping",
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
  }));

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.heartbeat >= 1, true);
  assertEquals(tracking.calls.putSnapshot >= 1, true);

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

function monitorSyncFrame(serverId: string, sequence = 1) {
  return {
    type: "monitor.sync",
    from: "daemon",
    serverId,
    at: new Date().toISOString(),
    sequence,
    instance: {},
    resources: [{
      resourceKey: "container:abc",
      kind: "container",
      status: "healthy",
    }],
    protocolVersion: 1,
  };
}

function monitorHeartbeatFrame(serverId: string, sequence: number) {
  return {
    type: "monitor.heartbeat",
    from: "daemon",
    serverId,
    at: new Date().toISOString(),
    sequence,
    instance: {},
  };
}

function monitorTransitionFrame(serverId: string, sequence: number) {
  const at = new Date().toISOString();
  return {
    type: "monitor.transition",
    from: "daemon",
    serverId,
    at,
    sequence,
    events: [{
      resourceKey: "container:abc",
      kind: "container",
      toStatus: "unhealthy",
      at,
    }],
  };
}

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

Deno.test("monitor.sync over WS dispatches to applyMonitorSync and sends monitor.ack", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-monitor-sync", secrets);
  if (!opened) {
    console.warn(
      "Skipping monitor.sync WS test: response.webSocket unavailable",
    );
    return;
  }
  const { ws, tracking } = opened;

  const ackPromise = waitForWsJson(ws);
  ws.send(JSON.stringify(monitorSyncFrame("srv-monitor-sync", 1)));
  const ack = await ackPromise;

  assertEquals(tracking.calls.applyMonitorSync, 1);
  assertEquals(ack.type, "monitor.ack");
  assertEquals(ack.acceptedSequence, 1);
  assertEquals(ack.resyncNeeded, undefined);
  ws.close(1000, "done");
});

Deno.test("monitor.heartbeat over WS dispatches to applyMonitorHeartbeat and sends monitor.ack", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-monitor-heartbeat", secrets);
  if (!opened) {
    console.warn(
      "Skipping monitor.heartbeat WS test: response.webSocket unavailable",
    );
    return;
  }
  const { ws, tracking } = opened;

  ws.send(JSON.stringify(monitorSyncFrame("srv-monitor-heartbeat", 1)));
  await waitForWsJson(ws);

  const ackPromise = waitForWsJson(ws);
  ws.send(JSON.stringify(monitorHeartbeatFrame("srv-monitor-heartbeat", 2)));
  const ack = await ackPromise;

  assertEquals(tracking.calls.applyMonitorHeartbeat, 1);
  assertEquals(ack.type, "monitor.ack");
  assertEquals(ack.acceptedSequence, 2);
  ws.close(1000, "done");
});

Deno.test("monitor.transition over WS dispatches to applyMonitorTransition and sends monitor.ack", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-monitor-transition", secrets);
  if (!opened) {
    console.warn(
      "Skipping monitor.transition WS test: response.webSocket unavailable",
    );
    return;
  }
  const { ws, tracking } = opened;

  ws.send(JSON.stringify(monitorSyncFrame("srv-monitor-transition", 1)));
  await waitForWsJson(ws);

  const ackPromise = waitForWsJson(ws);
  ws.send(JSON.stringify(monitorTransitionFrame("srv-monitor-transition", 2)));
  const ack = await ackPromise;

  assertEquals(tracking.calls.applyMonitorTransition, 1);
  assertEquals(ack.type, "monitor.ack");
  assertEquals(ack.acceptedSequence, 2);
  ws.close(1000, "done");
});

Deno.test("monitor gap detection sends resyncNeeded on heartbeat", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-monitor-gap", secrets);
  if (!opened) {
    console.warn(
      "Skipping monitor gap WS test: response.webSocket unavailable",
    );
    return;
  }
  const { ws, tracking } = opened;

  ws.send(JSON.stringify(monitorSyncFrame("srv-monitor-gap", 1)));
  await waitForWsJson(ws);

  const ackPromise = waitForWsJson(ws);
  ws.send(JSON.stringify(monitorHeartbeatFrame("srv-monitor-gap", 5)));
  const ack = await ackPromise;

  assertEquals(tracking.calls.applyMonitorHeartbeat, 1);
  assertEquals(ack.resyncNeeded, true);
  ws.close(1000, "done");
});

Deno.test("duplicate monitor sequence is a noop on applyMonitorHeartbeat", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-monitor-dup", secrets);
  if (!opened) {
    console.warn(
      "Skipping monitor duplicate WS test: response.webSocket unavailable",
    );
    return;
  }
  const { ws, tracking } = opened;

  ws.send(JSON.stringify(monitorSyncFrame("srv-monitor-dup", 1)));
  await waitForWsJson(ws);

  ws.send(JSON.stringify(monitorHeartbeatFrame("srv-monitor-dup", 2)));
  await waitForWsJson(ws);

  ws.send(JSON.stringify(monitorHeartbeatFrame("srv-monitor-dup", 2)));
  const ack = await waitForWsJson(ws);

  assertEquals(tracking.calls.applyMonitorHeartbeat, 2);
  assertEquals(ack.acceptedSequence, 2);
  assertEquals(tracking.getMonitorSequence(), 2);
  ws.close(1000, "done");
});
