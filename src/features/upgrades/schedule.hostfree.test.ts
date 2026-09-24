import { assertEquals } from "@std/assert";
import {
  DEFAULT_UPGRADE_SETTINGS,
  type UpgradeSettings,
} from "../settings/upgrade-settings.ts";
import { isWithinMaintenanceWindow, shouldAutoStartRun } from "./schedule.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function window(
  overrides: Partial<UpgradeSettings["maintenanceWindow"]> = {},
): UpgradeSettings["maintenanceWindow"] {
  return {
    enabled: true,
    startMinute: 0,
    durationMinutes: 60,
    weekdays: [],
    ...overrides,
  };
}

test("a disabled window imposes no restriction", () => {
  assertEquals(
    isWithinMaintenanceWindow(
      window({ enabled: false }),
      new Date("2026-01-01T05:00:00Z"),
    ),
    true,
  );
});

test("a same-day window opens and closes on the minute", () => {
  // 02:00–03:00 UTC.
  const w = window({ startMinute: 120, durationMinutes: 60 });
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-01T02:00:00Z")),
    true,
  );
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-01T02:59:00Z")),
    true,
  );
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-01T03:00:00Z")),
    false,
  );
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-01T01:59:00Z")),
    false,
  );
});

test("a window that wraps past midnight stays open into the next day", () => {
  // 23:00 for 120 min → until 01:00 the next day.
  const w = window({ startMinute: 23 * 60, durationMinutes: 120 });
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-01T23:30:00Z")),
    true,
  );
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-02T00:30:00Z")),
    true,
  );
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-02T01:30:00Z")),
    false,
  );
});

test("weekdays gate when the window opens", () => {
  // 2026-01-01 is a Thursday (day 4); allow only Thursday.
  const w = window({ startMinute: 0, durationMinutes: 60, weekdays: [4] });
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-01T00:30:00Z")),
    true,
  );
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-02T00:30:00Z")),
    false,
  );
});

test("a wrapping window opened on an allowed weekday stays open past midnight", () => {
  // Opens Thursday 23:00 for 120 min; still open Friday 00:30 even though
  // Friday is not in the weekday set.
  const w = window({
    startMinute: 23 * 60,
    durationMinutes: 120,
    weekdays: [4],
  });
  assertEquals(
    isWithinMaintenanceWindow(w, new Date("2026-01-02T00:30:00Z")),
    true,
  );
});

test("shouldAutoStartRun: self-hosted honours autoUpdate; Workers always", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const base = { now, targetDiffers: true, runActive: false };
  const off = DEFAULT_UPGRADE_SETTINGS;
  const on: UpgradeSettings = { ...off, autoUpdate: true };

  assertEquals(
    shouldAutoStartRun({ ...base, runtime: "deno", settings: off }),
    false,
  );
  assertEquals(
    shouldAutoStartRun({ ...base, runtime: "deno", settings: on }),
    true,
  );
  assertEquals(
    shouldAutoStartRun({ ...base, runtime: "workers", settings: off }),
    true,
  );
});

test("shouldAutoStartRun: never on no drift, an active run, or outside the window", () => {
  const now = new Date("2026-01-01T05:00:00Z");
  const on: UpgradeSettings = { ...DEFAULT_UPGRADE_SETTINGS, autoUpdate: true };
  assertEquals(
    shouldAutoStartRun({
      runtime: "workers",
      settings: on,
      now,
      targetDiffers: false,
      runActive: false,
    }),
    false,
  );
  assertEquals(
    shouldAutoStartRun({
      runtime: "workers",
      settings: on,
      now,
      targetDiffers: true,
      runActive: true,
    }),
    false,
  );
  const windowed: UpgradeSettings = {
    ...on,
    maintenanceWindow: {
      enabled: true,
      startMinute: 0,
      durationMinutes: 60,
      weekdays: [],
    },
  };
  // 05:00 is outside 00:00–01:00.
  assertEquals(
    shouldAutoStartRun({
      runtime: "deno",
      settings: windowed,
      now,
      targetDiffers: true,
      runActive: false,
    }),
    false,
  );
});
