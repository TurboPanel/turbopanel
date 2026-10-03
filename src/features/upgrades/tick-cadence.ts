/**
 * How often the Workers cron advances managed upgrades.
 *
 * The cron fires every minute and each phase picks its own minute-modulo
 * window. The upgrade tick used to share the 15-minute execution-log window, so
 * a five-server rollout took over an hour. The window is now an environment
 * setting (`TURBOPANEL_UPGRADE_TICK_MINUTES`); customer environments keep the
 * 15-minute default. Batch size is a separate, stored setting (`UPGRADE_SETTINGS`,
 * edited under Admin > Updates): this module only owns the tick.
 */

export const UPGRADE_TICK_DEFAULT_MINUTES = 15

/** Only divisors of 60, so ticks stay evenly spaced within the hour. */
export const UPGRADE_TICK_ALLOWED_MINUTES: readonly number[] = [
  1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60,
]

/**
 * Parse `TURBOPANEL_UPGRADE_TICK_MINUTES`. Blank, non-numeric or a value that
 * is not one of {@link UPGRADE_TICK_ALLOWED_MINUTES} falls back to the default.
 */
export function parseUpgradeTickMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return UPGRADE_TICK_DEFAULT_MINUTES
  if (!/^\d{1,2}$/.test(raw.trim())) return UPGRADE_TICK_DEFAULT_MINUTES
  const parsed = Number.parseInt(raw.trim(), 10)
  return UPGRADE_TICK_ALLOWED_MINUTES.includes(parsed) ? parsed : UPGRADE_TICK_DEFAULT_MINUTES
}

/** True on every Nth UTC minute (isolate-independent, no stored state). */
export function shouldRunUpgradeTick(scheduledTimeMs: number, tickMinutes: number): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % tickMinutes === 0
}
