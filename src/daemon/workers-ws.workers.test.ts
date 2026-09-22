/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { parseSecretsEnv } from "../lib/secrets/secrets.ts";
import type { Db } from "../db/connection.ts";
import type { AppEnv } from "../app/app.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  buildWorkersDaemonCellForwardHeaders,
  registerWorkersDaemonWebSocket,
} from "./workers-ws.ts";
import { DAEMON_WS_PATH } from "../app/surfaces.ts";

const CELL_SERVER_ID_HEADER = "X-Turbopanel-Cell-Server-Id";
const CELL_GEO_HEADER = "X-Turbopanel-Cell-Geo";
const REAL_IP_HEADER = "X-Real-IP";

const TEST_SECRET = "aa_workers_ws_forward_test_secret_value_b_pad_abcdefghij0";

async function createTestSecrets() {
  return await deriveDaemonJwtKeyring(
    parseSecretsEnv(`1:${TEST_SECRET}`, "workers"),
  );
}

const TEST_KEY_ID = "11111111-2222-4333-8444-555555555555";

/**
 * One row of the `server` ⋈ `key` join `getServerDaemonStateByServerId`
 * reads. The upgrade path checks the key on every connect, so every test that
 * expects to reach the cell needs an active one.
 */
function activeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    daemon: null,
    metadata: null,
    hostname: "host.example",
    machineKey: "machine-1",
    connected: false,
    statusChangedAt: null,
    id: TEST_KEY_ID,
    algorithm: "Ed25519",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
    fingerprint: "fp-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

/**
 * The two reads the upgrade path makes are told apart by `innerJoin`: the
 * daemon-key check joins `key`, the location hint does not.
 */
function createMockDb(
  opts: {
    locationHint?: string;
    keyRow?: Record<string, unknown> | null;
  } = {},
): Db {
  const keyRows = opts.keyRow === null ? [] : [opts.keyRow ?? activeKeyRow()];
  const locationRows = opts.locationHint === undefined ? [] : [
    { options: { cellLocationHint: opts.locationHint }, metadata: null },
  ];
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve(keyRows) }),
        }),
        where: () => ({ limit: () => Promise.resolve(locationRows) }),
      }),
    }),
  } as unknown as Db;
}

async function issueTestToken(
  serverId: string,
  keyId: string = TEST_KEY_ID,
): Promise<string> {
  const secrets = await createTestSecrets();
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: keyId },
    secrets,
  );
  return issued.token;
}

function createForwardCaptureEnv(): {
  env: CloudflareBindings;
  getForwardedRequest: () => Request | undefined;
  getByNameArg: () => string | undefined;
  getByNameOptions: () => { locationHint?: string } | undefined;
} {
  let forwardedRequest: Request | undefined;
  let byNameArg: string | undefined;
  let byNameOptions: { locationHint?: string } | undefined;

  const env = {
    DAEMON_CELL: {
      getByName: (name: string, options?: { locationHint?: string }) => {
        byNameArg = name;
        byNameOptions = options;
        return {
          fetch: (request: Request) => {
            forwardedRequest = request;
            return new Response("forwarded", { status: 200 });
          },
        };
      },
    },
  } as unknown as CloudflareBindings;

  return {
    env,
    getForwardedRequest: () => forwardedRequest,
    getByNameArg: () => byNameArg,
    getByNameOptions: () => byNameOptions,
  };
}

function createLocationHintDb(locationHint: string): Db {
  return createMockDb({ locationHint });
}

function createWorkersWsAppWithDb(
  secrets: Awaited<ReturnType<typeof createTestSecrets>>,
  db: Db,
) {
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets });
  return app;
}

function createWorkersWsApp(secrets: Awaited<ReturnType<typeof createTestSecrets>>) {
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", createMockDb());
    await next();
  });
  registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets });
  return app;
}

function createWorkersWsAppWithLimiter(
  secrets: Awaited<ReturnType<typeof createTestSecrets>>,
  connectLimiter: { limit: (args: { key: string }) => Promise<{ success: boolean }> },
) {
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", createMockDb());
    await next();
  });
  registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets, connectLimiter });
  return app;
}

describe("buildWorkersDaemonCellForwardHeaders", () => {
  it("applies trusted Cloudflare geo and CF-Connecting-IP instead of client values", () => {
    const serverId = "test-srv-ws-forward-trusted";
    const forgedGeo = JSON.stringify({
      country: "ZZ",
      city: "Forged City",
    });
    const trustedIp = "203.0.113.44";

    const headers = buildWorkersDaemonCellForwardHeaders(
      new Headers({
        [CELL_GEO_HEADER]: forgedGeo,
        [REAL_IP_HEADER]: "198.51.100.1",
        [CELL_SERVER_ID_HEADER]: "attacker-server",
      }),
      {
        serverId,
        cf: {
          country: "US",
          city: "Austin",
          region: "Texas",
          colo: "DFW",
        },
        cfConnectingIp: trustedIp,
      },
    );

    expect(headers.get(CELL_SERVER_ID_HEADER)).toBe(serverId);
    const forwardedGeo = headers.get(CELL_GEO_HEADER);
    expect(forwardedGeo).not.toBeNull();
    expect(forwardedGeo).not.toBe(forgedGeo);
    expect(JSON.parse(forwardedGeo!)).toMatchObject({
      country: "US",
      city: "Austin",
      region: "Texas",
      datacenter: "DFW",
    });
    expect(headers.get(REAL_IP_HEADER)).toBe(trustedIp);
  });
});

