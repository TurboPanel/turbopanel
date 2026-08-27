/**
 * Host-free coverage for scheduled-task records (no Postgres).
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Db } from "../../db.ts";
import { task } from "./schema.ts";
import {
  countTasksForService,
  createTask,
  deleteTask,
  getTask,
  isTaskUniqueViolation,
  listTasksForService,
  listTasksForServices,
  parseTaskNameInput,
  serializeTask,
  sortTaskRecords,
  updateTask,
} from "./task-records.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const serviceId = "00000000-0000-4000-8000-00000000000a";

function taskRow(opts: { id: string; name: string }) {
  return {
    id: opts.id,
    serviceId,
    name: opts.name,
    schedule: "0 * * * *",
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

test("parseTaskNameInput trims names", () => {
  assertEquals(parseTaskNameInput("  nightly  "), {
    ok: true,
    name: "nightly",
  });
});

test("parseTaskNameInput rejects blank and control-character names", () => {
  assertEquals(parseTaskNameInput(""), { ok: false, error: "Invalid request" });
  assertEquals(parseTaskNameInput("   "), {
    ok: false,
    error: "Invalid request",
  });
  assertEquals(parseTaskNameInput("a\nb"), {
    ok: false,
    error: "Invalid request",
  });
  assertEquals(parseTaskNameInput(1), { ok: false, error: "Invalid request" });
});

test("serializeTask exposes the stored field set", () => {
  const record = serializeTask(taskRow({ id: "1", name: "nightly" }));
  if (!("id" in record) || !("serviceId" in record) || !("name" in record)) {
    throw new TypeError("expected serialized task fields");
  }
  assertEquals(record.id, "1");
  assertEquals(record.serviceId, serviceId);
  assertEquals(record.name, "nightly");
  assertEquals(record.schedule, "0 * * * *");
  assertEquals(record.command, "/usr/bin/true");
  assertEquals(record.timezone, null);
  assertEquals(record.isEnabled, true);
  assertEquals(record.concurrencyPolicy, "forbid");
  assertEquals(record.timeoutSeconds, null);
  assertEquals(record.createdAt, "2020-01-01T00:00:00.000Z");
  assertEquals(record.updatedAt, "2020-01-01T00:00:00.000Z");
});

test("sortTaskRecords orders via localeCompare", () => {
  const sorted = sortTaskRecords([
    serializeTask(taskRow({ id: "2", name: "zeta" })),
    serializeTask(taskRow({ id: "1", name: "alpha" })),
  ]);
  assertEquals(sorted.map((row) => row.name), ["alpha", "zeta"]);
});

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

function createTaskDb(opts?: {
  taskRows?: ReturnType<typeof taskRow>[];
  returningRows?: unknown[];
}): Db & {
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  deletes: number;
  selectCalls: number;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let deletes = 0;
  let selectCalls = 0;
  const taskRows = [...(opts?.taskRows ?? [])];
  const returningRows = opts?.returningRows;

  const db = {
    inserts,
    updates,
    get deletes() {
      return deletes;
    },
    get selectCalls() {
      return selectCalls;
    },
    select: () => ({
      from: (table: unknown) => {
        selectCalls += 1;
        return {
          where: () => thenableRows(table === task ? taskRows : []),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        return {
          returning: () =>
            thenableRows(
              returningRows ?? [{ id: `task-${String(inserts.length)}` }],
            ),
        };
      },
    }),
    update: () => ({
      set: (fields: Record<string, unknown>) => {
        updates.push(fields);
        return {
          where: () => Promise.resolve(),
        };
      },
    }),
    delete: () => {
      deletes += 1;
      return {
        where: () => thenableRows([]),
      };
    },
  };

  return db as unknown as Db & {
    inserts: Array<Record<string, unknown>>;
    updates: Array<Record<string, unknown>>;
    deletes: number;
    selectCalls: number;
  };
}

test("listTasksForService sorts via localeCompare", async () => {
  const db = createTaskDb({
    taskRows: [
      taskRow({ id: "2", name: "zeta" }),
      taskRow({ id: "1", name: "alpha" }),
    ],
  });
  const records = await listTasksForService(db, serviceId);
  assertEquals(records.map((row) => row.name), ["alpha", "zeta"]);
});

test("listTasksForServices sorts via localeCompare", async () => {
  const db = createTaskDb({
    taskRows: [
      taskRow({ id: "2", name: "zeta" }),
      taskRow({ id: "1", name: "alpha" }),
    ],
  });
  const records = await listTasksForServices(db, [serviceId]);
  assertEquals(records.map((row) => row.name), ["alpha", "zeta"]);
});

test("listTasksForServices short-circuits an empty service list without querying", async () => {
  const db = createTaskDb();
  const records = await listTasksForServices(db, []);
  assertEquals(records, []);
  assertEquals(db.selectCalls, 0);
});

test("getTask returns a serialized row or null", async () => {
  const present = createTaskDb({
    taskRows: [taskRow({ id: "1", name: "nightly" })],
  });
  const found = await getTask(present, "1");
  assertEquals(found?.id, "1");
  assertEquals(found?.name, "nightly");
  assertEquals(found?.serviceId, serviceId);

  const missing = createTaskDb({ taskRows: [] });
  assertEquals(await getTask(missing, "1"), null);
});

test("createTask stores a normalized name and omits undefined optional fields", async () => {
  const db = createTaskDb();
  const created = await createTask(db, {
    serviceId,
    name: "  nightly  ",
    schedule: "0 * * * *",
    command: "/usr/bin/true",
  });
  assertEquals(created.id, "task-1");
  assertEquals(db.inserts[0]?.name, "nightly");
  assertEquals(db.inserts[0]?.serviceId, serviceId);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "timezone"), false);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "isEnabled"), false);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "concurrencyPolicy"), false);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "timeoutSeconds"), false);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "metadata"), false);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "options"), false);
});

test("createTask persists optional fields including null timezone and timeout", async () => {
  const db = createTaskDb();
  await createTask(db, {
    serviceId,
    name: "hourly",
    schedule: "0 * * * *",
    command: "/usr/bin/true",
    timezone: null,
    isEnabled: false,
    concurrencyPolicy: "allow",
    timeoutSeconds: null,
    metadata: { owner: "ops" },
    options: { retries: 1 },
  });
  assertEquals(db.inserts[0]?.timezone, null);
  assertEquals(db.inserts[0]?.isEnabled, false);
  assertEquals(db.inserts[0]?.concurrencyPolicy, "allow");
  assertEquals(db.inserts[0]?.timeoutSeconds, null);
  assertEquals(db.inserts[0]?.metadata, { owner: "ops" });
  assertEquals(db.inserts[0]?.options, { retries: 1 });
});

test("createTask skips null metadata and options", async () => {
  const db = createTaskDb();
  await createTask(db, {
    serviceId,
    name: "weekly",
    schedule: "0 0 * * 0",
    command: "/usr/bin/true",
    metadata: null,
    options: null,
  });
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "metadata"), false);
  assertEquals(Object.hasOwn(db.inserts[0] ?? {}, "options"), false);
});

test("createTask rejects an insert that returns no row", async () => {
  const db = createTaskDb({ returningRows: [] });
  await assertRejects(
    () =>
      createTask(db, {
        serviceId,
        name: "nightly",
        schedule: "0 * * * *",
        command: "/usr/bin/true",
      }),
    TypeError,
    "task insert returned no row",
  );
});

test("updateTask stores a normalized rename", async () => {
  const db = createTaskDb();
  await updateTask(db, "1", {
    name: "  staging  ",
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  assertEquals(db.updates.length, 1);
  assertEquals(db.updates[0]?.name, "staging");
});

test("updateTask rejects invalid rename names", async () => {
  const db = createTaskDb();
  await assertRejects(
    () =>
      updateTask(db, "1", {
        name: "a\nb",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    TypeError,
    "Invalid request",
  );
  assertEquals(db.updates.length, 0);
});

test("deleteTask and countTasksForService hit the task table", async () => {
  const db = createTaskDb({
    taskRows: [
      taskRow({ id: "1", name: "a" }),
      taskRow({ id: "2", name: "b" }),
    ],
  });
  await deleteTask(db, "1");
  assertEquals(db.deletes, 1);
  assertEquals(await countTasksForService(db, serviceId), 2);
});

test("isTaskUniqueViolation matches only 23505 naming uniq_task_service_name", () => {
  const named = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "uniq_task_service_name"',
    ),
    { code: "23505" },
  );
  assertEquals(isTaskUniqueViolation(named), true);

  const otherUnique = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "uniq_tag_organization_name"',
    ),
    { code: "23505" },
  );
  assertEquals(isTaskUniqueViolation(otherUnique), false);

  assertEquals(
    isTaskUniqueViolation({ code: "23503", message: "uniq_task_service_name" }),
    false,
  );
  assertEquals(isTaskUniqueViolation(null), false);
});
