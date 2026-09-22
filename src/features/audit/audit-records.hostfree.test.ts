/**
 * The audit trail's two contracts: a write never fails the action it records,
 * and a read is one organization's rows, newest first.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db/connection.ts";
import {
  AUDIT_ACTIONS,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_PAGE_SIZE,
  listAuditForOrganization,
  recordAudit,
} from "./audit-records.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000a2";

function recordingDb(onInsert?: () => void): {
  db: Db;
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        onInsert?.();
        rows.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  return { db, rows };
}

test("a write records the actor, the target and the context", async () => {
  const { db, rows } = recordingDb();
  await recordAudit(db, {
    organizationId: ORG,
    actorUserId: USER,
    actorEmail: "owner@example.com",
    action: "server.daemon_key.revoke",
    targetType: "server",
    targetId: "00000000-0000-4000-8000-0000000000a3",
    context: { purged: true },
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0], {
    organizationId: ORG,
    actorUserId: USER,
    actorEmail: "owner@example.com",
    action: "server.daemon_key.revoke",
    targetType: "server",
    targetId: "00000000-0000-4000-8000-0000000000a3",
    context: { purged: true },
  });
});

test("the optional fields default to null, including an instance-wide action", async () => {
  const { db, rows } = recordingDb();
  // A superadmin editing a forge that belongs to no organization: the most
  // privileged case, and it must still be recorded.
  await recordAudit(db, {
    organizationId: null,
    action: "forge.update",
    targetType: "forge",
  });
  assertEquals(rows[0], {
    organizationId: null,
    actorUserId: null,
    actorEmail: null,
    action: "forge.update",
    targetType: "forge",
    targetId: null,
    context: null,
  });
});

test("a failed write is swallowed — an audit row never fails the action", async () => {
  // Refusing a daemon-key revoke because its audit row would not insert turns
  // an incident-response tool into an outage.
  const db = {
    insert: () => ({
      values: () =>
        Promise.reject(new Error('relation "audit" does not exist')),
    }),
  } as unknown as Db;
  await recordAudit(db, {
    organizationId: ORG,
    action: "server.delete",
    targetType: "server",
  });
  // No database at all is also not an error.
  await recordAudit(undefined, {
    organizationId: ORG,
    action: "server.delete",
    targetType: "server",
  });
});

test("the read is scoped, ordered newest first and bounded", async () => {
  const seen: Array<{ limit: number }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (limit: number) => {
              seen.push({ limit });
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    }),
  } as unknown as Db;

  await listAuditForOrganization(db, { organizationId: ORG });
  await listAuditForOrganization(db, { organizationId: ORG, limit: 10 });
  // A caller asking for more than the ceiling gets the ceiling, not an error.
  await listAuditForOrganization(db, { organizationId: ORG, limit: 10_000 });
  // And a nonsense page size still reads at least one row.
  await listAuditForOrganization(db, { organizationId: ORG, limit: 0 });
  assertEquals(seen.map((call) => call.limit), [
    AUDIT_PAGE_SIZE,
    10,
    AUDIT_MAX_PAGE_SIZE,
    1,
  ]);
});

test("every action id is a dotted lower-case verb, and they are unique", () => {
  assertEquals(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
  for (const action of AUDIT_ACTIONS) {
    assertEquals(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action),
      true,
      action,
    );
  }
});
