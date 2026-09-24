/**
 * Pure scheduling decisions for automatic runs. Host-free: the clock is passed.
 *
 * Automatic runs start self-hosted only when `autoUpdate` is on, and on Workers
 * always. Only inside the maintenance window (if one is set), only when the
 * target differs from what's installed, and only when no run is active — the
 * orchestrator never replaces a run in progress; the next run targets the
 * newest build.
 */
import type { UpgradeSettings } from "../settings/upgrade-settings.ts";
import type { UpgradeRuntime } from "./planner.ts";

const MINUTES_PER_DAY = 24 * 60;

/**
 * True when `now` (UTC) is inside the maintenance window. A disabled window
 * imposes no restriction (always true). A window that runs past midnight stays
 * open into the following day regardless of that day's weekday membership — the
 * weekday gates when a window *opens*, not every minute it is open.
 */
export function isWithinMaintenanceWindow(
  window: UpgradeSettings["maintenanceWindow"],
  now: Date,
): boolean {
  if (!window.enabled) return true;

  const utcDay = now.getUTCDay();
  const dayMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const weekdayAllowed = (day: number): boolean =>
    window.weekdays.length === 0 || window.weekdays.includes(day);

  // A window may have opened today (offset 0) or yesterday (offset 1) and still
  // be running now; check both candidate open days.
  for (const offset of [0, 1]) {
    const openDay = (utcDay - offset + 7) % 7;
    if (!weekdayAllowed(openDay)) continue;
    const startAbsolute = window.startMinute - offset * MINUTES_PER_DAY;
    const elapsed = dayMinute - startAbsolute;
    if (elapsed >= 0 && elapsed < window.durationMinutes) return true;
  }
  return false;
}

export type AutoStartInput = {
  runtime: UpgradeRuntime;
  settings: UpgradeSettings;
  now: Date;
  /** The channel target differs from what is installed somewhere in the fleet. */
  targetDiffers: boolean;
  /** A `pending` / `running` run already exists. */
  runActive: boolean;
};

/**
 * Whether the tick should start an automatic run this pass. Self-hosted honours
 * `autoUpdate`; Workers always auto-updates. Never starts inside no window,
 * against no drift, or while a run is active.
 */
export function shouldAutoStartRun(input: AutoStartInput): boolean {
  if (input.runActive) return false;
  if (!input.targetDiffers) return false;
  if (input.runtime === "deno" && !input.settings.autoUpdate) return false;
  return isWithinMaintenanceWindow(input.settings.maintenanceWindow, input.now);
}
