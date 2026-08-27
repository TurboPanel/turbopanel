import { assertEquals } from "@std/assert";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
} from "../daemon/cell/contracts.ts";
import type { Db } from "../db.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../test-fixtures/secrets.ts";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { DEVELOPER_API_PREFIX } from "../surfaces.ts";
import {
  COLOCATED_DEV_SYNC_SKIPPED_REASON,
  type DevSyncPackager,
  INSTANCE_NO_DAEMON_CHECKOUT_REASON,
  isManagedDaemonDevSyncRefusal,
  MANAGED_DAEMON_DEV_SYNC_MARKER,
  MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON,
  registerDevSyncRoutes,
} from "./dev-sync.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_ID = "00000000-0000-4000-8000-0000000000d1";

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => promise,
    orderBy: () => chain,
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  };
  return chain;
}

function createDb(projectionRows: unknown[] = []): Db {
  return {
    select: (fields?: Record<string, unknown>) => {
      const keys = fields ? Object.keys(fields) : [];
      const isProjection = keys.includes("daemon") &&
        keys.includes("connected");
      return thenable(isProjection ? projectionRows : []);
    },
  } as unknown as Db;
}

function directProjectionRow() {
  return {
    id: SERVER_ID,
    daemon: {
      key: {
        id: "key-1",
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { remoteAddress: "__direct__" },
    },
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  };
}

function createRegistry(opts: {
  onlineIds?: string[];
  connected?: boolean;
  syncError?: string | unknown;
  waitRecord?: { status: string; error?: string } | null;
} = {}): DaemonCellRegistry {
  const cell = {
    enqueue: () => Promise.resolve({}),
    waitForRequest: () =>
      Promise.resolve(opts.waitRecord === undefined ? { status: "done" } : opts.waitRecord),
  } as unknown as DaemonCell;

  return {
    getCell: () => {
      if (opts.syncError !== undefined) {
        return {
          enqueue: () => Promise.reject(opts.syncError),
          waitForRequest: () => Promise.resolve(null),
        } as unknown as DaemonCell;
      }
      return cell;
    },
    listOnlineServerIds: () => Promise.resolve(opts.onlineIds ?? [SERVER_ID]),
    getSnapshots: () =>
      Promise.resolve(
        new Map([
          [
            SERVER_ID,
            {
              serverId: SERVER_ID,
              version: 1,
              updatedAt: "2020-01-01T00:00:00.000Z",
              connected: opts.connected ?? true,
            },
          ],
        ]),
      ),
    purge: () => Promise.resolve(),
  };
}

function stubPackager(
  overrides: Partial<DevSyncPackager> = {},
): DevSyncPackager {
  return {
    resolveRepo: () => "fake-daemon-checkout",
    hasCheckout: () => Promise.resolve(true),
    buildTarball: () => Promise.resolve(new Uint8Array([0x1f, 0x8b])),
    ...overrides,
  };
}

async function createApp(opts: {
  db?: Db | null;
  registry?: DaemonCellRegistry | null;
  packager?: DevSyncPackager;
} = {}) {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, "deno"),
    "session-signing",
  );
  const app = new Hono();
  app.use("*", async (c, next) => {
    const vars = c as unknown as Context<AppEnv>;
    if (opts.db !== null) vars.set("db", opts.db ?? createDb());
    if (opts.registry !== null) {
      vars.set("daemonCellRegistry", opts.registry ?? createRegistry());
    }
    await next();
  });
  registerDevSyncRoutes(app, {
    secrets,
    authRequired: false,
    ...(opts.packager ? { packager: opts.packager } : {}),
  });
  return app;
}

test("isManagedDaemonDevSyncRefusal matches the daemon marker only", () => {
  assertEquals(
    isManagedDaemonDevSyncRefusal(`failed: ${MANAGED_DAEMON_DEV_SYNC_MARKER}`),
    true,
  );
  assertEquals(isManagedDaemonDevSyncRefusal("daemon not connected"), false);
});

