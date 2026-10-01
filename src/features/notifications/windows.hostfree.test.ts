import { assertEquals } from '@std/assert'
import {
  formatClockMinutes,
  inQuietHours,
  lastDigestBoundary,
  parseClockMinutes,
  releaseCutoff,
  shouldHoldNow,
  usableTimeZone,
  zonedTimeToInstant,
} from './windows.ts'

const test = Deno.test.bind(Deno)

const at = (iso: string) => Date.parse(iso)
const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 }

test('clock parsing accepts 24-hour HH:MM only and round-trips', () => {
  assertEquals(parseClockMinutes('22:30'), 22 * 60 + 30)
  assertEquals(parseClockMinutes('00:00'), 0)
  assertEquals(parseClockMinutes('24:00'), null)
  assertEquals(parseClockMinutes('7:00'), null)
  assertEquals(parseClockMinutes(700), null)
  assertEquals(formatClockMinutes(22 * 60 + 5), '22:05')
})

test('a bad zone falls back to UTC', () => {
  assertEquals(usableTimeZone('Mars/Olympus'), 'UTC')
  assertEquals(usableTimeZone(null), 'UTC')
  assertEquals(usableTimeZone('Europe/Paris'), 'Europe/Paris')
})

test('quiet hours wrap midnight and are start-inclusive, end-exclusive', () => {
  assertEquals(inQuietHours(at('2026-03-01T21:59:00Z'), 'UTC', NIGHT), false)
  assertEquals(inQuietHours(at('2026-03-01T22:00:00Z'), 'UTC', NIGHT), true)
  assertEquals(inQuietHours(at('2026-03-02T06:59:00Z'), 'UTC', NIGHT), true)
  assertEquals(inQuietHours(at('2026-03-02T07:00:00Z'), 'UTC', NIGHT), false)
  // A same-day window does not wrap.
  const lunch = { startMinute: 12 * 60, endMinute: 13 * 60 }
  assertEquals(inQuietHours(at('2026-03-02T12:30:00Z'), 'UTC', lunch), true)
  assertEquals(inQuietHours(at('2026-03-02T13:00:00Z'), 'UTC', lunch), false)
})

test('quiet hours are read in the zone, not in UTC', () => {
  // 03:00 UTC is 23:00 the evening before in New York (EDT, UTC-4): quiet in both.
  assertEquals(inQuietHours(at('2026-07-01T03:00:00Z'), 'America/New_York', NIGHT), true)
  // 12:00 UTC is awake time in UTC but 08:00 in New York and 21:00 in Tokyo.
  assertEquals(inQuietHours(at('2026-07-01T12:00:00Z'), 'UTC', NIGHT), false)
  // 23:00 UTC is quiet in UTC, 19:00 in New York (awake) and 08:00 in Tokyo (awake).
  assertEquals(inQuietHours(at('2026-07-01T23:00:00Z'), 'UTC', NIGHT), true)
  assertEquals(inQuietHours(at('2026-07-01T23:00:00Z'), 'America/New_York', NIGHT), false)
  assertEquals(inQuietHours(at('2026-07-01T23:00:00Z'), 'Asia/Tokyo', NIGHT), false)
  // 14:00 UTC is 23:00 in Tokyo: quiet there, awake in UTC.
  assertEquals(inQuietHours(at('2026-07-01T14:00:00Z'), 'Asia/Tokyo', NIGHT), true)
  assertEquals(inQuietHours(at('2026-07-01T14:00:00Z'), 'UTC', NIGHT), false)
})

test('a quiet window across the spring-forward night follows the wall clock', () => {
  // New York 2026-03-08: 02:00 EST jumps to 03:00 EDT. The window 22:00-07:00 is
  // still 22:00-07:00 on the wall, so it ends at 11:00 UTC (07:00 EDT), not 12:00.
  assertEquals(inQuietHours(at('2026-03-08T10:59:00Z'), 'America/New_York', NIGHT), true)
  assertEquals(inQuietHours(at('2026-03-08T11:00:00Z'), 'America/New_York', NIGHT), false)
  // The night before it ends at 12:00 UTC (07:00 EST).
  assertEquals(inQuietHours(at('2026-03-07T11:59:00Z'), 'America/New_York', NIGHT), true)
  assertEquals(inQuietHours(at('2026-03-07T12:00:00Z'), 'America/New_York', NIGHT), false)
})

test('a quiet window across the fall-back night follows the wall clock', () => {
  // New York 2026-11-01: 02:00 EDT falls back to 01:00 EST; the window ends 07:00 EST = 12:00 UTC.
  assertEquals(inQuietHours(at('2026-11-01T11:59:00Z'), 'America/New_York', NIGHT), true)
  assertEquals(inQuietHours(at('2026-11-01T12:00:00Z'), 'America/New_York', NIGHT), false)
  // The repeated 01:30 is quiet both times.
  assertEquals(inQuietHours(at('2026-11-01T05:30:00Z'), 'America/New_York', NIGHT), true)
  assertEquals(inQuietHours(at('2026-11-01T06:30:00Z'), 'America/New_York', NIGHT), true)
})

