/**
 * Route-level behavior of `POST /logs/containers` that needs no live Postgres:
 * JWT-derived identity, org stamping, the dedicated rate limiter, and the
 * fire-and-forget 202 contract.
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import type { Db } from "../db.ts";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { registerDaemonApiRoutes } from "./api-routes.ts";
import type { RateLimiter } from "./rate-limit/contracts.ts";
import type {
  ContainerLogEvent,
  ContainerLogPage,
  ContainerLogStore,
} from "../lib/container-logs/types.ts";

const SERVER_ID = "srv-container-logs";
const KEY_ID = "key-container-logs";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

async function testSecrets() {
  return await deriveDaemonJwtKeyring({
    versioned: [{ version: 1, value: "container_log_route_test_secret_value" }],
  });
}

/**
 * Minimal drizzle-shaped stub: every `select()` consumes the next queued row
 * set, in call order (daemon key state first, then the owning organization).
 */
function createFakeDb(rowSets: unknown[][]): Db {
  const queue = [...rowSets];
  const chain = (rows: unknown[]) => {
    const self = {
      from: () => self,
      innerJoin: () => self,
      leftJoin: () => self,
      where: () => self,
      limit: () => Promise.resolve(rows),
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return self;
  };
  return { select: () => chain(queue.shift() ?? []) } as unknown as Db;
}

/** Row shape `getServerDaemonStateByServerId` expects for an active key. */
function activeDaemonKeyRow(): Record<string, unknown> {
  return {
    daemon: {
      key: {
        id: KEY_ID,
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-container-logs",
        createdAt: new Date().toISOString(),
      },
    },
    metadata: null,
    hostname: "host.example",
    machineKey: null,
    connected: true,
    statusChangedAt: null,
  };
}

type RecordingStore = ContainerLogStore & { ingested: ContainerLogEvent[][] };

function createRecordingStore(
  onIngest?: () => Promise<void>,
): RecordingStore {
  const ingested: ContainerLogEvent[][] = [];
  return {
    ingested,
    async ingest(events: readonly ContainerLogEvent[]): Promise<void> {
      ingested.push([...events]);
      if (onIngest) await onIngest();
    },
    query(): Promise<ContainerLogPage> {
      return Promise.resolve({ events: [], nextCursor: null });
    },
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-08-21T10:00:00.000Z",
    containerId: "c0ffee",
    environmentId: "33333333-3333-4333-8333-333333333333",
    serviceId: "44444444-4444-4444-8444-444444444444",
    stream: "stdout",
    message: "listening on 8080",
    ...overrides,
  };
}

async function postBatch(options: {
  body: unknown;
  orgRows?: unknown[];
  store?: RecordingStore;
  containerLogsLimiter?: RateLimiter;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const store = options.store ?? createRecordingStore();
  const db = createFakeDb([
    [activeDaemonKeyRow()],
    options.orgRows ??
      [{ organizationId: ORG_ID, options: { containerLogsEnabled: true } }],
  ]);

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("containerLogStore", store);
    return next();
  });
  const secrets = await testSecrets();
  registerDaemonApiRoutes(app as unknown as Hono, {
    secrets,
    ...(options.containerLogsLimiter
      ? { containerLogsLimiter: options.containerLogsLimiter }
      : {}),
  });

  const issued = await issueDaemonJwt({ sub: SERVER_ID, kid: KEY_ID }, secrets);
  const response = await app.request("/api/daemon/v1/logs/containers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("POST /logs/containers", () => {
  it("accepts a batch with 202 and ingests it", async () => {
    const store = createRecordingStore();
    const { status, body } = await postBatch({
      body: { events: [event(), event({ stream: "stderr" })] },
      store,
    });
    assertEquals(status, 202);
    assertEquals(body.accepted, 2);
    assertEquals(store.ingested.length, 1);
    assertEquals(store.ingested[0]?.length, 2);
  });

  it("stamps serverId from the JWT sub and org from the server row", async () => {
    const store = createRecordingStore();
    await postBatch({
      body: {
        events: [
          event({
            serverId: "attacker-server",
            organizationId: "attacker-org",
          }),
        ],
      },
      store,
    });
    const ingested = store.ingested[0]?.[0];
    assertEquals(ingested?.serverId, SERVER_ID);
    assertEquals(ingested?.organizationId, ORG_ID);
  });

  it("rejects a malformed batch with 400 and never ingests", async () => {
    const store = createRecordingStore();
    const { status, body } = await postBatch({
      body: { events: [event({ stream: "console" })] },
      store,
    });
    assertEquals(status, 400);
    assertEquals(body.error, "stream must be stdout or stderr");
    assertEquals(store.ingested.length, 0);
  });

  it("rejects a non-JSON body with 400", async () => {
    const secrets = await testSecrets();
    const app = new Hono<AppEnv>();
    app.use("*", (c, next) => {
      c.set("db", createFakeDb([[activeDaemonKeyRow()]]));
      return next();
    });
    registerDaemonApiRoutes(app as unknown as Hono, { secrets });
    const issued = await issueDaemonJwt(
      { sub: SERVER_ID, kid: KEY_ID },
      secrets,
    );
    const response = await app.request("/api/daemon/v1/logs/containers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "Content-Type": "application/json",
      },
      body: "not json",
    });
    assertEquals(response.status, 400);
  });

  it("drops a stale daemon's batch once the org retention switch is off", async () => {
    // A daemon keeps posting until the next presence ack tells it to stop.
    // `organization.options.containerLogsEnabled` is re-read on every write,
    // so those in-flight batches are accepted and dropped, never persisted.
    const store = createRecordingStore();
    const { status, body } = await postBatch({
      body: { events: [event(), event({ stream: "stderr" })] },
      orgRows: [{
        organizationId: ORG_ID,
        options: { containerLogsEnabled: false },
      }],
      store,
    });
    assertEquals(status, 202);
    assertEquals(body.accepted, 0);
    assertEquals(store.ingested.length, 0);
  });

  it("drops a batch when the org has never set the retention switch", async () => {
    const store = createRecordingStore();
    const { status, body } = await postBatch({
      body: { events: [event()] },
      orgRows: [{ organizationId: ORG_ID, options: null }],
      store,
    });
    assertEquals(status, 202);
    assertEquals(body.accepted, 0);
    assertEquals(store.ingested.length, 0);
  });

  it("forbids a server that belongs to no organization", async () => {
    const store = createRecordingStore();
    const { status, body } = await postBatch({
      body: { events: [event()] },
      orgRows: [],
      store,
    });
    assertEquals(status, 403);
    assertEquals(body.error, "forbidden");
    assertEquals(store.ingested.length, 0);
  });

  it("still answers 202 when the store throws — output is disposable", async () => {
    const store = createRecordingStore(() =>
      Promise.reject(new Error("clickhouse down"))
    );
    const { status } = await postBatch({ body: { events: [event()] }, store });
    assertEquals(status, 202);
  });

  it("rejects with 401 without a daemon JWT", async () => {
    const secrets = await testSecrets();
    const app = new Hono<AppEnv>();
    registerDaemonApiRoutes(app as unknown as Hono, { secrets });
    const response = await app.request("/api/daemon/v1/logs/containers", {
      method: "POST",
      body: JSON.stringify({ events: [] }),
    });
    assertEquals(response.status, 401);
  });

  it("uses the dedicated container-log limiter, not the shared REST one", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit(args) {
        keys.push(args.key);
        return Promise.resolve({ success: false });
      },
    };
    const { status, body } = await postBatch({
      body: { events: [event()] },
      containerLogsLimiter: limiter,
    });
    assertEquals(status, 429);
    assertEquals(body.error, "rate_limited");
    assertEquals(keys, [`daemon:container-logs:${SERVER_ID}`]);
  });
});
