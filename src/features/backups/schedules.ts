/**
 * Backup policy schedules: what the API accepts, what `retention.schedule`
 * stores, and what a host is sent.
 *
 * The API takes either a preset (`hourly`, `daily` at a time, `weekly` on a
 * day at a time) or raw cron text. Presets are stored **as cron**
 * (`0 * * * *`, `<m> <h> * * *`, `<m> <h> * * <dow>`), so `schedule` always
 * holds one unambiguous form, and {@link describeBackupSchedule} reads a preset
 * back out of it for display. Hosts never parse cron: the schedule is
 * translated to a systemd `OnCalendar` value when pushed
 * ({@link translateBackupSchedule}).
 */

import { ON_CALENDAR_RE } from '../../contracts/commands/schemas.ts'
import { cronToOnCalendar } from '../deploy/cron.ts'
import { isAllowedTimezone } from '../../lib/timezones.ts'

export type BackupSchedulePreset =
  | { preset: 'hourly' }
  | { preset: 'daily'; time: string }
  | { preset: 'weekly'; day: BackupWeekday; time: string }

export const BACKUP_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export type BackupWeekday = (typeof BACKUP_WEEKDAYS)[number]

export type BackupScheduleResult<T> = { ok: true; value: T } | { ok: false; error: string }

const TIME_RE = /^(\d{1,2}):(\d{2})$/
const DAILY_CRON_RE = /^(\d{1,2}) (\d{1,2}) \* \* \*$/
const WEEKLY_CRON_RE = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/
const HOURLY_CRON = '0 * * * *'

function fail<T>(error: string): BackupScheduleResult<T> {
  return { ok: false, error }
}

/** `HH:MM` (24-hour) to minute and hour, or null when out of range. */
function parseTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== 'string') return null
  const match = TIME_RE.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function isWeekday(value: unknown): value is BackupWeekday {
  return typeof value === 'string' && (BACKUP_WEEKDAYS as readonly string[]).includes(value)
}

function presetToCron(input: Record<string, unknown>): BackupScheduleResult<string> {
  if (input.preset === 'hourly') return { ok: true, value: HOURLY_CRON }
  if (input.preset !== 'daily' && input.preset !== 'weekly') {
    return fail('preset must be hourly, daily, or weekly')
  }
  const time = parseTime(input.time)
  if (!time) return fail('time must be HH:MM on a 24-hour clock')
  if (input.preset === 'daily') {
    return { ok: true, value: `${time.minute} ${time.hour} * * *` }
  }
  if (!isWeekday(input.day)) return fail(`day must be one of ${BACKUP_WEEKDAYS.join(', ')}`)
  return {
    ok: true,
    value: `${time.minute} ${time.hour} * * ${BACKUP_WEEKDAYS.indexOf(input.day)}`,
  }
}

/**
 * The schedule as stored: a preset object becomes its cron form; a string is
 * kept as authored (trimmed). Whether it is a schedule a host can run is
 * checked separately by {@link translateBackupSchedule}.
 */
export function normalizeBackupScheduleInput(input: unknown): BackupScheduleResult<string> {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    return trimmed.length > 0 ? { ok: true, value: trimmed } : fail('a schedule is required')
  }
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return presetToCron(input as Record<string, unknown>)
  }
  return fail('schedule must be cron text or a preset object')
}

/** Read a preset back out of a stored schedule; null for any other cron. */
export function describeBackupSchedule(schedule: string): BackupSchedulePreset | null {
  if (schedule === HOURLY_CRON) return { preset: 'hourly' }
  const daily = DAILY_CRON_RE.exec(schedule)
  if (daily) {
    const minute = Number(daily[1])
    const hour = Number(daily[2])
    if (hour <= 23 && minute <= 59) return { preset: 'daily', time: formatTime(hour, minute) }
    return null
  }
  const weekly = WEEKLY_CRON_RE.exec(schedule)
  if (!weekly) return null
  const minute = Number(weekly[1])
  const hour = Number(weekly[2])
  const day = BACKUP_WEEKDAYS[Number(weekly[3])]
  if (hour > 23 || minute > 59 || !day) return null
  return { preset: 'weekly', day, time: formatTime(hour, minute) }
}

/**
 * A stored timezone must be a real IANA zone; null means the host's local
 * time. `UTC` is accepted explicitly: `Intl.supportedValuesOf('timeZone')`
 * (behind {@link isAllowedTimezone}) lists canonical region zones only and
 * leaves it out, though systemd reads it fine.
 */
export function isValidBackupTimezone(timezone: unknown): timezone is string {
  return timezone === 'UTC' || isAllowedTimezone(timezone)
}

/**
 * Translate a stored schedule to the `OnCalendar` value a host is sent, and
 * refuse anything the `server.backups.reconcile` contract would reject (a
 * zone name with `+`, for example), so a bad schedule is caught when it is
 * written, not when it is pushed.
 */
export function translateBackupSchedule(
  schedule: string,
  timezone: string | null
): BackupScheduleResult<string> {
  const translated = cronToOnCalendar(schedule, timezone)
  if (!translated.ok) return translated
  if (!ON_CALENDAR_RE.test(translated.value)) {
    return fail('that schedule cannot be sent to a host; choose another timezone')
  }
  return translated
}

/**
 * The automatic policy every new managed database gets: daily at 03:MM host
 * time, where MM is taken from the engine id so engines on one host do not
 * all start at the same minute.
 */
export function defaultBackupSchedule(managedId: string): string {
  const hex = managedId.replaceAll('-', '').slice(-4)
  const minute = Number.parseInt(hex, 16) % 60
  return `${Number.isNaN(minute) ? 0 : minute} 3 * * *`
}