test('wall times that do not exist or repeat resolve deterministically', () => {
  const ny = 'America/New_York'
  // 02:30 on 2026-03-08 does not exist; it reads 03:30 EDT (07:30Z).
  assertEquals(
    new Date(
      zonedTimeToInstant({ year: 2026, month: 3, day: 8, minuteOfDay: 2 * 60 + 30 }, ny)
    ).toISOString(),
    '2026-03-08T07:30:00.000Z'
  )
  // 01:30 on 2026-11-01 happens twice; the first (EDT, 05:30Z) wins.
  assertEquals(
    new Date(
      zonedTimeToInstant({ year: 2026, month: 11, day: 1, minuteOfDay: 90 }, ny)
    ).toISOString(),
    '2026-11-01T05:30:00.000Z'
  )
  // An ordinary time.
  assertEquals(
    new Date(
      zonedTimeToInstant({ year: 2026, month: 7, day: 1, minuteOfDay: 8 * 60 }, ny)
    ).toISOString(),
    '2026-07-01T12:00:00.000Z'
  )
})

test('hourly windows close at the top of the local hour, including half-hour zones', () => {
  assertEquals(
    new Date(lastDigestBoundary(at('2026-05-01T10:42:11Z'), 'UTC', 'hourly')).toISOString(),
    '2026-05-01T10:00:00.000Z'
  )
  // Kolkata is UTC+5:30: its top of the hour is the UTC half hour.
  assertEquals(
    new Date(
      lastDigestBoundary(at('2026-05-01T10:42:11Z'), 'Asia/Kolkata', 'hourly')
    ).toISOString(),
    '2026-05-01T10:30:00.000Z'
  )
  assertEquals(
    new Date(
      lastDigestBoundary(at('2026-05-01T10:12:00Z'), 'Asia/Kolkata', 'hourly')
    ).toISOString(),
    '2026-05-01T09:30:00.000Z'
  )
})

test('daily windows close at 08:00 local, across both clock changes', () => {
  const ny = 'America/New_York'
  // Before 08:00 local the last close is yesterday's.
  assertEquals(
    new Date(lastDigestBoundary(at('2026-07-01T11:59:00Z'), ny, 'daily')).toISOString(),
    '2026-06-30T12:00:00.000Z'
  )
  assertEquals(
    new Date(lastDigestBoundary(at('2026-07-01T12:00:00Z'), ny, 'daily')).toISOString(),
    '2026-07-01T12:00:00.000Z'
  )
  // After spring forward 08:00 is 12:00Z; the morning before it is 13:00Z.
  assertEquals(
    new Date(lastDigestBoundary(at('2026-03-08T12:30:00Z'), ny, 'daily')).toISOString(),
    '2026-03-08T12:00:00.000Z'
  )
  assertEquals(
    new Date(lastDigestBoundary(at('2026-03-08T11:30:00Z'), ny, 'daily')).toISOString(),
    '2026-03-07T13:00:00.000Z'
  )
  // Fall back: 08:00 EST is 13:00Z on 2026-11-01.
  assertEquals(
    new Date(lastDigestBoundary(at('2026-11-01T13:05:00Z'), ny, 'daily')).toISOString(),
    '2026-11-01T13:00:00.000Z'
  )
})

test('events are held when a digest is on or quiet hours are running', () => {
  const quietOnly = { digestCadence: null, quiet: NIGHT }
  assertEquals(shouldHoldNow(at('2026-05-01T12:00:00Z'), 'UTC', quietOnly), false)
  assertEquals(shouldHoldNow(at('2026-05-01T23:00:00Z'), 'UTC', quietOnly), true)
  assertEquals(
    shouldHoldNow(at('2026-05-01T12:00:00Z'), 'UTC', { digestCadence: 'hourly', quiet: null }),
    true
  )
  assertEquals(
    shouldHoldNow(at('2026-05-01T12:00:00Z'), 'UTC', { digestCadence: null, quiet: null }),
    false
  )
})

test('release cutoff: nothing in quiet hours, the last window close otherwise, everything with no digest', () => {
  const now = at('2026-05-01T07:20:00Z')
  // Quiet only: still quiet at 06:00, released in full once it ends.
  assertEquals(
    releaseCutoff(at('2026-05-01T06:00:00Z'), 'UTC', { digestCadence: null, quiet: NIGHT }),
    null
  )
  assertEquals(releaseCutoff(now, 'UTC', { digestCadence: null, quiet: NIGHT }), now)
  // Digest and quiet: after the window ends, what was held before the latest close goes.
  assertEquals(
    new Date(releaseCutoff(now, 'UTC', { digestCadence: 'hourly', quiet: NIGHT })!).toISOString(),
    '2026-05-01T07:00:00.000Z'
  )
  assertEquals(
    releaseCutoff(at('2026-05-01T06:30:00Z'), 'UTC', { digestCadence: 'hourly', quiet: NIGHT }),
    null
  )
  // Settings removed while rows are held: everything is released.
  assertEquals(releaseCutoff(now, 'UTC', { digestCadence: null, quiet: null }), now)
})
