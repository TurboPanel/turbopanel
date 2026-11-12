/**
 * Times in words for messages people read: a wait as "about 2 hours" and a
 * moment as "Nov 1, 2026, 14:00 UTC", never a raw ISO timestamp. Built by
 * hand rather than through `Intl`, so the text is the same on every runtime
 * (no locale data, no special spaces).
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

function counted(amount: number, one: string, many: string): string {
  return amount === 1 ? `about ${one}` : `about ${amount} ${many}`
}

/** A wait, rounded to the nearest minute, hour or day: "about 5 minutes", "about an hour". */
export function aboutWait(ms: number): string {
  if (ms < MINUTE_MS) return 'less than a minute'
  if (ms < 90 * MINUTE_MS) return counted(Math.round(ms / MINUTE_MS), 'a minute', 'minutes')
  if (ms < 36 * HOUR_MS) return counted(Math.round(ms / HOUR_MS), 'an hour', 'hours')
  return counted(Math.round(ms / DAY_MS), 'a day', 'days')
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** A moment in UTC, to the minute: "Nov 1, 2026, 14:05 UTC". */
export function utcMoment(at: Date): string {
  const month = MONTHS[at.getUTCMonth()]
  const time = `${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())}`
  return `${month} ${at.getUTCDate()}, ${at.getUTCFullYear()}, ${time} UTC`
}
