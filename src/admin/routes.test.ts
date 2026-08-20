import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { createBrowserWriteProtectionMiddleware } from "../browser-write-protection.ts";
import { getDatabaseUrl } from "../db-url.ts";
import { createDenoDb } from "../db.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
} from "../daemon/cell/contracts.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
  HTTPS_SESSION_COOKIE_NAME,
} from "../client/authn/crypto.ts";
import { createSession } from "../client/authn/session-store.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { server, setting, user } from "../lib/db/schema.ts";
import { eq } from "drizzle-orm";
import { ADMIN_API_PREFIX } from "../surfaces.ts";
import {
  endReencryptSweep,
  resetReencryptSweepLockForTests,
  tryBeginReencryptSweep,
} from "./reencrypt-secrets.ts";
import { registerAdminRoutes } from "./routes.ts";

const dbUrl = getDatabaseUrl();
import { TEST_ONLY_TURBOPANEL_SECRET } from "../test-fixtures/secrets.ts";

type WaitOverride = (
  outbound: { requestId: string; at: string; kind: string },
) => Promise<{
  serverId: string;
  requestId: string;
  requestKind: string;
  status: "done" | "failed" | "expired" | "queued";
  createdAt: string;
  expiresAt: string;
  error?: string;
  result?: unknown;
}>;

function jsonBody<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function createMockCell(
  serverId: string,
  purgedIds: string[],
  failIds: Set<string>,
  waitOverride?: WaitOverride,
): DaemonCell {
  const noopAsync = () => Promise.resolve();
  return {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: "conn",
        lease: {
          holder: "conn",
          token: "conn",
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: () =>
      Promise.resolve({
        serverId,
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "queued" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) => {
      if (waitOverride) return waitOverride(outbound);
      return Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "done" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
        result: {
          ips: [],
        },
      });
    },
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => {
      if (failIds.has(serverId)) {
        return Promise.reject(new Error(`purge failed for ${serverId}`));
      }
      purgedIds.push(serverId);
      return Promise.resolve();
    },
  };
}

function createTrackingRegistry(
  failIds: Set<string> = new Set(),
  opts: Readonly<{
    onlineIds?: string[];
    connectedSnapshots?: boolean;
    waitOverride?: WaitOverride;
  }> = {},
): {
  registry: DaemonCellRegistry;
  purgedIds: string[];
} {
  const purgedIds: string[] = [];
  const cells = new Map<string, DaemonCell>();

  const registry: DaemonCellRegistry = {
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId);
      if (!cell) {
        cell = createMockCell(serverId, purgedIds, failIds, opts.waitOverride);
        cells.set(serverId, cell);
      }
      return cell;
    },
    listOnlineServerIds: () => Promise.resolve(opts.onlineIds ?? []),
    // Admin diagnostics (`GET /servers/:id/cell`) legitimately reads live snapshots.
    getSnapshots: (ids) => {
      const out = new Map();
      if (!opts.connectedSnapshots) return Promise.resolve(out);
      for (const id of ids) {
        out.set(id, {
          serverId: id,
          version: 1,
          updatedAt: new Date().toISOString(),
          connected: true,
          lastInboundAt: new Date().toISOString(),
        });
      }
      return Promise.resolve(out);
    },
    purge: async (serverId: string) => {
      await registry.getCell(serverId).purge();
    },
  };

  return { registry, purgedIds };
}

