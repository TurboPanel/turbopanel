/**
 * Host-free coverage for Organization CA leaf renewal sweep
 * (batch size, keyset cursor, lease CAS, org-agnostic due query).
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import { tlsLeaf } from "../../lib/db/schema.ts";
import {
  endLeafRenewalSweep,
  isTlsLeafDue,
  LEAF_RENEWAL_BATCH_SIZE,
  LEAF_RENEWAL_REMAINING_MS,
  LEAF_RENEWAL_SWEEP_LEASE_MS,
  LEAF_RENEWAL_SWEEP_LOCK_KEY,
  leafRenewalDeadlineIso,
  loadDueTlsLeaves,
  runLeafRenewalSweepTick,
  tryBeginLeafRenewalSweep,
  type DueTlsLeafRow,
  type LeafRenewalCursor,
  type LeafRenewalSweepDeps,
} from "./leaf-renewal-sweep.ts";
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from "../../lib/tls/self-signed.ts";
import { ROTATION_FANOUT_BATCH_SIZE } from "./rotation-fanout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type SweepLockValue = {
  owner: string;
  expiresAt: string;
  cursor?: LeafRenewalCursor | null;
};

type RecordedDueQuery = {
  from: unknown;
  joins: string[];
  usedOffset: boolean;
  limit: number | null;
  orderByCount: number;
};

function applySweepLockUpdate(
  lock: { current: SweepLockValue | null },
  row: { value: SweepLockValue },
): Promise<{ key: string }[]> {
  if (lock.current === null) return Promise.resolve([]);
  const expires = Date.parse(lock.current.expiresAt);
  const expired = !Number.isFinite(expires) || expires <= Date.now();
  const stealable = lock.current.owner.length === 0 || expired;
  const sameOwner = row.value.owner === lock.current.owner;
  const releasing = row.value.owner.length === 0;
  if (!stealable && !sameOwner && !releasing) {
    return Promise.resolve([]);
  }
  lock.current = row.value;
  return Promise.resolve([{ key: LEAF_RENEWAL_SWEEP_LOCK_KEY }]);
}

function thenableRows(rows: Promise<{ key: string }[]>) {
  return Object.assign(rows, { returning: () => rows });
}

function createSweepLockMemoryDb(initial?: SweepLockValue): Db {
  const lock = { current: initial ?? null };

  return {
    insert: () => ({
      values: (row: { key: string; value: SweepLockValue }) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (lock.current !== null) return Promise.resolve([]);
            lock.current = row.value;
            return Promise.resolve([{ key: row.key }]);
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(lock.current ? [{ value: lock.current }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (row: { value: SweepLockValue }) => ({
        where: () => thenableRows(applySweepLockUpdate(lock, row)),
      }),
    }),
    delete: () => ({
      where: () => {
        lock.current = null;
        return Promise.resolve([]);
      },
    }),
  } as unknown as Db;
}

function recordingDueQueryDb(
  recorded: RecordedDueQuery,
): Db {
  const limitResult = Promise.resolve([]);
  const ordered = {
    limit: (n: number) => {
      recorded.limit = n;
      return limitResult;
    },
    offset: () => {
      recorded.usedOffset = true;
      return limitResult;
    },
  };
  const filtered = {
    orderBy: (..._args: unknown[]) => {
      recorded.orderByCount += 1;
      return ordered;
    },
    offset: () => {
      recorded.usedOffset = true;
      return limitResult;
    },
  };
  const joined = {
    leftJoin: () => {
      recorded.joins.push("leftJoin");
      return joined;
    },
    innerJoin: () => {
      recorded.joins.push("innerJoin");
      return joined;
    },
    where: () => filtered,
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        recorded.from = table;
        return joined;
      },
    }),
  } as unknown as Db;
}

test("LEAF_RENEWAL_BATCH_SIZE is pinned like rotation fan-out", () => {
  assertEquals(LEAF_RENEWAL_BATCH_SIZE, 10);
  assertEquals(LEAF_RENEWAL_BATCH_SIZE, ROTATION_FANOUT_BATCH_SIZE);
});

test("renewal window is issued lifetime / 3 of the 90-day mint default", () => {
  assertEquals(ORGANIZATION_CA_LEAF_VALID_DAYS, 90);
  assertEquals(LEAF_RENEWAL_REMAINING_MS, 90 * 86_400_000 / 3);
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  assertEquals(
    leafRenewalDeadlineIso(nowMs),
    new Date(nowMs + LEAF_RENEWAL_REMAINING_MS).toISOString(),
  );
});

test("isTlsLeafDue is true inside the remaining-lifetime window", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const soon = new Date(nowMs + LEAF_RENEWAL_REMAINING_MS - 1).toISOString();
  assertEquals(
    isTlsLeafDue({
      notAfterIso: soon,
      caGeneration: 1,
      activeCaGeneration: 1,
      nowMs,
    }),
    true,
  );
  const later = new Date(nowMs + LEAF_RENEWAL_REMAINING_MS + 1).toISOString();
  assertEquals(
    isTlsLeafDue({
      notAfterIso: later,
      caGeneration: 1,
      activeCaGeneration: 1,
      nowMs,
    }),
    false,
  );
});

test("isTlsLeafDue is true when caGeneration does not match the active signer", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const later = new Date(nowMs + 80 * 86_400_000).toISOString();
  assertEquals(
    isTlsLeafDue({
      notAfterIso: later,
      caGeneration: 1,
      activeCaGeneration: 2,
      nowMs,
    }),
    true,
  );
});

test("loadDueTlsLeaves is a single indexed keyset query (never OFFSET, never per-org enumeration)", async () => {
  const recorded: RecordedDueQuery = {
    from: null,
    joins: [],
    usedOffset: false,
    limit: null,
    orderByCount: 0,
  };
  await loadDueTlsLeaves(recordingDueQueryDb(recorded), {
    cursor: {
      notAfter: "2026-01-01T00:00:00.000Z",
      id: "11111111-1111-4111-8111-111111111111",
    },
  });
  assertEquals(recorded.from, tlsLeaf);
  assertEquals(recorded.joins.includes("leftJoin"), true);
  assertEquals(recorded.usedOffset, false);
  assertEquals(recorded.limit, LEAF_RENEWAL_BATCH_SIZE);
  assertEquals(recorded.orderByCount, 1);
});

test("tryBeginLeafRenewalSweep is exclusive until end", async () => {
  const db = createSweepLockMemoryDb();
  const first = await tryBeginLeafRenewalSweep(db);
  assertEquals(first !== null, true);
  assertEquals(await tryBeginLeafRenewalSweep(db), null);
  await endLeafRenewalSweep(db, first!);
  assertEquals((await tryBeginLeafRenewalSweep(db)) !== null, true);
});

test("tryBeginLeafRenewalSweep allows only one of two concurrent callers", async () => {
  const db = createSweepLockMemoryDb();
  const [first, second] = await Promise.all([
    tryBeginLeafRenewalSweep(db),
    tryBeginLeafRenewalSweep(db),
  ]);
  const held = [first, second].filter((lock) => lock !== null);
  assertEquals(held.length, 1);
  await endLeafRenewalSweep(db, held[0]!);
});

test("tryBeginLeafRenewalSweep steals an expired lease", async () => {
  const db = createSweepLockMemoryDb({
    owner: "stale-owner",
    expiresAt: new Date(Date.now() - LEAF_RENEWAL_SWEEP_LEASE_MS).toISOString(),
  });
  const stolen = await tryBeginLeafRenewalSweep(db);
  assertEquals(stolen !== null, true);
  assertEquals(await tryBeginLeafRenewalSweep(db), null);
});

function afterCursor(
  rows: DueTlsLeafRow[],
  cursor: LeafRenewalCursor | null,
): DueTlsLeafRow[] {
  const sorted = [...rows].sort((a, b) => {
    const byNotAfter = a.notAfter.localeCompare(b.notAfter);
    if (byNotAfter !== 0) return byNotAfter;
    return a.id.localeCompare(b.id);
  });
  if (!cursor) return sorted;
  return sorted.filter((row) => {
    if (row.notAfter > cursor.notAfter) return true;
    return row.notAfter === cursor.notAfter && row.id > cursor.id;
  });
}

function createResumableSweepMemoryDb(leaves: DueTlsLeafRow[]): {
  db: Db;
  currentCursor: () => LeafRenewalCursor | null;
} {
  const lock = { current: null as SweepLockValue | null };

  const db = {
    insert: () => ({
      values: (row: { key: string; value: SweepLockValue }) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (lock.current !== null) return Promise.resolve([]);
            lock.current = row.value;
            return Promise.resolve([{ key: row.key }]);
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => {
        if (table === tlsLeaf) {
          return {
            leftJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: (n: number) => {
                    const cursor = lock.current &&
                        typeof lock.current.cursor === "object"
                      ? lock.current.cursor ?? null
                      : null;
                    const validCursor = cursor &&
                        typeof cursor.notAfter === "string" &&
                        typeof cursor.id === "string"
                      ? cursor
                      : null;
                    return Promise.resolve(
                      afterCursor(leaves, validCursor).slice(0, n),
                    );
                  },
                }),
              }),
            }),
          };
        }
        return {
          where: () => ({
            limit: () =>
              Promise.resolve(
                lock.current ? [{ value: lock.current }] : [],
              ),
          }),
        };
      },
    }),
    update: () => ({
      set: (row: { value: SweepLockValue }) => ({
        where: () => thenableRows(applySweepLockUpdate(lock, row)),
      }),
    }),
    delete: () => ({
      where: () => {
        lock.current = null;
        return Promise.resolve([]);
      },
    }),
  } as unknown as Db;

  return {
    db,
    currentCursor: () => {
      const cursor = lock.current?.cursor;
      if (!cursor || typeof cursor !== "object") return null;
      if (typeof cursor.notAfter !== "string" || typeof cursor.id !== "string") {
        return null;
      }
      return cursor;
    },
  };
}

test("runLeafRenewalSweepTick resumes past permanently failing earliest rows", async () => {
  const early: DueTlsLeafRow = {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    serverId: "server-early",
    kind: "unknown",
    managedId: null,
    nodeId: null,
    caGeneration: 1,
    notAfter: "2026-01-01T00:00:00.000Z",
  };
  const later: DueTlsLeafRow = {
    id: "22222222-2222-4222-8222-222222222222",
    organizationId: "org-1",
    serverId: "server-later",
    kind: "unknown",
    managedId: null,
    nodeId: null,
    caGeneration: 1,
    notAfter: "2026-01-02T00:00:00.000Z",
  };
  const { db, currentCursor } = createResumableSweepMemoryDb([early, later]);
  const commandQueue = {
    enqueue: () => Promise.resolve(),
  } as unknown as CommandQueue;
  const deps = {
    secretsConfig: {},
    dataEncryptionSecrets: {},
  } as unknown as LeafRenewalSweepDeps;

  const first = await runLeafRenewalSweepTick(db, commandQueue, deps, {
    limit: 1,
  });
  if ("skipped" in first) {
    throw new TypeError("expected first tick to hold the lease");
  }
  assertEquals(first.scanned, 1);
  assertEquals(first.failed, 1);
  assertEquals(first.completed, false);
  assertEquals(first.cursor?.id, early.id);
  assertEquals(currentCursor()?.id, early.id);

  const second = await runLeafRenewalSweepTick(db, commandQueue, deps, {
    limit: 1,
  });
  if ("skipped" in second) {
    throw new TypeError("expected second tick to resume from the stored cursor");
  }
  assertEquals(second.scanned, 1);
  assertEquals(second.cursor?.id, later.id);
  assertEquals(currentCursor()?.id, later.id);
});
