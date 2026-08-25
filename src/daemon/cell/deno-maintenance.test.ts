import { assertEquals } from "@std/assert";
import { createDenoMaintenanceScheduler } from "./deno-maintenance.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test(
  "hung cleanup does not suppress the next liveness maintenance tick",
  async () => {
    let livenessCount = 0;
    let resolveCleanup: () => void = () => {};
    const hungCleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const scheduler = createDenoMaintenanceScheduler({
      runLiveness: () => {
        livenessCount += 1;
        return Promise.resolve();
      },
      runCleanup: () => hungCleanup,
    });

    try {
      await scheduler.runTick();
      assertEquals(livenessCount, 1);
      await scheduler.runTick();
      assertEquals(livenessCount, 2);
    } finally {
      resolveCleanup();
    }
  },
);

test("overlapping liveness ticks skip while a liveness pass is in flight", async () => {
  let livenessStarted = 0;
  let livenessFinished = 0;
  let releaseLiveness: () => void = () => {};
  const holdLiveness = new Promise<void>((resolve) => {
    releaseLiveness = resolve;
  });
  const scheduler = createDenoMaintenanceScheduler({
    runLiveness: async () => {
      livenessStarted += 1;
      await holdLiveness;
      livenessFinished += 1;
    },
    runCleanup: () => Promise.resolve(),
  });

  const first = scheduler.runTick();
  const waitUntil = Date.now() + 2_000;
  while (livenessStarted === 0 && Date.now() < waitUntil) {
    await Promise.resolve();
  }
  assertEquals(livenessStarted, 1);

  await scheduler.runTick();
  assertEquals(livenessStarted, 1);
  assertEquals(livenessFinished, 0);

  releaseLiveness();
  await first;
  assertEquals(livenessFinished, 1);
});