async function createAdminTestApp(
  registry: DaemonCellRegistry,
  options: Readonly<{
    withDataEncryption?: boolean;
    withBrowserWriteProtection?: boolean;
    getEnv?: () => Record<string, string | undefined>;
    devSurface?: boolean;
    runtime?: "deno" | "workers";
  }> = {},
) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const dataEncryptionSecrets = options.withDataEncryption === false
    ? undefined
    : await deriveEncryptionSecretsConfig(secretsConfig, "data-encryption");
  const app = new Hono<AppEnv>();
  if (options.withBrowserWriteProtection) {
    app.use("*", createBrowserWriteProtectionMiddleware("workers"));
  }
  app.use("*", (c, next) => {
    c.set("db", createDenoDb());
    c.set("daemonCellRegistry", registry);
    if (dataEncryptionSecrets) {
      c.set("dataEncryptionSecrets", dataEncryptionSecrets);
    }
    return next();
  });
  registerAdminRoutes(app, {
    secrets,
    runtime: options.runtime ?? "deno",
    devSurface: options.devSurface ?? false,
    ...(options.getEnv ? { getEnv: options.getEnv } : {}),
  });
  return { app, secrets };
}

async function adminSessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  const signed = await buildSignedCookie(token, secrets);
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
}

async function withRoleUser(
  role: "admin" | "superadmin",
  fn: (ctx: {
    app: Hono<AppEnv>;
    cookie: string;
  }) => Promise<void>,
  options: Readonly<{
    withDataEncryption?: boolean;
    withBrowserWriteProtection?: boolean;
    getEnv?: () => Record<string, string | undefined>;
    devSurface?: boolean;
  }> = {},
): Promise<void> {
  if (!dbUrl) {
    console.warn("Skipping admin route tests: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  await resetReencryptSweepLockForTests(db);
  const email = `admin-cell-purge-${role}-${crypto.randomUUID()}@example.com`;
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const { registry } = createTrackingRegistry();
  const { app, secrets } = await createAdminTestApp(registry, options);
  const cookie = await adminSessionCookie(db, secrets, userId);

  try {
    await fn({ app, cookie });
  } finally {
    await db.delete(user).where(eq(user.id, userId));
    await resetReencryptSweepLockForTests(db);
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("POST /api/admin/v1/cells/:serverId/purge returns 403 for admin role", async () => {
  await withRoleUser("admin", async ({ app, cookie }) => {
    const serverId = crypto.randomUUID();
    const res = await app.request(
      `${ADMIN_API_PREFIX}/cells/${serverId}/purge`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );

    assertEquals(res.status, 403);
  });
});

test("POST /api/admin/v1/cells/:serverId/purge purges a cell for superadmin", async () => {
  await withRoleUser("superadmin", async ({ app, cookie }) => {
    const serverId = crypto.randomUUID();
    const res = await app.request(
      `${ADMIN_API_PREFIX}/cells/${serverId}/purge`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { ok: true, serverId, purged: true });
  });
});

test("POST /api/admin/v1/cells/purge-batch returns 403 for admin role", async () => {
  await withRoleUser("admin", async ({ app, cookie }) => {
    const res = await app.request(`${ADMIN_API_PREFIX}/cells/purge-batch`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverIds: [crypto.randomUUID()] }),
    });

    assertEquals(res.status, 403);
  });
});

test("POST /api/admin/v1/cells/purge-batch reports per-id results for superadmin", async () => {
  await withRoleUser("superadmin", async ({ app: _app, cookie }) => {
    const okId = crypto.randomUUID();
    const failId = crypto.randomUUID();
    const failIds = new Set([failId]);
    const { registry, purgedIds } = createTrackingRegistry(failIds);

    const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
    const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
    const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
      secretsConfig,
      "data-encryption",
    );
    const batchApp = new Hono<AppEnv>();
    batchApp.use("*", (c, next) => {
      c.set("db", createDenoDb());
      c.set("daemonCellRegistry", registry);
      c.set("dataEncryptionSecrets", dataEncryptionSecrets);
      return next();
    });
    registerAdminRoutes(batchApp, {
      secrets,
      runtime: "deno",
      devSurface: false,
    });

    const res = await batchApp.request(
      `${ADMIN_API_PREFIX}/cells/purge-batch`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serverIds: [okId, failId] }),
      },
    );

    assertEquals(res.status, 200);
    const body = await jsonBody<{
      ok: boolean;
      results: Array<{ serverId: string; ok: boolean; error?: string }>;
    }>(res);
    assertEquals(body.ok, true);
    assertEquals(body.results.length, 2);
    assertEquals(body.results[0], { serverId: okId, ok: true });
    assertEquals(body.results[1].serverId, failId);
    assertEquals(body.results[1].ok, false);
    assertEquals(typeof body.results[1].error, "string");
    assertEquals(purgedIds, [okId]);
  });
});