test("POST /daemon/:id/sync-dev skips colocated and reports 503 without registry", async () => {
  const noRegistry = await createApp({ registry: null });
  const missing = await noRegistry.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(missing.status, 503);

  const app = await createApp({
    db: createDb([directProjectionRow()]),
    registry: createRegistry(),
  });
  const skipped = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(skipped.status, 422);
  const body = await skipped.json() as { error: string };
  assertEquals(body.error, COLOCATED_DEV_SYNC_SKIPPED_REASON);
});

test("POST /daemon/:id/sync-dev reports no instance checkout as unavailable", async () => {
  const app = await createApp({
    packager: stubPackager({ hasCheckout: () => Promise.resolve(false) }),
    registry: createRegistry(),
  });
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(response.status, 500);
  const body = await response.json() as { error: string };
  assertEquals(body.error, INSTANCE_NO_DAEMON_CHECKOUT_REASON);
});

test("POST /daemon/:id/sync-dev classifies managed refusal as skipped", async () => {
  const app = await createApp({
    packager: stubPackager(),
    registry: createRegistry({
      syncError: `apply failed: ${MANAGED_DAEMON_DEV_SYNC_MARKER}`,
    }),
  });
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(response.status, 200);
  const body = await response.json() as { skipped?: boolean; error?: string };
  assertEquals(body.skipped, true);
  assertEquals(body.error, MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON);
});

test("POST /daemon/:id/sync-dev maps disconnected to 404", async () => {
  const app = await createApp({
    registry: createRegistry({ connected: false }),
  });
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(response.status, 404);
});

test("POST /daemon/:id/sync-dev reports 503 without a database", async () => {
  const app = await createApp({ db: null, registry: createRegistry() });
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { ok: false, error: "Database unavailable" });
});

test("POST /daemon/:id/sync-dev succeeds when the packager and cell ack", async () => {
  const app = await createApp({
    packager: stubPackager(),
    registry: createRegistry(),
  });
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, daemonId: SERVER_ID });
});

