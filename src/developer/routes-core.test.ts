/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import type { CellDiagnostics, DaemonCell, DaemonCellRegistry } from "../daemon/cell/contracts.ts";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { isDaemonDebugEnabled } from "../logger.ts";
import { DEVELOPER_API_PREFIX } from "../surfaces.ts";
import { buildDeveloperRouter } from "./routes-core.ts";

const TEST_SECRET = "aa_developer_routes_core_test_secret_b";

function createDiagnosticsCell(serverId: string): DaemonCell {
  const diagnostics: CellDiagnostics = {
    backend: "durable-object",
    usesHibernationWebSocket: true,
    constructorCalls: 1,
    wsAccepted: 0,
    wsClosed: 0,
    alarmInvocations: 0,
    heartbeatCount: 0,
    commandDispatchCount: 0,
    cleanupCount: 0,
    fetchByRoute: {},
  };

  const noopAsync = async () => {};
  return {
    attachDaemonSocket: async () => ({
      connectionId: "conn",
      lease: {
        holder: "conn",
        token: "conn",
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: async (patch) => ({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
      ...patch,
    }),
    enqueue: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "queued" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "done" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: async () => [],
    ackOutbox: noopAsync,
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: noopAsync,
    getDiagnostics: async () => diagnostics,
  };
}

function createRegistry(serverId: string): DaemonCellRegistry {
  return {
    getCell: () => createDiagnosticsCell(serverId),
    purge: async () => {},
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
  };
}

function createMockDb() {
  return {
    select: () => ({
      from: () => Promise.resolve([]),
    }),
  };
}

async function createTestApp(env: CloudflareBindings) {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_SECRET, undefined, "workers"),
    "session-signing",
  );
  const developer = buildDeveloperRouter({
    secrets,
    authRequired: false,
  });
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", createMockDb() as AppEnv["Variables"]["db"]);
    c.set("daemonCellRegistry", createRegistry("test-srv-diagnostics-gate"));
    await next();
  });
  app.route(DEVELOPER_API_PREFIX, developer);
  return app;
}

describe("isDaemonDebugEnabled", () => {
  it("returns false for log-level debug alone", () => {
    expect(isDaemonDebugEnabled({ TURBOPANEL_LOG_LEVEL: "debug" } as never)).toBe(false);
  });

  it("returns true only for TURBOPANEL_DAEMON_DEBUG", () => {
    expect(isDaemonDebugEnabled({ TURBOPANEL_DAEMON_DEBUG: "1" })).toBe(true);
    expect(isDaemonDebugEnabled({ TURBOPANEL_DAEMON_DEBUG: "true" })).toBe(true);
    expect(isDaemonDebugEnabled({ TURBOPANEL_DAEMON_DEBUG: "0" })).toBe(false);
  });
});

describe("developer diagnostics routes", () => {
  it("returns 404 for fleet diagnostics when only TURBOPANEL_LOG_LEVEL=debug is set", async () => {
    const app = await createTestApp({
      TURBOPANEL_LOG_LEVEL: "debug",
    } as CloudflareBindings);

    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/diagnostics`,
      {},
      { TURBOPANEL_LOG_LEVEL: "debug" } as CloudflareBindings,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("daemon debug disabled");
  });

  it("enables fleet diagnostics when TURBOPANEL_DAEMON_DEBUG=1", async () => {
    const app = await createTestApp({
      TURBOPANEL_DAEMON_DEBUG: "1",
    } as CloudflareBindings);

    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/diagnostics`,
      {},
      { TURBOPANEL_DAEMON_DEBUG: "1" } as CloudflareBindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; diagnostics: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.diagnostics)).toBe(true);
  });

  it("returns 404 for per-server diagnostics when only log level debug is set", async () => {
    const app = await createTestApp({
      TURBOPANEL_LOG_LEVEL: "debug",
    } as CloudflareBindings);
    const serverId = "test-srv-diagnostics-gate";

    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${serverId}/cell/diagnostics`,
      {},
      { TURBOPANEL_LOG_LEVEL: "debug" } as CloudflareBindings,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("daemon debug disabled");
  });

  it("enables per-server diagnostics when TURBOPANEL_DAEMON_DEBUG=1", async () => {
    const app = await createTestApp({
      TURBOPANEL_DAEMON_DEBUG: "1",
    } as CloudflareBindings);
    const serverId = "test-srv-diagnostics-gate";

    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${serverId}/cell/diagnostics`,
      {},
      { TURBOPANEL_DAEMON_DEBUG: "1" } as CloudflareBindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      diagnostics: { backend: string };
    };
    expect(body.ok).toBe(true);
    expect(body.diagnostics.backend).toBe("durable-object");
  });
});
