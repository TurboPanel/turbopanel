/**
 * Host-free coverage for the org-wide managed-engine network allocator
 * (`ensureOrganizationManagedNetwork`) — no Postgres.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import { ensureOrganizationManagedNetwork } from "./fabric-records.ts";
import { network } from "./schema.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "01936b3e-8c7a-7b2d-a1f0-123456789abc";

type ManagedNetworkRow = {
  id: string;
  organizationId: string;
  kind: string;
  options: Record<string, unknown> | null;
};

type ManagedDb = Db & {
  rows: ManagedNetworkRow[];
  inserts: number;
};

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: (n?: number) =>
      Promise.resolve(typeof n === "number" ? rows.slice(0, n) : rows),
    orderBy: () => thenableRows(rows),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

/**
 * Minimal `network`-only fake honouring the partial unique index: a second
 * `kind = 'managed'` insert for the same org is a no-op (`onConflictDoNothing`
 * returns no row), which is exactly the race the helper has to converge on.
 */
function createManagedDb(
  seed: ManagedNetworkRow[] = [],
  opts: { raceOnFirstLookup?: boolean } = {},
): ManagedDb {
  const rows = [...seed];
  let inserts = 0;
  let seq = rows.length;
  let pendingRace = opts.raceOnFirstLookup === true;

  const db = {
    rows,
    get inserts() {
      return inserts;
    },
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_condition?: unknown) => {
          if (pendingRace) {
            // A concurrent caller lands its row *after* this lookup reads
            // nothing — the insert below then loses the unique index.
            pendingRace = false;
            seq += 1;
            rows.push({
              id: MANAGED_ID,
              organizationId: "org-1",
              kind: "managed",
              options: { dockerNetworkName: MANAGED_ID },
            });
            return thenableRows([]);
          }
          return thenableRows(
            table === network
              ? rows.filter((row) => row.kind === "managed")
              : [],
          );
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const conflict = rows.some(
          (row) =>
            row.kind === "managed" &&
            row.organizationId === String(values.organizationId),
        );
        const run = () => {
          inserts += 1;
          if (conflict) return [];
          seq += 1;
          const record: ManagedNetworkRow = {
            id: seq === 1 ? MANAGED_ID : `${MANAGED_ID}-${seq}`,
            organizationId: String(values.organizationId),
            kind: String(values.kind),
            options: (values.options as Record<string, unknown>) ?? null,
          };
          rows.push(record);
          return [{ id: record.id }];
        };
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(run()),
          }),
          returning: () => Promise.resolve(run()),
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const last = rows.at(-1);
          if (last && patch.options) {
            last.options = {
              ...(last.options ?? {}),
              ...(patch.options as Record<string, unknown>),
            };
          }
          return thenableRows([]);
        },
      }),
    }),
  };

  return db as unknown as ManagedDb;
}

test("ensureOrganizationManagedNetwork allocates and stamps dockerNetworkName", async () => {
  const db = createManagedDb();

  const allocated = await ensureOrganizationManagedNetwork(db, {
    organizationId: "org-1",
  });

  assertEquals(allocated.id, MANAGED_ID);
  assertEquals(allocated.hostName, MANAGED_ID);
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0]?.kind, "managed");
  assertEquals(db.rows[0]?.options, { dockerNetworkName: MANAGED_ID });
});

test("ensureOrganizationManagedNetwork is idempotent for the same org", async () => {
  const db = createManagedDb();

  const first = await ensureOrganizationManagedNetwork(db, {
    organizationId: "org-1",
  });
  const second = await ensureOrganizationManagedNetwork(db, {
    organizationId: "org-1",
  });

  assertEquals(second.id, first.id);
  assertEquals(second.hostName, first.hostName);
  assertEquals(db.rows.length, 1);
  assertEquals(db.inserts, 1);
});

test("ensureOrganizationManagedNetwork honours a pinned dockerNetworkName", async () => {
  const db = createManagedDb([
    {
      id: MANAGED_ID,
      organizationId: "org-1",
      kind: "managed",
      options: { dockerNetworkName: "tp_managed_override" },
    },
  ]);

  const resolved = await ensureOrganizationManagedNetwork(db, {
    organizationId: "org-1",
  });

  assertEquals(resolved.id, MANAGED_ID);
  assertEquals(resolved.hostName, "tp_managed_override");
  assertEquals(db.inserts, 0);
});

test("ensureOrganizationManagedNetwork converges when a concurrent insert wins", async () => {
  const db = createManagedDb([], { raceOnFirstLookup: true });

  const resolved = await ensureOrganizationManagedNetwork(db, {
    organizationId: "org-1",
  });

  assertEquals(resolved.id, MANAGED_ID);
  assertEquals(resolved.hostName, MANAGED_ID);
  assertEquals(db.rows.length, 1);
  assertEquals(db.inserts, 1);
});