test("POST /api/admin/v1/secrets/reencrypt returns 403 for admin role", async () => {
  await withRoleUser("admin", async ({ app, cookie }) => {
    const res = await app.request(`${ADMIN_API_PREFIX}/secrets/reencrypt`, {
      method: "POST",
      headers: { Cookie: cookie },
    });

    assertEquals(res.status, 403);
  });
});

test("POST /api/admin/v1/secrets/reencrypt returns summary for superadmin", async () => {
  await withRoleUser("superadmin", async ({ app, cookie }) => {
    const res = await app.request(`${ADMIN_API_PREFIX}/secrets/reencrypt`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assertEquals(res.status, 200);
    const body = await jsonBody<{
      ok: boolean;
      scanned: number;
      reencrypted: number;
      skipped: number;
      failed: number;
      completed: boolean;
      cursor: string | null;
    }>(res);
    assertEquals(body.ok, true);
    assertEquals(typeof body.scanned, "number");
    assertEquals(typeof body.reencrypted, "number");
    assertEquals(typeof body.skipped, "number");
    assertEquals(typeof body.failed, "number");
    assertEquals(typeof body.completed, "boolean");
    assertEquals(body.completed, true);
    assertEquals(body.cursor, null);
  });
});

test("POST /api/admin/v1/secrets/reencrypt returns 503 when encryption key is missing", async () => {
  await withRoleUser(
    "superadmin",
    async ({ app, cookie }) => {
      const res = await app.request(`${ADMIN_API_PREFIX}/secrets/reencrypt`, {
        method: "POST",
        headers: { Cookie: cookie },
      });

      assertEquals(res.status, 503);
      const body = await jsonBody<{ ok: boolean; error: string }>(res);
      assertEquals(body.ok, false);
      assertEquals(
        body.error,
        "Encryption unavailable — no encryption key configured",
      );
    },
    { withDataEncryption: false },
  );
});

test("POST /api/admin/v1/secrets/reencrypt rejects cross-origin browser writes", async () => {
  await withRoleUser(
    "superadmin",
    async ({ app, cookie }) => {
      // HTTPS requests resolve the `__Host-` cookie name; reuse the signed token.
      const httpsCookie = cookie.replace(
        `${HTTP_SESSION_COOKIE_NAME}=`,
        `${HTTPS_SESSION_COOKIE_NAME}=`,
      );
      const res = await app.request(
        new Request(
          `https://panel.example.com${ADMIN_API_PREFIX}/secrets/reencrypt`,
          {
            method: "POST",
            headers: {
              Cookie: httpsCookie,
              Origin: "https://docs.example.com",
              "content-type": "application/json",
            },
            body: "{}",
          },
        ),
      );

      assertEquals(res.status, 403);
      const body = await jsonBody<{ ok: boolean; error: string }>(res);
      assertEquals(body.ok, false);
      assertEquals(body.error, "Forbidden");
    },
    { withBrowserWriteProtection: true },
  );
});

test("POST /api/admin/v1/secrets/reencrypt allows same-origin browser writes", async () => {
  await withRoleUser(
    "superadmin",
    async ({ app, cookie }) => {
      const httpsCookie = cookie.replace(
        `${HTTP_SESSION_COOKIE_NAME}=`,
        `${HTTPS_SESSION_COOKIE_NAME}=`,
      );
      const res = await app.request(
        new Request(
          `https://panel.example.com${ADMIN_API_PREFIX}/secrets/reencrypt`,
          {
            method: "POST",
            headers: {
              Cookie: httpsCookie,
              Origin: "https://panel.example.com",
              "content-type": "application/json",
            },
            body: "{}",
          },
        ),
      );

      assertEquals(res.status, 200);
      const body = await jsonBody<{ ok: boolean; completed: boolean }>(res);
      assertEquals(body.ok, true);
      assertEquals(body.completed, true);
    },
    { withBrowserWriteProtection: true },
  );
});

test("POST /api/admin/v1/secrets/reencrypt validates request bodies", async () => {
  await withRoleUser("superadmin", async ({ app, cookie }) => {
    const badBody = await app.request(`${ADMIN_API_PREFIX}/secrets/reencrypt`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify([]),
    });
    assertEquals(badBody.status, 400);

    const badLimit = await app.request(
      `${ADMIN_API_PREFIX}/secrets/reencrypt`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 0 }),
      },
    );
    assertEquals(badLimit.status, 400);

    const badCursor = await app.request(
      `${ADMIN_API_PREFIX}/secrets/reencrypt`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cursor: { stage: "not-a-stage" } }),
      },
    );
    assertEquals(badCursor.status, 400);
  });
});

