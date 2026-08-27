/**
 * Host-free coverage for Organization CA rotation journal lease.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import {
  CA_ROTATION_STALE_MS,
  type CaRotationJournalRow,
  loadLatestCaRotation,
  tryBeginCaRotation,
  updateCaRotationJournal,
} from "./changeover-lease.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

type StoredRow = CaRotationJournalRow & { options: null };

function orgRows(store: StoredRow[]): StoredRow[] {
  return store
    .filter((row) => row.organizationId === ORG_ID)
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.startedAt.localeCompare(a.startedAt)
    );
}

function leaseDb(store: StoredRow[]): Db {
  return {
    select: () => ({
      from: () => {
        const self = {
          where: () => self,
          orderBy: () => self,
          limit: (n: number) => Promise.resolve(orgRows(store).slice(0, n)),
        };
        return self;
      },
    }),
    insert: () => ({
      values: (values: Partial<StoredRow>) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const now = values.startedAt ?? new Date().toISOString();
            const row: StoredRow = {
              id: crypto.randomUUID(),
              organizationId: values.organizationId ?? ORG_ID,
              fromCaGeneration: values.fromCaGeneration ?? 0,
              toCaGeneration: values.toCaGeneration ?? 0,
              state: (values.state as StoredRow["state"]) ?? "in_progress",
              startedAt: now,
              completedAt: values.completedAt ?? null,
              results: values.results ?? [],
              metadata: values.metadata ?? null,
              createdAt: now,
              updatedAt: now,
              options: null,
            };
            store.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<StoredRow>) => ({
        where: () => ({
          returning: () => {
            const target = orgRows(store)[0];
            if (!target) return Promise.resolve([]);
            Object.assign(target, patch, {
              updatedAt: patch.updatedAt ?? new Date().toISOString(),
            });
            return Promise.resolve([target]);
          },
        }),
      }),
    }),
  } as unknown as Db;
}

function staleStartedAt(nowMs: number): string {
  return new Date(nowMs - CA_ROTATION_STALE_MS - 1_000).toISOString();
}

test("tryBeginCaRotation inserts an in_progress journal when none exists", async () => {
  const store: StoredRow[] = [];
  const db = leaseDb(store);
  const row = await tryBeginCaRotation(db, ORG_ID, 1_700_000_000_000);
  if (!row) throw new TypeError("expected journal row");
  assertEquals(row.state, "in_progress");
  assertEquals(row.organizationId, ORG_ID);
  assertEquals(store.length, 1);
});

test("tryBeginCaRotation returns null while awaiting_retire", async () => {
  const now = new Date().toISOString();
  const store: StoredRow[] = [{
    id: "rot-await",
    organizationId: ORG_ID,
    fromCaGeneration: 1,
    toCaGeneration: 2,
    state: "awaiting_retire",
    startedAt: now,
    completedAt: null,
    results: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    options: null,
  }];
  const row = await tryBeginCaRotation(leaseDb(store), ORG_ID);
  assertEquals(row, null);
});

test("tryBeginCaRotation returns null for a fresh in_progress lease", async () => {
  const nowMs = 1_700_000_000_000;
  const startedAt = new Date(nowMs).toISOString();
  const store: StoredRow[] = [{
    id: "rot-fresh",
    organizationId: ORG_ID,
    fromCaGeneration: 0,
    toCaGeneration: 0,
    state: "in_progress",
    startedAt,
    completedAt: null,
    results: [],
    metadata: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    options: null,
  }];
  const row = await tryBeginCaRotation(leaseDb(store), ORG_ID, nowMs);
  assertEquals(row, null);
});

test("tryBeginCaRotation resumes a minted in_progress journal without clearing progress", async () => {
  const nowMs = 1_700_000_000_000;
  const startedAt = new Date(nowMs).toISOString();
  const results = [{ serverId: "s1", kind: "apply", status: "queued" }];
  const metadata = { resumeAfterManagedId: "mid" };
  const store: StoredRow[] = [{
    id: "rot-resume",
    organizationId: ORG_ID,
    fromCaGeneration: 1,
    toCaGeneration: 2,
    state: "in_progress",
    startedAt,
    completedAt: null,
    results,
    metadata,
    createdAt: startedAt,
    updatedAt: startedAt,
    options: null,
  }];
  const row = await tryBeginCaRotation(leaseDb(store), ORG_ID, nowMs);
  if (!row) throw new TypeError("expected resumable journal row");
  assertEquals(row.id, "rot-resume");
  assertEquals(row.state, "in_progress");
  assertEquals(row.fromCaGeneration, 1);
  assertEquals(row.toCaGeneration, 2);
  assertEquals(row.results, results);
  assertEquals(row.metadata, metadata);
});

test("tryBeginCaRotation steals a stale in_progress journal that never minted", async () => {
  const nowMs = 1_700_000_000_000;
  const startedAt = staleStartedAt(nowMs);
  const store: StoredRow[] = [{
    id: "rot-stale",
    organizationId: ORG_ID,
    fromCaGeneration: 0,
    toCaGeneration: 0,
    state: "in_progress",
    startedAt,
    completedAt: null,
    results: [],
    metadata: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    options: null,
  }];
  const row = await tryBeginCaRotation(leaseDb(store), ORG_ID, nowMs);
  if (!row) throw new TypeError("expected stolen journal row");
  assertEquals(row.id, "rot-stale");
  assertEquals(row.state, "in_progress");
  assertEquals(row.fromCaGeneration, 0);
  assertEquals(row.toCaGeneration, 0);
  assertEquals(row.startedAt === startedAt, false);
  assertEquals(row.results, []);
  assertEquals(row.metadata, null);
});

test("loadLatestCaRotation and updateCaRotationJournal round-trip state", async () => {
  const now = new Date().toISOString();
  const store: StoredRow[] = [{
    id: "rot-1",
    organizationId: ORG_ID,
    fromCaGeneration: 1,
    toCaGeneration: 2,
    state: "in_progress",
    startedAt: now,
    completedAt: null,
    results: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    options: null,
  }];
  const db = leaseDb(store);
  const latest = await loadLatestCaRotation(db, ORG_ID);
  assertEquals(latest?.id, "rot-1");
  const updated = await updateCaRotationJournal(db, "rot-1", {
    state: "awaiting_retire",
    fromCaGeneration: 1,
    toCaGeneration: 2,
  });
  assertEquals(updated?.state, "awaiting_retire");
  assertEquals(store[0]?.state, "awaiting_retire");
});