describe("registerWorkersDaemonWebSocket forwarding", () => {
  it("strips client-supplied geo and IP headers before forwarding to the Durable Object", async () => {
    const serverId = "test-srv-ws-forward-strip";
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const token = await issueTestToken(serverId);
    const { env, getForwardedRequest, getByNameArg } = createForwardCaptureEnv();

    const forgedGeo = JSON.stringify({
      country: "ZZ",
      city: "Forged City",
    });

    const request = new Request(`https://instance.test${DAEMON_WS_PATH}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${token}`,
        [CELL_SERVER_ID_HEADER]: "attacker-server",
        [CELL_GEO_HEADER]: forgedGeo,
        [REAL_IP_HEADER]: "198.51.100.1",
      },
    });

    await app.fetch(request, env);

    const forwarded = getForwardedRequest();
    expect(forwarded).toBeDefined();
    expect(forwarded!.headers.get(CELL_SERVER_ID_HEADER)).toBe(serverId);
    expect(forwarded!.headers.get(CELL_GEO_HEADER)).toBeNull();
    expect(forwarded!.headers.get(REAL_IP_HEADER)).toBeNull();
    expect(getByNameArg()).toBe(serverId);
  });

  it("returns 429 and never wakes the cell when connectLimiter denies", async () => {
    const serverId = "test-srv-ws-rate-limited";
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithLimiter(secrets, {
      limit: () => Promise.resolve({ success: false }),
    });
    const token = await issueTestToken(serverId);
    const { env, getForwardedRequest, getByNameArg } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(getForwardedRequest()).toBeUndefined();
    expect(getByNameArg()).toBeUndefined();
  });

  it("returns 426 when Upgrade is not websocket", async () => {
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`),
      env,
    );

    expect(response.status).toBe(426);
  });

  it("returns 401 when Authorization is missing", async () => {
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when the daemon JWT is invalid", async () => {
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer not-a-valid-jwt",
        },
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns 503 when the request db is unavailable", async () => {
    const secrets = await createTestSecrets();
    const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
    registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets });
    const token = await issueTestToken("test-srv-ws-no-db");
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(503);
  });

  it("forwards to the cell when connectLimiter allows", async () => {
    const serverId = "test-srv-ws-rate-allowed";
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithLimiter(secrets, {
      limit: () => Promise.resolve({ success: true }),
    });
    const token = await issueTestToken(serverId);
    const { env, getForwardedRequest, getByNameArg } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(getForwardedRequest()).toBeDefined();
    expect(getByNameArg()).toBe(serverId);
  });

  it("passes a cell location hint on the first getByName call", async () => {
    const serverId = "test-srv-ws-location-hint";
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithDb(secrets, createLocationHintDb("wnam"));
    const token = await issueTestToken(serverId);
    const { env, getByNameArg, getByNameOptions } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(getByNameArg()).toBe(serverId);
    expect(getByNameOptions()).toEqual({ locationHint: "wnam" });
  });
});

describe("registerWorkersDaemonWebSocket key revocation", () => {
  // A valid JWT is not enough. It lives 15 minutes and says nothing about
  // whether the key that minted it is still active, so before this check an
  // operator who revoked a compromised host's daemon key and purged its cell
  // watched that host reconnect with its cached token and keep receiving
  // queued commands and secrets until the token expired. The self-hosted
  // socket re-checks on every inbound frame; hosted checked nothing.
  const serverId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  async function connectWith(db: Db): Promise<Response> {
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithDb(secrets, db);
    const token = await issueTestToken(serverId);
    return await app.request(
      DAEMON_WS_PATH,
      {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      },
      createForwardCaptureEnv().env,
    );
  }

  it("refuses a revoked key even with a still-valid JWT", async () => {
    const response = await connectWith(
      createMockDb({ keyRow: activeKeyRow({ revokedAt: "2026-01-02T00:00:00.000Z" }) }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a JWT minted by a key that is no longer the server's current one", async () => {
    // Re-enrolment mints a new key row; a token from the superseded key must
    // not open a socket.
    const response = await connectWith(
      createMockDb({ keyRow: activeKeyRow({ id: "99999999-8888-4777-8666-555555555555" }) }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a server with no key row at all", async () => {
    const response = await connectWith(createMockDb({ keyRow: null }));
    expect(response.status).toBe(403);
  });

  it("allows an active, current key", async () => {
    const response = await connectWith(createMockDb());
    expect(response.status).toBe(200);
  });
});