test("POST /api/admin/v1/secrets/reencrypt returns 409 when a sweep is already running", async () => {
  await withRoleUser("superadmin", async ({ app, cookie }) => {
    const lockDb = createDenoDb();
    await resetReencryptSweepLockForTests(lockDb);
    const held = await tryBeginReencryptSweep(lockDb);
    assertEquals(held !== null, true);
    try {
      const res = await app.request(`${ADMIN_API_PREFIX}/secrets/reencrypt`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 409);
      const body = await jsonBody<{ error: string }>(res);
      assertEquals(body.error, "reencrypt_in_progress");
    } finally {
      if (held) await endReencryptSweep(lockDb, held);
    }
  });
});

test("GET and PUT /api/admin/v1/settings/signup round-trip panel toggle", async () => {
  await withRoleUser("superadmin", async ({ app, cookie }) => {
    const db = createDenoDb();
    const signupKey = "IS_SIGNUP_ENABLED";
    const previous = await db
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, signupKey))
      .limit(1);

    try {
      await db.delete(setting).where(eq(setting.key, signupKey));

      const initial = await app.request(`${ADMIN_API_PREFIX}/settings/signup`, {
        headers: { Cookie: cookie },
      });
      assertEquals(initial.status, 200);
      const initialBody = await jsonBody<
        { enabled: boolean; isEnvForced: boolean }
      >(
        initial,
      );
      assertEquals(initialBody.enabled, false);
      assertEquals(initialBody.isEnvForced, false);

      const enable = await app.request(`${ADMIN_API_PREFIX}/settings/signup`, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      });
      assertEquals(enable.status, 200);
      const enabledBody = await jsonBody<{ enabled: boolean; dbValue: string }>(
        enable,
      );
      assertEquals(enabledBody.enabled, true);
      assertEquals(enabledBody.dbValue, "1");

      const disable = await app.request(`${ADMIN_API_PREFIX}/settings/signup`, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      });
      assertEquals(disable.status, 200);
      const disabledBody = await jsonBody<
        { enabled: boolean; dbValue: string }
      >(
        disable,
      );
      assertEquals(disabledBody.enabled, false);
      assertEquals(disabledBody.dbValue, "0");
    } finally {
      await db.delete(setting).where(eq(setting.key, signupKey));
      if (previous.length > 0) {
        await db.insert(setting).values({
          key: signupKey,
          value: previous[0]!.value,
        });
      }
    }
  });
});

