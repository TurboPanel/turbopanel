import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  DB_OP_TIMEOUT_MS,
  DbOperationTimeoutError,
  runWithDbTimeout,
  type Db,
} from "./db.ts";

// The projection path never inspects the Db shape when fn ignores it, so a cast
// of a placeholder is sufficient for these timing-focused tests.
const FAKE_DB = {} as Db;

it("runWithDbTimeout resolves a fast operation", async () => {
  const result = await runWithDbTimeout(FAKE_DB, () => Promise.resolve("ok"), 1_000);
  assertEquals(result, "ok");
});

it("runWithDbTimeout rejects a hung operation before the WS lifetime", async () => {
  const start = Date.now();
  const err = await assertRejects(
    () =>
      runWithDbTimeout(
        FAKE_DB,
        // Never resolves — simulates a wedged Hyperdrive round-trip.
        () => new Promise<void>(() => {}),
        50,
      ),
    DbOperationTimeoutError,
  );
  assert(err.message.includes("50ms"));
  // Must fail fast, not run indefinitely.
  assert(Date.now() - start < 5_000);
});

it("runWithDbTimeout clears its timer so the process can exit", async () => {
  // If the timer were not cleared, Deno's op-sanitizer would fail this test.
  await runWithDbTimeout(FAKE_DB, () => Promise.resolve(42), 10_000);
});

it("runWithDbTimeout swallows a late rejection from the losing race side", async () => {
  // A hung op that later rejects must not surface as an unhandled rejection.
  await assertRejects(
    () =>
      runWithDbTimeout(
        FAKE_DB,
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late failure")), 30);
          }),
        5,
      ),
    DbOperationTimeoutError,
  );
  // Give the late rejection time to fire; the swallow-catch must absorb it.
  await new Promise((resolve) => setTimeout(resolve, 60));
});

it("DB_OP_TIMEOUT_MS is a sane hard bound", () => {
  assert(DB_OP_TIMEOUT_MS > 0);
  assert(DB_OP_TIMEOUT_MS <= 15_000);
});
