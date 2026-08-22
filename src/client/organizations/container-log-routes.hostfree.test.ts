/**
 * Host-free coverage for the organization container-log routes (no Postgres):
 * the manage-gated retention switch and the read route's org scoping plus its
 * explicit 503 when the feature is switched off.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { organization } from "../../lib/db/schema.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from "../authn/authn-hostfree-doubles.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { deriveSecretsConfig } from "../authn/secrets.ts";
import { DisabledContainerLogStore } from "../../lib/container-logs/disabled-store.ts";
import type {
  ContainerLogQuery,
  ContainerLogStore,
} from "../../lib/container-logs/types.ts";

/**
 * `Response.json()` resolves to `unknown`; these assertions read known fields
 * off the payload, so narrow once here instead of casting at every call site.
 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}
import { registerOrganizationRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const orgId = "11111111-1111-4111-8111-111111111111";

type RecordingStore = ContainerLogStore & { queries: ContainerLogQuery[] };

function createRecordingStore(): RecordingStore {
  const queries: ContainerLogQuery[] = [];
  return {
    queries,
    ingest() {
      return Promise.resolve();
    },
    query(q: ContainerLogQuery) {
      queries.push(q);
      return Promise.resolve({ events: [], nextCursor: null });
    },
  };
}

async function buildSessionApp(opts: {
  manageAllowed: boolean;
  orgOptions?: unknown;
  store?: ContainerLogStore;
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `container-logs-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `container-logs-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: orgId, name: "Container Logs Org" });

  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);

  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: opts.manageAllowed }]),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === organization) {
          const rows = [
            {
              id: orgId,
              name: "Container Logs Org",
              createdAt: "2020-01-01T00:00:00.000Z",
              options: opts.orgOptions ?? null,
            },
          ];
          return Object.assign(Promise.resolve(rows), {
            where: () => ({
              limit: () => Promise.resolve(rows),
              orderBy: () => Promise.resolve(rows),
            }),
            orderBy: () => Promise.resolve(rows),
          });
        }
        return origSelect(fields).from(table);
      },
    }),
  }) as unknown as Db;

  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    if (opts.store) c.set("containerLogStore", opts.store);
    return next();
  });
  registerOrganizationRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie };
}

test("container-log settings GET reports the platform default (off)", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(
    `/organizations/${orgId}/container-logs-settings`,
    {
      headers: { cookie },
    },
  );
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(body.containerLogsEnabled, false);
  assertEquals(body.retentionDays, 30);
});

test("container-log settings GET reflects an enabled organization", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
  });
  const res = await app.request(
    `/organizations/${orgId}/container-logs-settings`,
    {
      headers: { cookie },
    },
  );
  assertEquals((await readJson(res)).containerLogsEnabled, true);
});

test("container-log settings PUT is manage-gated", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(
    `/organizations/${orgId}/container-logs-settings`,
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ containerLogsEnabled: true }),
    },
  );
  assertEquals(res.status, 403);
});

test("container-log settings PUT rejects a non-boolean switch", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(
    `/organizations/${orgId}/container-logs-settings`,
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ containerLogsEnabled: "yes" }),
    },
  );
  assertEquals(res.status, 400);
  assertEquals((await readJson(res)).error, "Invalid containerLogsEnabled");
});

test("container-log settings PUT persists and echoes the switch", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
  });
  const res = await app.request(
    `/organizations/${orgId}/container-logs-settings`,
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ containerLogsEnabled: true }),
    },
  );
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(body.ok, true);
  assertEquals(body.containerLogsEnabled, true);
});

test("container-log read scopes the query to the path organization", async () => {
  const store = createRecordingStore();
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
    store,
  });
  const res = await app.request(
    `/organizations/${orgId}/container-logs?organizationId=someone-else&stream=stderr`,
    { headers: { cookie } },
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { events: [], nextCursor: null });
  assertEquals(store.queries.length, 1);
  assertEquals(store.queries[0]?.organizationId, orgId);
  assertEquals(store.queries[0]?.stream, "stderr");
});

/**
 * The read route's gate has two independent inputs — the organization's
 * retention switch and whether a backend is bound — and the org switch is the
 * authoritative one. All four combinations are pinned below so neither input
 * can be dropped without a failing test.
 */
test("container-log read answers 503 when the org switch is off but a backend is bound", async () => {
  const store = createRecordingStore();
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: false },
    store,
  });
  const res = await app.request(`/organizations/${orgId}/container-logs`, {
    headers: { cookie },
  });
  assertEquals(res.status, 503);
  assertEquals((await readJson(res)).error, "container_logs_disabled");
  // A healthy backend must not be queried for an org that never opted in.
  assertEquals(store.queries.length, 0);
});

test("container-log read answers 503 when the org switch is on but the backend is disabled", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
    store: new DisabledContainerLogStore(),
  });
  const res = await app.request(`/organizations/${orgId}/container-logs`, {
    headers: { cookie },
  });
  assertEquals(res.status, 503);
  assertEquals((await readJson(res)).error, "container_logs_disabled");
});

test("container-log read answers 200 when the org switch and the backend are both on", async () => {
  const store = createRecordingStore();
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
    store,
  });
  const res = await app.request(`/organizations/${orgId}/container-logs`, {
    headers: { cookie },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { events: [], nextCursor: null });
  assertEquals(store.queries.length, 1);
});

test("container-log read answers 503 when no store is bound at all", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
  });
  const res = await app.request(`/organizations/${orgId}/container-logs`, {
    headers: { cookie },
  });
  assertEquals(res.status, 503);
  assertEquals((await readJson(res)).error, "container_logs_disabled");
});

test("container-log read rejects an invalid filter with 400", async () => {
  const store = createRecordingStore();
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    orgOptions: { containerLogsEnabled: true },
    store,
  });
  const res = await app.request(
    `/organizations/${orgId}/container-logs?stream=console`,
    { headers: { cookie } },
  );
  assertEquals(res.status, 400);
  assertEquals(store.queries.length, 0);
});

test("container-log routes require a session cookie", async () => {
  const { app } = await buildSessionApp({ manageAllowed: true });
  for (
    const [method, path] of [
      ["GET", `/organizations/${orgId}/container-logs-settings`],
      ["PUT", `/organizations/${orgId}/container-logs-settings`],
      ["GET", `/organizations/${orgId}/container-logs`],
    ] as const
  ) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({}),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
  }
});

test("container-log read is read/manage-gated, not open to every member", async () => {
  // `manageAllowed: false` is a session that belongs to the organization but
  // holds no organization:manage grant. Plain membership used to be enough to
  // read container output; it must not be.
  const store = createRecordingStore();
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    store,
  });
  const res = await app.request(`/organizations/${orgId}/container-logs`, {
    headers: { cookie },
  });
  assertEquals(res.status, 403);
  assertEquals((await readJson(res)).error, "Forbidden");
  assertEquals(store.queries.length, 0);
});