test("PUT /api/admin/v1/settings/signup returns 409 when env force override is set", async () => {
  await withRoleUser(
    "superadmin",
    async ({ app, cookie }) => {
      const res = await app.request(`${ADMIN_API_PREFIX}/settings/signup`, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      });
      assertEquals(res.status, 409);
      const body = await jsonBody<{ isEnvForced: boolean; enabled: boolean }>(
        res,
      );
      assertEquals(body.isEnvForced, true);
      assertEquals(body.enabled, true);
    },
    {
      getEnv: () => ({ TURBOPANEL_IS_SIGNUP_ENABLED: "1" }),
    },
  );
});

test("GET and PUT /api/admin/v1/instance/public-urls validate and persist origins", async () => {
  await withRoleUser("superadmin", async ({ app, cookie }) => {
    const db = createDenoDb();
    const publicUrlsKey = "TURBOPANEL_PUBLIC_URLS";
    const previous = await db
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, publicUrlsKey))
      .limit(1);

    try {
      await db.delete(setting).where(eq(setting.key, publicUrlsKey));

      const empty = await app.request(
        `${ADMIN_API_PREFIX}/instance/public-urls`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(empty.status, 200);
      assertEquals(await empty.json(), { ok: true, urls: [] });

      const invalid = await app.request(
        `${ADMIN_API_PREFIX}/instance/public-urls`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ urls: ["localhost"] }),
        },
      );
      assertEquals(invalid.status, 422);

      const save = await app.request(
        `${ADMIN_API_PREFIX}/instance/public-urls`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ urls: ["https://panel.example.com"] }),
        },
      );
      assertEquals(save.status, 200);
      const savedBody = await save.json();
      assertEquals(savedBody, {
        ok: true,
        urls: ["https://panel.example.com"],
        applied: false,
      });

      const reload = await app.request(
        `${ADMIN_API_PREFIX}/instance/public-urls`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(reload.status, 200);
      assertEquals(await reload.json(), {
        ok: true,
        urls: ["https://panel.example.com"],
      });
    } finally {
      await db.delete(setting).where(eq(setting.key, publicUrlsKey));
      if (previous.length > 0) {
        await db.insert(setting).values({
          key: publicUrlsKey,
          value: previous[0]!.value,
        });
      }
    }
  });
});

test("GET and PUT /api/admin/v1/settings/email round-trip non-secret settings", async () => {
  await withRoleUser("admin", async ({ app, cookie }) => {
    const get = await app.request(`${ADMIN_API_PREFIX}/settings/email`, {
      headers: { Cookie: cookie },
    });
    assertEquals(get.status, 200);
    const before = await jsonBody<{ settings: unknown }>(get);
    assertEquals(typeof before.settings, "object");

    const put = await app.request(`${ADMIN_API_PREFIX}/settings/email`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ FROM: "coverage-admin@example.com" }),
    });
    assertEquals(put.status, 200);
    const after = await jsonBody<{ settings: unknown }>(put);
    assertEquals(typeof after.settings, "object");
  });
});

