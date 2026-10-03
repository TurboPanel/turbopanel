/**
 * Quiet hours and digest windows, as pure clock arithmetic.
 *
 * A channel's quiet hours are two minutes-of-day read in one IANA zone; a
 * digest cadence is `hourly` or `daily`. Everything here takes the instant as
 * an argument (never reads the clock) and answers with instants, so the
 * boundaries — including the two nights a year the local clock jumps — are
 * tested without waiting for them.
 *
 * Workers-bundle safe: `Intl` only, nothing evaluated at module load.
 */

export const NOTIFICATION_DIGEST_CADENCES = ['hourly', 'daily'] as const
export type NotificationDigestCadence = (typeof NOTIFICATION_DIGEST_CADENCES)[number]

/** The zone used when a person, or an organization, has not chosen one. */
export const DEFAULT_TIME_ZONE = 'UTC'

/** A daily digest closes its window at this local time (08:00). */
export const DAILY_DIGEST_MINUTE = 8 * 60

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MINUTES = 24 * 60

export type QuietHours = { startMinute: number; endMinute: number }

/**
 * Delivery timing, all optional; `null` clears. Digest and quiet hours are for
 * email channels; the zone is the signed-in owner's own and applies to their
 * personal channels.
 */
export type ChannelHoldFields = {
  digestCadence?: NotificationDigestCadence | null
  quiet?: QuietHours | null
  timeZone?: string | null
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  formatters.set(timeZone, made)
  return made
}

/** True when `Intl` knows the zone; the guard before a stored value is trusted. */
export function isUsableTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

/** `timeZone` when it is usable, else UTC: a bad stored value never breaks a sweep. */
export function usableTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isUsableTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE
}

type LocalClock = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localClock(instantMs: number, timeZone: string): LocalClock {
  const out: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/** Zone offset from UTC at an instant, in ms (positive east of Greenwich). */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const c = localClock(instantMs, timeZone)
  const wall = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second)
  return wall - Math.floor(instantMs / 1000) * 1000
}

/** The local minute-of-day (0-1439) at an instant. */
export function localMinuteOfDay(instantMs: number, timeZone: string): number {
  const c = localClock(instantMs, timeZone)
  return c.hour * 60 + c.minute
}

/**
 * The instant a wall-clock time falls on in a zone. A time the clock skips
 * (spring forward) lands the length of the gap later (02:30 reads 03:30); a
 * time the clock repeats (fall back) lands on its first occurrence.
 */
export function zonedTimeToInstant(
  wall: { year: number; month: number; day: number; minuteOfDay: number },
  timeZone: string
): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minuteOfDay)
  const early = asUtc - zoneOffsetMs(asUtc - 14 * HOUR_MS, timeZone)
  const late = asUtc - zoneOffsetMs(asUtc + 14 * HOUR_MS, timeZone)
  // Both guesses agree away from a transition. Around one, the earlier guess
  // is right when it really reads back as this wall time, else the later one.
  const earlyReads = localMinuteOfDay(early, timeZone) === wall.minuteOfDay
  const lateReads = localMinuteOfDay(late, timeZone) === wall.minuteOfDay
  if (earlyReads && lateReads) return Math.min(early, late)
  if (earlyReads) return early
  if (lateReads) return late
  // The time does not exist: shift it forward by the gap.
  return Math.max(early, late)
}

/** True when the instant falls inside the quiet window (which may wrap midnight). */
export function inQuietHours(instantMs: number, timeZone: string, quiet: QuietHours): boolean {
  const minute = localMinuteOfDay(instantMs, timeZone)
  if (quiet.startMinute < quiet.endMinute) {
    return minute >= quiet.startMinute && minute < quiet.endMinute
  }
  return minute >= quiet.startMinute || minute < quiet.endMinute
}

function dailyBoundary(instantMs: number, timeZone: string): number {
  const c = localClock(instantMs, timeZone)
  const today = zonedTimeToInstant(
    { year: c.year, month: c.month, day: c.day, minuteOfDay: DAILY_DIGEST_MINUTE },
    timeZone
  )
  if (today <= instantMs) return today
  const yesterday = new Date(Date.UTC(c.year, c.month - 1, c.day - 1))
  return zonedTimeToInstant(
    {
      year: yesterday.getUTCFullYear(),
      month: yesterday.getUTCMonth() + 1,
      day: yesterday.getUTCDate(),
      minuteOfDay: DAILY_DIGEST_MINUTE,
    },
    timeZone
  )
}

/**
 * The most recent moment a digest window closed at or before `instantMs`.
 * Hourly windows close at the top of the local hour (so a half-hour zone
 * closes on the UTC half hour); daily windows close at 08:00 local.
 */
export function lastDigestBoundary(
  instantMs: number,
  timeZone: string,
  cadence: NotificationDigestCadence
): number {
  if (cadence === 'daily') return dailyBoundary(instantMs, timeZone)
  const offset = zoneOffsetMs(instantMs, timeZone)
  return Math.floor((instantMs + offset) / HOUR_MS) * HOUR_MS - offset
}

export type HoldSettings = {
  digestCadence: NotificationDigestCadence | null
  quiet: QuietHours | null
}

/** True when an event that arrives now should wait for a later send. */
export function shouldHoldNow(instantMs: number, timeZone: string, s: HoldSettings): boolean {
  if (s.digestCadence !== null) return true
  return s.quiet !== null && inQuietHours(instantMs, timeZone, s.quiet)
}

/**
 * Which held events may go out at `instantMs`: those created at or before the
 * returned instant, or null when nothing may go yet. Inside quiet hours
 * nothing goes (that is the point of them). Outside, a digest releases what
 * was held before its latest window closed; with no digest, everything is
 * released, which is how held events flush when the settings are removed.
 */
export function releaseCutoff(instantMs: number, timeZone: string, s: HoldSettings): number | null {
  if (s.quiet !== null && inQuietHours(instantMs, timeZone, s.quiet)) return null
  if (s.digestCadence === null) return instantMs
  return lastDigestBoundary(instantMs, timeZone, s.digestCadence)
}

/** "HH:MM" to minutes after midnight; null when it is not a valid 24-hour time. */
export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** Minutes after midnight to "HH:MM". */
export function formatClockMinutes(minutes: number): string {
  const clamped = Math.min(Math.max(Math.trunc(minutes), 0), DAY_MINUTES - 1)
  const h = String(Math.floor(clamped / 60)).padStart(2, '0')
  const m = String(clamped % 60).padStart(2, '0')
  return `${h}:${m}`
}
