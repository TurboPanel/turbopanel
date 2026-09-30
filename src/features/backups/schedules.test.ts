import { assertEquals } from '@std/assert'
import {
  defaultBackupSchedule,
  describeBackupSchedule,
  isValidBackupTimezone,
  normalizeBackupScheduleInput,
  translateBackupSchedule,
} from './schedules.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('presets are stored as cron', () => {
  assertEquals(normalizeBackupScheduleInput({ preset: 'hourly' }), {
    ok: true,
    value: '0 * * * *',
  })
  assertEquals(normalizeBackupScheduleInput({ preset: 'daily', time: '02:30' }), {
    ok: true,
    value: '30 2 * * *',
  })
  assertEquals(normalizeBackupScheduleInput({ preset: 'weekly', day: 'sun', time: '23:05' }), {
    ok: true,
    value: '5 23 * * 0',
  })
  assertEquals(normalizeBackupScheduleInput({ preset: 'weekly', day: 'sat', time: '0:00' }), {
    ok: true,
    value: '0 0 * * 6',
  })
})

test('raw cron is kept as authored (trimmed)', () => {
  assertEquals(normalizeBackupScheduleInput('  */15 * * * *  '), {
    ok: true,
    value: '*/15 * * * *',
  })
  assertEquals(normalizeBackupScheduleInput('@daily'), { ok: true, value: '@daily' })
})

test('bad preset input is refused', () => {
  for (const input of [
    { preset: 'monthly' },
    { preset: 'daily' },
    { preset: 'daily', time: '24:00' },
    { preset: 'daily', time: '12:60' },
    { preset: 'daily', time: 'noon' },
    { preset: 'weekly', time: '01:00' },
    { preset: 'weekly', day: 'someday', time: '01:00' },
    '',
    '   ',
    42,
    null,
    ['0 * * * *'],
  ]) {
    assertEquals(normalizeBackupScheduleInput(input).ok, false, JSON.stringify(input))
  }
})

test('a stored schedule reads back as its preset', () => {
  assertEquals(describeBackupSchedule('0 * * * *'), { preset: 'hourly' })
  assertEquals(describeBackupSchedule('30 2 * * *'), { preset: 'daily', time: '02:30' })
  assertEquals(describeBackupSchedule('5 23 * * 0'), {
    preset: 'weekly',
    day: 'sun',
    time: '23:05',
  })
})

test('custom cron and out-of-range fields describe as no preset', () => {
  for (const schedule of ['*/15 * * * *', '@daily', '0 2 1 * *', '75 2 * * *', '0 30 * * 1']) {
    assertEquals(describeBackupSchedule(schedule), null, schedule)
  }
})

test('every preset round-trips through storage', () => {
  for (const preset of [
    { preset: 'hourly' as const },
    { preset: 'daily' as const, time: '07:45' },
    { preset: 'weekly' as const, day: 'wed' as const, time: '18:00' },
  ]) {
    const stored = normalizeBackupScheduleInput(preset)
    if (!stored.ok) throw new TypeError(stored.error)
    assertEquals(describeBackupSchedule(stored.value), preset)
  }
})

test('translation produces an OnCalendar value, with the zone when set', () => {
  const local = translateBackupSchedule('30 2 * * *', null)
  assertEquals(local.ok, true)
  if (local.ok) assertEquals(local.value.includes('2:30:00'), true)
  const zoned = translateBackupSchedule('30 2 * * *', 'America/Chicago')
  assertEquals(zoned.ok, true)
  if (zoned.ok) assertEquals(zoned.value.endsWith(' America/Chicago'), true)
})

test('translation refuses what a host could not run', () => {
  // cron unions day-of-month and day-of-week; a systemd timer intersects them.
  assertEquals(translateBackupSchedule('0 0 1 * 1', null).ok, false)
  assertEquals(translateBackupSchedule('@reboot', null).ok, false)
  assertEquals(translateBackupSchedule('not cron', null).ok, false)
  // A zone name with '+' passes the shape check but not the unit-file charset.
  assertEquals(translateBackupSchedule('0 3 * * *', 'Etc/GMT+5').ok, false)
})

test('timezones must be real IANA zones', () => {
  assertEquals(isValidBackupTimezone('UTC'), true)
  assertEquals(isValidBackupTimezone('Europe/London'), true)
  assertEquals(isValidBackupTimezone('Not/AZone'), false)
  assertEquals(isValidBackupTimezone(''), false)
  assertEquals(isValidBackupTimezone(null), false)
})

test('the default schedule is daily at 03:MM, stable per engine', () => {
  const managedId = '0192d6a0-1234-7abc-8def-0123456789ab'
  const schedule = defaultBackupSchedule(managedId)
  assertEquals(/^\d{1,2} 3 \* \* \*$/.test(schedule), true)
  assertEquals(defaultBackupSchedule(managedId), schedule)
  const minute = Number(schedule.split(' ')[0])
  assertEquals(minute >= 0 && minute <= 59, true)
  assertEquals(translateBackupSchedule(schedule, null).ok, true)
  // Different engines usually land on different minutes.
  const minutes = new Set(
    ['00a1', '00b2', '00c3', '00d4'].map((tail) =>
      defaultBackupSchedule(`0192d6a0-1234-7abc-8def-01234567${tail}`)
    )
  )
  assertEquals(minutes.size > 1, true)
})