test("daemon fleet diagnostics and address request success paths", async () => {
  if (!dbUrl) {
    console.warn("Skipping admin route tests: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  await resetReencryptSweepLockForTests(db);
  const email = `admin-fleet-${crypto.randomUUID()}@example.com`;
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "superadmin" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const [insertedServer] = await db
    .insert(server)
    .values({
      name: `admin-fleet-${crypto.randomUUID()}`,
      hostname: `admin-fleet-${crypto.randomUUID()}.example`,
      isConnected: true,
      statusChangedAt: new Date().toISOString(),
      daemon: {
        key: {
          id: crypto.randomUUID(),
          algorithm: "Ed25519",
          publicJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
          fingerprint: "fp",
          createdAt: new Date().toISOString(),
        },
        projection: {
          remoteAddress: "__direct__",
          connected: true,
        },
      },
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const { registry } = createTrackingRegistry(new Set(), {
    onlineIds: [serverId],
    connectedSnapshots: true,
  });
  const { app, secrets } = await createAdminTestApp(registry);
  const cookie = await adminSessionCookie(db, secrets, userId);

  try {
    const connections = await app.request(
      `${ADMIN_API_PREFIX}/daemon/connections`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(connections.status, 200);
    const connectionsBody = await jsonBody<{ connections: unknown[] }>(
      connections,
    );
    assertEquals(Array.isArray(connectionsBody.connections), true);

    const send = await app.request(
      `${ADMIN_API_PREFIX}/daemon/${serverId}/send`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ payload: { echo: true } }),
      },
    );
    assertEquals(send.status, 200);
    assertEquals(await send.json(), { ok: true, id: serverId });

    const commands = await app.request(`${ADMIN_API_PREFIX}/daemon/commands`, {
      headers: { Cookie: cookie },
    });
    assertEquals(commands.status, 200);

    const fleetAddresses = await app.request(
      `${ADMIN_API_PREFIX}/daemon/addresses`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(fleetAddresses.status, 200);
    const fleetBody = await jsonBody<{ servers: unknown[] }>(fleetAddresses);
    assertEquals(Array.isArray(fleetBody.servers), true);
    assertEquals(fleetBody.servers.length >= 1, true);

    const oneAddresses = await app.request(
      `${ADMIN_API_PREFIX}/daemon/${serverId}/addresses`,
      { headers: { Cookie: cookie } },
    );
    assertEquals(oneAddresses.status, 200);
    const oneBody = await jsonBody<{ ok: boolean; daemonId: string }>(
      oneAddresses,
    );
    assertEquals(oneBody.ok, true);
    assertEquals(oneBody.daemonId, serverId);

    const applyOk = await app.request(
      `${ADMIN_API_PREFIX}/instance/public-urls/apply`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ urls: ["https://apply.example.com"] }),
      },
    );
    assertEquals(applyOk.status, 200);
    assertEquals(await applyOk.json(), { ok: true, applied: true });
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(user).where(eq(user.id, userId));
    await resetReencryptSweepLockForTests(db);
  }
});