test("POST /daemon/:id/sync-dev maps a wait timeout and unexpected status", async () => {
  const timedOut = await (await createApp({
    packager: stubPackager(),
    registry: createRegistry({ waitRecord: null }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`, {
    method: "POST",
  });
  assertEquals(timedOut.status, 500);
  assertEquals(await timedOut.json(), {
    ok: false,
    error: "timeout waiting for daemon acknowledgement",
  });

  const expired = await (await createApp({
    packager: stubPackager(),
    registry: createRegistry({ waitRecord: { status: "expired" } }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`, {
    method: "POST",
  });
  assertEquals(expired.status, 500);
  assertEquals(await expired.json(), {
    ok: false,
    error: "timeout waiting for daemon acknowledgement",
  });

  const unexpected = await (await createApp({
    packager: stubPackager(),
    registry: createRegistry({ waitRecord: { status: "pending" } }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`, {
    method: "POST",
  });
  assertEquals(unexpected.status, 500);
  assertEquals(await unexpected.json(), {
    ok: false,
    error: "unexpected dev-sync status: pending",
  });
});

test("POST /daemon/:id/sync-dev maps a failed wait and a non-Error throw", async () => {
  const failed = await (await createApp({
    packager: stubPackager(),
    registry: createRegistry({ waitRecord: { status: "failed" } }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`, {
    method: "POST",
  });
  assertEquals(failed.status, 500);
  assertEquals(await failed.json(), {
    ok: false,
    error: "daemon reported failure",
  });

  const failedWithError = await (await createApp({
    packager: stubPackager(),
    registry: createRegistry({
      waitRecord: { status: "failed", error: "unpack blew up" },
    }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`, {
    method: "POST",
  });
  assertEquals(failedWithError.status, 500);
  assertEquals(await failedWithError.json(), {
    ok: false,
    error: "unpack blew up",
  });

  const thrown = await (await createApp({
    packager: stubPackager(),
    registry: createRegistry({ syncError: "string-fail" }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`, {
    method: "POST",
  });
  assertEquals(thrown.status, 500);
  assertEquals(await thrown.json(), { ok: false, error: "string-fail" });
});

test("POST /daemon/sync-dev skips colocated members of the fleet", async () => {
  const noRegistry = await createApp({ registry: null });
  const missing = await noRegistry.request(
    `${DEVELOPER_API_PREFIX}/daemon/sync-dev`,
    { method: "POST" },
  );
  assertEquals(missing.status, 503);

  const app = await createApp({
    db: createDb([directProjectionRow()]),
    registry: createRegistry({ onlineIds: [SERVER_ID] }),
  });
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/sync-dev`,
    {
      method: "POST",
    },
  );
  assertEquals(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    results: Array<{ skipped?: boolean; error?: string }>;
  };
  assertEquals(body.ok, true);
  assertEquals(body.results[0]?.skipped, true);
  assertEquals(body.results[0]?.error, COLOCATED_DEV_SYNC_SKIPPED_REASON);
});

test("POST /daemon/sync-dev reports 503 without a database", async () => {
  const app = await createApp({ db: null, registry: createRegistry() });
  const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, {
    method: "POST",
  });
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { ok: false, error: "Database unavailable" });
});

test("registerDevSyncRoutes requires developer auth by default", async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, "deno"),
    "session-signing",
  )
  const app = new Hono()
  registerDevSyncRoutes(app, { secrets })
  const fleet = await app.request(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, {
    method: "POST",
  })
  const one = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  )
  assertEquals(fleet.status, 401)
  assertEquals(one.status, 401)
})

test("POST /daemon/:id/sync-dev streams a multi-chunk tarball", async () => {
  const app = await createApp({
    packager: stubPackager({
      buildTarball: () => Promise.resolve(new Uint8Array(200 * 1024)),
    }),
    registry: createRegistry(),
  })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: "POST" },
  )
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { ok: true, daemonId: SERVER_ID })
})

test("POST /daemon/sync-dev fans out success, managed skip, and failure", async () => {
  const remoteB = "00000000-0000-4000-8000-0000000000b1";
  const remoteC = "00000000-0000-4000-8000-0000000000c1";

  const successApp = await createApp({
    packager: stubPackager(),
    registry: createRegistry({ onlineIds: [SERVER_ID] }),
  });
  const success = await successApp.request(
    `${DEVELOPER_API_PREFIX}/daemon/sync-dev`,
    { method: "POST" },
  );
  assertEquals(success.status, 200);
  assertEquals(await success.json(), {
    ok: true,
    results: [{ daemonId: SERVER_ID, ok: true }],
  });

  const mixedRegistry: DaemonCellRegistry = {
    getCell: (id: string) => {
      if (id === remoteB) {
        return {
          enqueue: () =>
            Promise.reject(new Error(`apply failed: ${MANAGED_DAEMON_DEV_SYNC_MARKER}`)),
          waitForRequest: () => Promise.resolve(null),
        } as unknown as DaemonCell;
      }
      return {
        enqueue: () => Promise.reject(new Error("daemon not connected")),
        waitForRequest: () => Promise.resolve(null),
      } as unknown as DaemonCell;
    },
    listOnlineServerIds: () => Promise.resolve([remoteB, remoteC]),
    getSnapshots: (ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.map((serverId) => [
            serverId,
            {
              serverId,
              version: 1,
              updatedAt: "2020-01-01T00:00:00.000Z",
              connected: true,
            },
          ]),
        ),
      ),
    purge: () => Promise.resolve(),
  };
  const mixed = await (await createApp({
    packager: stubPackager(),
    registry: mixedRegistry,
  })).request(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, { method: "POST" });
  assertEquals(mixed.status, 200);
  const mixedBody = await mixed.json() as {
    ok: boolean;
    results: Array<{ daemonId: string; ok: boolean; skipped?: boolean; error?: string }>;
  };
  assertEquals(mixedBody.ok, false);
  const byId = Object.fromEntries(mixedBody.results.map((row) => [row.daemonId, row]));
  assertEquals(byId[remoteB]?.skipped, true);
  assertEquals(byId[remoteB]?.error, MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON);
  assertEquals(byId[remoteC], { daemonId: remoteC, ok: false, error: "daemon not connected" });
});
