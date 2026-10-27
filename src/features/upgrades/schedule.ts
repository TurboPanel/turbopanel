/**
 * Pure scheduling decisions for automatic runs. Host-free: the clock and the
 * random draw are passed in.
 *
 * Updates are always automatic. Each install checks for a new build once an
 * hour, at its own minute of the hour (`UpgradeCheckSchedule.minute`, drawn at
 * random once and stored), so thousands of installs never ask the release
 * servers at the same minute. A check starts a run only when the target differs
 * from what is installed, no run is active, and an administrator has not paused
 * updates. The orchestrator never replaces a run in progress; the next run
 * targets the newest build.
 */

const MINUTE_MS = 60_000

/** The stored check slot (`UPGRADE_CHECK` setting row). */
export type UpgradeCheckSchedule = {
  /** Minute of the hour (UTC, 0–59) this install checks at. */
  minute: number
  /** When the row was created; the hour clock starts here before the first check. */
  createdAt: string
  /** When the last scheduled check ran, or null before the first one. */
  lastCheckAt: string | null
  /**
   * When an administrator last pressed Check Now. It refreshes what is
   * waiting but never moves the schedule, so the next scheduled check (which
   * starts the update) stays where it was.
   */
  lastManualCheckAt?: string | null
}

/** Check Now may run at most this often per install. */
export const UPGRADE_MANUAL_CHECK_MIN_GAP_MS = 60_000

/** A stable minute of the hour from a draw in [0, 1). Out-of-range draws clamp. */
export function pickUpgradeCheckMinute(draw: number): number {
  if (!Number.isFinite(draw) || draw <= 0) return 0
  return Math.min(59, Math.floor(draw * 60))
}

/**
 * The first slot after `anchorMs`. Slots repeat every `intervalMinutes` (a
 * divisor of 60) at this install's minute: hourly at `minute`, or for a
 * shorter interval at every minute congruent to it.
 */
function slotAfter(anchorMs: number, minute: number, intervalMinutes: number): number {
  const period = Math.min(Math.max(intervalMinutes, 1), 60) * MINUTE_MS
  const offset = (minute % (period / MINUTE_MS)) * MINUTE_MS
  const slot = Math.floor((anchorMs - offset) / period) * period + offset
  return slot > anchorMs ? slot : slot + period
}

function parsedMs(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? '')
  return Number.isFinite(ms) ? ms : null
}

/**
 * The next time this install checks: the first slot (its minute of the hour)
 * after the last check, or after the row was created before any check. An
 * anchor in the future (clock moved back) counts as now, so the schedule never
 * stalls for longer than an hour.
 */
export function nextUpgradeCheckAt(
  schedule: UpgradeCheckSchedule,
  now: Date,
  intervalMinutes = 60
): Date {
  const nowMs = now.getTime()
  const anchor = parsedMs(schedule.lastCheckAt) ?? parsedMs(schedule.createdAt) ?? nowMs
  return new Date(slotAfter(Math.min(anchor, nowMs), schedule.minute, intervalMinutes))
}

/**
 * True when the check is due. A slot that a tick overshot (the Workers upgrade
 * tick runs every few minutes, the self-hosted loop every minute) is caught up
 * on the first tick after it; the next slot is then an hour on.
 */
export function isUpgradeCheckDue(
  schedule: UpgradeCheckSchedule,
  now: Date,
  intervalMinutes = 60
): boolean {
  return now.getTime() >= nextUpgradeCheckAt(schedule, now, intervalMinutes).getTime()
}

/** The latest check of either kind, for the status read. */
export function latestUpgradeCheckAt(schedule: UpgradeCheckSchedule): string | null {
  const scheduled = parsedMs(schedule.lastCheckAt)
  const manual = parsedMs(schedule.lastManualCheckAt)
  if (manual !== null && (scheduled === null || manual > scheduled)) {
    return schedule.lastManualCheckAt ?? null
  }
  return schedule.lastCheckAt
}

/** Whole seconds until Check Now may run again; 0 when it may run now. */
export function manualCheckWaitSeconds(schedule: UpgradeCheckSchedule, now: Date): number {
  const last = parsedMs(schedule.lastManualCheckAt)
  if (last === null) return 0
  const remaining = last + UPGRADE_MANUAL_CHECK_MIN_GAP_MS - now.getTime()
  if (remaining <= 0) return 0
  // A press recorded in the future (clock moved back) waits at most one gap.
  return Math.ceil(Math.min(remaining, UPGRADE_MANUAL_CHECK_MIN_GAP_MS) / 1000)
}

export type AutoStartInput = {
  /** The channel target differs from what is installed somewhere in the fleet. */
  targetDiffers: boolean
  /** A `pending` / `running` run already exists. */
  runActive: boolean
  /** An administrator paused all updates (Admin > Updates). */
  paused: boolean
}

/**
 * Whether a check should start an automatic run. Never while paused, against
 * no drift, or while a run is active.
 */
export function shouldAutoStartRun(input: AutoStartInput): boolean {
  if (input.paused) return false
  if (input.runActive) return false
  return input.targetDiffers
}