test("daemon address request failed/expired/error branches", async () => {
  if (!dbUrl) {
    console.warn("Skipping admin route tests: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  const email = `admin-addr-fail-${crypto.randomUUID()}@example.com`;
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "admin" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const [insertedServer] = await db
    .insert(server)
    .values({
      name: `admin-addr-${crypto.randomUUID()}`,
      isConnected: true,
      statusChangedAt: new Date().toISOString(),
      daemon: {
        key: {
          id: crypto.randomUUID(),
          algorithm: "Ed25519",
          publicJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          },
          fingerprint: "fp2",
          createdAt: new Date().toISOString(),
        },
        projection: { remoteAddress: "__direct__" },
      },
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  try {
    const failedRegistry = createTrackingRegistry(new Set(), {
      onlineIds: [serverId],
      waitOverride: (outbound) =>
        Promise.resolve({
          serverId,
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          status: "failed" as const,
          createdAt: outbound.at,
          expiresAt: outbound.at,
        }),
    }).registry;
    const failedApp = await createAdminTestApp(failedRegistry);
    const cookie = await adminSessionCookie(db, failedApp.secrets, userId);

    const failedFleet = await failedApp.app.request(
      `${ADMIN_API_PREFIX}/daemon/addresses`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(failedFleet.status, 200);
    const failedFleetBody = await jsonBody<
      { servers: Array<{ error?: string }> }
    >(
      failedFleet,
    );
    assertEquals(
      failedFleetBody.servers[0]?.error,
      "failed to fetch addresses",
    );

    const failedOne = await failedApp.app.request(
      `${ADMIN_API_PREFIX}/daemon/${serverId}/addresses`,
      { headers: { Cookie: cookie } },
    );
    assertEquals(failedOne.status, 500);

    const expiredRegistry = createTrackingRegistry(new Set(), {
      onlineIds: [serverId],
      waitOverride: (outbound) =>
        Promise.resolve({
          serverId,
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          status: "expired" as const,
          createdAt: outbound.at,
          expiresAt: outbound.at,
        }),
    }).registry;
    const expiredApp = await createAdminTestApp(expiredRegistry);
    const expiredCookie = await adminSessionCookie(
      db,
      expiredApp.secrets,
      userId,
    );

    const expiredFleet = await expiredApp.app.request(
      `${ADMIN_API_PREFIX}/daemon/addresses`,
      {
        headers: { Cookie: expiredCookie },
      },
    );
    assertEquals(expiredFleet.status, 200);
    const expiredFleetBody = await jsonBody<
      { servers: Array<{ error?: string }> }
    >(
      expiredFleet,
    );
    assertEquals(
      expiredFleetBody.servers[0]?.error,
      "timeout waiting for addresses",
    );

    const expiredOne = await expiredApp.app.request(
      `${ADMIN_API_PREFIX}/daemon/${serverId}/addresses`,
      { headers: { Cookie: expiredCookie } },
    );
    assertEquals(expiredOne.status, 500);

    const throwRegistry = createTrackingRegistry(new Set(), {
      onlineIds: [serverId],
      waitOverride: () => Promise.reject(new Error("daemon not connected")),
    }).registry;
    const throwApp = await createAdminTestApp(throwRegistry);
    const throwCookie = await adminSessionCookie(db, throwApp.secrets, userId);

    const throwFleet = await throwApp.app.request(
      `${ADMIN_API_PREFIX}/daemon/addresses`,
      {
        headers: { Cookie: throwCookie },
      },
    );
    assertEquals(throwFleet.status, 200);
    const throwFleetBody = await jsonBody<
      { servers: Array<{ error?: string }> }
    >(
      throwFleet,
    );
    assertEquals(throwFleetBody.servers[0]?.error, "daemon not connected");

    const throwOne = await throwApp.app.request(
      `${ADMIN_API_PREFIX}/daemon/${serverId}/addresses`,
      { headers: { Cookie: throwCookie } },
    );
    assertEquals(throwOne.status, 404);

    const throw500Registry = createTrackingRegistry(new Set(), {
      onlineIds: [serverId],
      waitOverride: () => Promise.reject("raw-fail"),
    }).registry;
    const throw500App = await createAdminTestApp(throw500Registry);
    const throw500Cookie = await adminSessionCookie(
      db,
      throw500App.secrets,
      userId,
    );
    const throw500One = await throw500App.app.request(
      `${ADMIN_API_PREFIX}/daemon/${serverId}/addresses`,
      { headers: { Cookie: throw500Cookie } },
    );
    assertEquals(throw500One.status, 500);
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(user).where(eq(user.id, userId));
  }
});

test("POST /instance/public-urls/apply returns 503 when colocated snapshot is disconnected", async () => {
  if (!dbUrl) {
    console.warn("Skipping admin route tests: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  const email = `admin-apply-disc-${crypto.randomUUID()}@example.com`;
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "superadmin" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const [insertedServer] = await db
    .insert(server)
    .values({
      name: `admin-apply-${crypto.randomUUID()}`,
      isConnected: true,
      statusChangedAt: new Date().toISOString(),
      daemon: {
        key: {
          id: crypto.randomUUID(),
          algorithm: "Ed25519",
          publicJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          },
          fingerprint: "fp3",
          createdAt: new Date().toISOString(),
        },
        projection: { remoteAddress: "__direct__" },
      },
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const { registry } = createTrackingRegistry(new Set(), {
    onlineIds: [serverId],
    connectedSnapshots: false,
  });
  const { app, secrets } = await createAdminTestApp(registry);
  const cookie = await adminSessionCookie(db, secrets, userId);

  try {
    const res = await app.request(
      `${ADMIN_API_PREFIX}/instance/public-urls/apply`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assertEquals(res.status, 503);
    const body = await jsonBody<{ error: string }>(res);
    assertEquals(body.error, "co-located daemon disconnected");
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(user).where(eq(user.id, userId));
  }
});
