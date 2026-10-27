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
const HOUR_MS = 60 * MINUTE_MS

/** The stored check slot (`UPGRADE_CHECK` setting row). */
export type UpgradeCheckSchedule = {
  /** Minute of the hour (UTC, 0–59) this install checks at. */
  minute: number
  /** When the row was created; the hour clock starts here before the first check. */
  createdAt: string
  /** When the last check ran, or null before the first one. */
  lastCheckAt: string | null
}

/** A stable minute of the hour from a draw in [0, 1). Out-of-range draws clamp. */
export function pickUpgradeCheckMinute(draw: number): number {
  if (!Number.isFinite(draw) || draw <= 0) return 0
  return Math.min(59, Math.floor(draw * 60))
}

function slotAfter(anchorMs: number, minute: number): number {
  const hourStart = Math.floor(anchorMs / HOUR_MS) * HOUR_MS
  const slot = hourStart + minute * MINUTE_MS
  return slot > anchorMs ? slot : slot + HOUR_MS
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
export function nextUpgradeCheckAt(schedule: UpgradeCheckSchedule, now: Date): Date {
  const nowMs = now.getTime()
  const anchor = parsedMs(schedule.lastCheckAt) ?? parsedMs(schedule.createdAt) ?? nowMs
  return new Date(slotAfter(Math.min(anchor, nowMs), schedule.minute))
}

/**
 * True when the check is due. A slot that a tick overshot (the Workers upgrade
 * tick runs every few minutes, the self-hosted loop every minute) is caught up
 * on the first tick after it; the next slot is then an hour on.
 */
export function isUpgradeCheckDue(schedule: UpgradeCheckSchedule, now: Date): boolean {
  return now.getTime() >= nextUpgradeCheckAt(schedule, now).getTime()
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
