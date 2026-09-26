import { assert, assertEquals, assertMatch } from "@std/assert";
import type { Db } from "../../db/connection.ts";
import {
  clampUpgradePruneLimit,
  parseUpgradeStepRetentionDays,
  pruneUpgradeHistory,
  UPGRADE_PRUNE_BATCH_LIMIT,
  UPGRADE_RUN_KEEP_NEWEST,
  UPGRADE_STEP_DONE_RETENTION_DAYS,
} from "./prune.ts";
import {
  UPGRADE_STEP_ACTIVE_STATUSES,
  UPGRADE_STEP_DONE_STATUSES,
  UPGRADE_STEP_FAILURE_STATUSES,
  UPGRADE_STEP_STATUSES,
  UPGRADE_TERMINAL_STATUSES,
} from "./vocabulary.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value || typeof value !== "object") return "";
  if ("queryChunks" in value && Array.isArray(value.queryChunks)) {
    return value.queryChunks.map(sqlText).join("");
  }
  if ("value" in value) {
    const inner = value.value;
    if (typeof inner === "string" || typeof inner === "number") {
      return String(inner);
    }
    if (
      Array.isArray(inner) && inner.every((part) => typeof part === "string")
    ) {
      return inner.join("");
    }
  }
  return "";
}

function fakeDb(rowsPerDelete: unknown[][]) {
  const statements: string[] = [];
  let call = 0;
  const db = {
    delete() {
      return {
        where(condition: unknown) {
          statements.push(sqlText(condition));
          const rows = rowsPerDelete[call] ?? [];
          call += 1;
          return {
            returning: () => Promise.resolve(rows),
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, statements };
}

test("parseUpgradeStepRetentionDays falls back outside 1–3650", () => {
  assertEquals(
    parseUpgradeStepRetentionDays(undefined),
    UPGRADE_STEP_DONE_RETENTION_DAYS,
  );
  assertEquals(
    parseUpgradeStepRetentionDays("  "),
    UPGRADE_STEP_DONE_RETENTION_DAYS,
  );
  assertEquals(
    parseUpgradeStepRetentionDays("0"),
    UPGRADE_STEP_DONE_RETENTION_DAYS,
  );
  assertEquals(parseUpgradeStepRetentionDays("14"), 14);
  assertEquals(parseUpgradeStepRetentionDays("30"), 30);
  assertEquals(
    parseUpgradeStepRetentionDays("nope"),
    UPGRADE_STEP_DONE_RETENTION_DAYS,
  );
});

test("clampUpgradePruneLimit stays inside 1–1000", () => {
  assertEquals(clampUpgradePruneLimit(0), 1);
  assertEquals(
    clampUpgradePruneLimit(UPGRADE_PRUNE_BATCH_LIMIT),
    UPGRADE_PRUNE_BATCH_LIMIT,
  );
  assertEquals(clampUpgradePruneLimit(50_000), 1000);
});

test("prune status lists are subsets of the checked vocabularies", () => {
  for (const status of UPGRADE_STEP_DONE_STATUSES) {
    assert(UPGRADE_STEP_STATUSES.includes(status));
  }
  for (const status of UPGRADE_STEP_FAILURE_STATUSES) {
    assert(UPGRADE_STEP_STATUSES.includes(status));
  }
  for (const status of UPGRADE_STEP_ACTIVE_STATUSES) {
    assert(UPGRADE_STEP_STATUSES.includes(status));
  }
  const active = new Set<string>(["pending", "running"]);
  for (const status of UPGRADE_TERMINAL_STATUSES) {
    assertEquals(active.has(status), false);
  }
});

test("pruneUpgradeHistory issues three capped deletes and returns their counts", async () => {
  const { db, statements } = fakeDb([
    [{ id: "step-done" }],
    [{ id: "step-failed" }, { id: "step-rolled" }],
    [],
  ]);
  const counts = await pruneUpgradeHistory(db, {
    limit: 7,
    now: "2026-06-15T00:00:00.000Z",
    doneRetentionDays: 14,
    keepNewestRuns: UPGRADE_RUN_KEEP_NEWEST,
  });
  assertEquals(counts, { doneSteps: 1, failedSteps: 2, runs: 0 });
  assertEquals(statements.length, 3);
  assert(statements[0]?.includes("'done'"));
  assert(statements[0]?.includes("'skipped'"));
  assert(statements[0]?.includes("parent.status"));
  assert(statements[0]?.includes("'succeeded'"));
  assert(statements[0]?.includes("counts is not null"));
  assert(statements[1]?.includes("parent.status"));
  assert(statements[0]?.includes("2026-06-01T00:00:00.000Z"));
  // The batch limit closes each subquery; a bare "7" anywhere would not do.
  assertMatch(statements[0] ?? "", /limit\s+7\s*\)\s*$/);
  assertMatch(statements[1] ?? "", /limit\s+7\s*\)\s*$/);
  assert(statements[1]?.includes("'rolled_back'"));
  assert(statements[1]?.includes("'needs_attention'"));
  assert(statements[2]?.includes("'partially_failed'"));
  assertMatch(
    statements[2] ?? "",
    new RegExp(`limit\\s+${UPGRADE_RUN_KEEP_NEWEST}\\s*\\)`),
  );
  assertMatch(statements[2] ?? "", /limit\s+7\s*\)\s*$/);
});

test("the active-step index lists UPGRADE_STEP_ACTIVE_STATUSES", async () => {
  const source = await Deno.readTextFile(
    new URL("../../db/schema.ts", import.meta.url),
  );
  const at = source.indexOf("idx_upgradestep_active_next_attempt");
  assert(at >= 0);
  const slice = source.slice(at, at + 600).replaceAll(/\s+/g, "");
  const expected = UPGRADE_STEP_ACTIVE_STATUSES.map((status) => `'${status}'`)
    .join(",");
  assert(slice.includes(expected));
});
