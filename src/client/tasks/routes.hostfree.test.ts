/**
 * Host-free coverage for task route registration and behaviour (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { service, task } from "../../lib/db/schema.ts";
import { CLIENT_API_PREFIX } from "../../surfaces.ts";
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
import { SYSTEM_RESOURCE_IMMUTABLE_ERROR } from "../authz/http.ts";
import { TASK_NAME_IN_USE_ERROR } from "../display-name-uniqueness.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerClientRoutes } from "../routes.ts";
import { MAX_CRON_JOBS_PER_SERVICE } from "./routes-helpers.ts";
import { registerTaskRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const taskId = "11111111-1111-4111-8111-111111111111";
const createdTaskId = "33333333-3333-4333-8333-333333333333";
const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOrgId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const serviceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const environmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: () => promise,
    orderBy: () => thenableRows(rows),
    returning: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function taskRecord(opts?: { id?: string; name?: string; serviceId?: string }) {
  return {
    id: opts?.id ?? taskId,
    serviceId: opts?.serviceId ?? serviceId,
    name: opts?.name ?? "nightly",
    schedule: "0 0 * * *",
    command: "/usr/bin/true",
    timezone: null,
    isEnabled: true,
    concurrencyPolicy: "forbid",
    timeoutSeconds: null,
    metadata: null,
    options: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

type TaskSessionOpts = {
  executeQueue?: unknown[][];
  taskSelectQueue?: unknown[][];
  taskRows?: unknown[];
  serviceRows?: unknown[];
  createdId?: string;
};

async function buildApp(db: Db | undefined): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    if (db) c.set("db", db);
    c.set("runtime", "deno");
    return next();
  });
  registerTaskRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    "session-token",
    secrets,
  )}`;
  return { app, cookie };
}

function sessionRow() {
  return {
    sessionId: "sess-1",
    userId,
    email: "ops@example.com",
    role: "superadmin",
    isDisabled: false,
  };
}

function taskHttpDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ role: "superadmin" }]),
        }),
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve([sessionRow()]),
          }),
        }),
      }),
    }),
    execute: () => Promise.resolve([{ allowed: true }]),
  } as unknown as Db;
}

function nextQueuedRows(
  queue: unknown[][] | undefined,
  fallback: unknown[],
): unknown[] {
  if (queue && queue.length > 0) {
    return queue.shift() ?? [];
  }
  return fallback;
}

function createTaskRouteDb(opts: TaskSessionOpts = {}): Db {
  const state = createEmptyMockAuthState();
  seedMockSession(state, "session-token", {
    sessionId: "sess-1",
    userId,
    email: "ops@example.com",
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: "ops@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: orgId, name: "Task Org" });

  const executeQueue = [...(opts.executeQueue ?? [])];
  const taskSelectQueue = opts.taskSelectQueue
    ? [...opts.taskSelectQueue]
    : undefined;
  const taskRows = opts.taskRows ?? [];
  const serviceRows = opts.serviceRows ?? [{ id: serviceId, environmentId }];
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const origInsert = (
    authDb as unknown as {
      insert: (
        table: unknown,
      ) => { values: (row: Record<string, unknown>) => unknown };
    }
  ).insert.bind(authDb);

  return Object.assign(authDb, {
    execute: () => {
      if (executeQueue.length > 0) {
        return Promise.resolve(executeQueue.shift() ?? []);
      }
      return Promise.resolve([{ allowed: true }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === task) {
          const rows = nextQueuedRows(taskSelectQueue, taskRows);
          return {
            where: () => thenableRows(rows),
            innerJoin: () => ({
              where: () => thenableRows(rows),
            }),
          };
        }
        if (table === service) {
          return {
            where: () => thenableRows(serviceRows),
            innerJoin: () => ({
              where: () => thenableRows(serviceRows),
            }),
          };
        }
        return origSelect(fields).from(table);
      },
    }),
    insert: (table: unknown) => {
      if (table === task) {
        return {
          values: () => ({
            returning: () =>
              thenableRows([{ id: opts.createdId ?? createdTaskId }]),
          }),
        };
      }
      return origInsert(table);
    },
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => thenableRows([]),
    }),
  }) as unknown as Db;
}

async function buildSessionApp(opts: TaskSessionOpts = {}): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const db = createTaskRouteDb(opts);
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("runtime", "deno");
    return next();
  });
  registerTaskRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    "session-token",
    secrets,
  )}`;
  return { app, cookie };
}

function dropDbAfterSession(db: Db) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    let dropDb = false;
    const origGet = c.get.bind(c);
    const origSet = c.set.bind(c);
    (c as unknown as { get: (key: string) => unknown }).get = (key: string) => {
      if (key === "db" && dropDb) return undefined;
      return origGet(key as never);
    };
    (c as unknown as { set: (key: string, value: unknown) => void }).set = (
      key: string,
      value: unknown,
    ) => {
      if (key === "session") dropDb = true;
      origSet(key as never, value as never);
    };
    origSet("db" as never, db as never);
    origSet("runtime" as never, "deno" as never);
    await next();
  };
}

function authHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: orgId,
    "content-type": "application/json",
  };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    serviceId,
    name: "nightly",
    schedule: "0 0 * * *",
    command: "/usr/bin/true",
    ...overrides,
  };
}

test("task routes return 401 without a session cookie", async () => {
  const { app } = await buildApp({} as Db);
  const paths = [
    ["GET", "/tasks"],
    ["GET", `/tasks/${taskId}`],
    ["POST", "/tasks"],
    ["PATCH", `/tasks/${taskId}`],
    ["DELETE", `/tasks/${taskId}`],
  ] as const;

  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify({}),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("GET /tasks returns 401 when db is missing", async () => {
  const { app } = await buildApp(undefined);
  const res = await app.request("/tasks");
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
});

test("malformed task ids are rejected before UUID queries", async () => {
  const { app, cookie } = await buildApp(taskHttpDb());
  const headers = authHeaders(cookie);

  const taskPath = await app.request("/tasks/not-a-uuid", { headers });
  assertEquals(taskPath.status, 404);
  assertEquals(await taskPath.json(), { error: "Not found" });

  const create = await app.request("/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      serviceId: "not-a-uuid",
      name: "nightly",
      schedule: "0 0 * * *",
      command: "/usr/bin/true",
    }),
  });
  assertEquals(create.status, 400);
  assertEquals(await create.json(), { error: "Invalid request" });

  const listed = await app.request("/tasks?environmentId=not-a-uuid", {
    headers,
  });
  assertEquals(listed.status, 400);
  assertEquals(await listed.json(), { error: "Invalid request" });
});

test("GET /tasks lists tasks for visible services", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [[{ item_id: serviceId }]],
    taskRows: [
      taskRecord({ id: "2", name: "zeta" }),
      taskRecord({ id: "1", name: "alpha" }),
    ],
  });
  const res = await app.request("/tasks", { headers: authHeaders(cookie) });
  assertEquals(res.status, 200);
  const body = await res.json() as { tasks: Array<{ name: string }> };
  assertEquals(body.tasks.map((row) => row.name), ["alpha", "zeta"]);
});

test("GET /tasks?serviceId= filters to one visible service", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [[{ item_id: serviceId }]],
    taskRows: [taskRecord()],
  });
  const res = await app.request(`/tasks?serviceId=${serviceId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    tasks: Array<{ id: string; serviceId: string }>;
  };
  assertEquals(body.tasks.length, 1);
  assertEquals(body.tasks[0]?.id, taskId);
  assertEquals(body.tasks[0]?.serviceId, serviceId);
});

test("GET /tasks?environmentId= lists tasks for services in that environment", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [[{ item_id: serviceId }]],
    serviceRows: [{ id: serviceId, environmentId }],
    taskRows: [taskRecord()],
  });
  const res = await app.request(`/tasks?environmentId=${environmentId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { tasks: Array<{ id: string }> };
  assertEquals(body.tasks[0]?.id, taskId);
});

test("GET /tasks rejects serviceId and environmentId together", async () => {
  const { app, cookie } = await buildSessionApp();
  const res = await app.request(
    `/tasks?serviceId=${serviceId}&environmentId=${environmentId}`,
    { headers: authHeaders(cookie) },
  );
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("GET /tasks/:id returns the task", async () => {
  const row = taskRecord();
  const { app, cookie } = await buildSessionApp({
    taskRows: [row],
    executeQueue: [[{ organization_id: orgId }], [{ allowed: true }]],
  });
  const res = await app.request(`/tasks/${taskId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { task: row });
});

test("POST /tasks creates a task", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "user" }],
    ],
    taskSelectQueue: [[], []],
    createdId: createdTaskId,
  });
  const res = await app.request("/tasks", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(createBody({ name: "  nightly  " })),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, id: createdTaskId });
});

test("PATCH /tasks/:id updates a task", async () => {
  const { app, cookie } = await buildSessionApp({
    taskSelectQueue: [[taskRecord()], []],
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "user" }],
    ],
  });
  const res = await app.request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: authHeaders(cookie),
    body: JSON.stringify({ name: "hourly" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /tasks/:id deletes a task", async () => {
  const { app, cookie } = await buildSessionApp({
    taskRows: [taskRecord()],
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "user" }],
    ],
  });
  const res = await app.request(`/tasks/${taskId}`, {
    method: "DELETE",
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("POST /tasks returns 409 when the display name is taken", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "user" }],
    ],
    taskSelectQueue: [[], [{ id: taskId }]],
  });
  const res = await app.request("/tasks", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(createBody()),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: TASK_NAME_IN_USE_ERROR });
});

test("POST /tasks returns 409 when the per-service limit is reached", async () => {
  const full = Array.from(
    { length: MAX_CRON_JOBS_PER_SERVICE },
    (_, index) => ({
      id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
    }),
  );
  const { app, cookie } = await buildSessionApp({
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "user" }],
    ],
    taskSelectQueue: [full],
  });
  const res = await app.request("/tasks", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(createBody({ name: "overflow" })),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "task_limit_reached" });
});

test("GET /tasks/:id returns 404 when the service is in another organization", async () => {
  const { app, cookie } = await buildSessionApp({
    taskRows: [taskRecord()],
    executeQueue: [[{ organization_id: otherOrgId }]],
  });
  const res = await app.request(`/tasks/${taskId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /tasks returns 403 when the parent service is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "turbopanel" }],
    ],
  });
  const res = await app.request("/tasks", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ serviceId }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: SYSTEM_RESOURCE_IMMUTABLE_ERROR });
});

test("GET /tasks returns 503 when db is missing after authentication", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const db = createTaskRouteDb();
  const app = new Hono<AppEnv>();
  app.use("*", dropDbAfterSession(db));
  registerTaskRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    "session-token",
    secrets,
  )}`;
  const res = await app.request("/tasks", { headers: authHeaders(cookie) });
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "Database unavailable" });
});

test("registerClientRoutes mounts tasks under the client API prefix", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("runtime", "deno");
    return next();
  });
  registerClientRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });

  const tags = await app.request(`${CLIENT_API_PREFIX}/tags`);
  assertEquals(tags.status, 401);
  assertEquals(await tags.json(), { ok: false, error: "Unauthorized" });

  const tasks = await app.request(`${CLIENT_API_PREFIX}/tasks`);
  assertEquals(tasks.status, 401);
  assertEquals(await tasks.json(), { ok: false, error: "Unauthorized" });
});
