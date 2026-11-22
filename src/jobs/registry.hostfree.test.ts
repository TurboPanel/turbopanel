import { assertEquals } from '@std/assert'
import {
  CRON_CADENCES,
  type CronCadenceTable,
  type CronJob,
  isDue,
  jobEveryMinutes,
  resolveJobCadences,
} from './registry.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

const DAY_START = Date.parse('2026-01-01T00:00:00.000Z')
const minuteAt = (minute: number) => DAY_START + minute * 60_000

/** The minutes of a day, 0..1439, on which a job is due. */
function dueMinutes(job: CronJob, table: CronCadenceTable = CRON_CADENCES): number[] {
  return Array.from({ length: 1440 }, (_, minute) => minute).filter((minute) =>
    isDue(job, minuteAt(minute), table)
  )
}

test('blank, missing or whitespace overrides keep every default without a warning', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const resolved = resolveJobCadences(raw)
    assertEquals(resolved.table, CRON_CADENCES)
    assertEquals(resolved.warnings, [])
  }
})

test('a valid map moves the named jobs and leaves the rest', () => {
  const resolved = resolveJobCadences('{"executionLogs": 60, "tierNotices": 1440}')
  assertEquals(resolved.warnings, [])
  assertEquals(jobEveryMinutes('executionLogs', resolved.table), 60)
  assertEquals(jobEveryMinutes('tierNotices', resolved.table), 1440)
  assertEquals(jobEveryMinutes('historyPrune', resolved.table), 15)
  // The offset of a moved job stays the table's.
  assertEquals(resolved.table.commandDispatchCleanup, CRON_CADENCES.commandDispatchCleanup)
})

test('numeric strings are accepted', () => {
  const resolved = resolveJobCadences('{"upgradeTick": "5"}')
  assertEquals(jobEveryMinutes('upgradeTick', resolved.table), 5)
  assertEquals(resolved.warnings, [])
})

test('values outside the range clamp and warn once each', () => {
  const resolved = resolveJobCadences(
    '{"executionLogs": 0, "tierNotices": 99999, "daemonNonces": 7.4}'
  )
  assertEquals(jobEveryMinutes('executionLogs', resolved.table), 1)
  assertEquals(jobEveryMinutes('tierNotices', resolved.table), 1440)
  assertEquals(jobEveryMinutes('daemonNonces', resolved.table), 7)
  assertEquals(resolved.warnings.length, 3)
})

test('the update check tops out at an hour', () => {
  const resolved = resolveJobCadences('{"upgradeCheck": 600}')
  assertEquals(jobEveryMinutes('upgradeCheck', resolved.table), 60)
  assertEquals(resolved.warnings.length, 1)
})

test('bad values and unknown names never throw and never move a job', () => {
  const resolved = resolveJobCadences(
    '{"executionLogs": "soon", "tierNotices": null, "nope": 5, "__proto__": 1, "historyPrune": [3]}'
  )
  assertEquals(resolved.table, CRON_CADENCES)
  assertEquals(resolved.warnings.length, 5)
})

test('unreadable JSON and non-object maps fall back to the defaults with one warning', () => {
  for (const raw of ['{not json', '[1,2]', '42', 'null', '"text"']) {
    const resolved = resolveJobCadences(raw)
    assertEquals(resolved.table, CRON_CADENCES, raw)
    assertEquals(resolved.warnings.length, 1, raw)
  }
})

test('latency jobs stay at every minute whatever the map says', () => {
  const resolved = resolveJobCadences('{"offlineDetection": 60, "commandRedelivery": 1440}')
  for (const job of ['offlineDetection', 'commandRedelivery'] as const) {
    assertEquals(jobEveryMinutes(job, resolved.table), 1, job)
    assertEquals(dueMinutes(job, resolved.table).length, 1440, job)
  }
  assertEquals(resolved.warnings.length, 2)
  assertEquals(resolveJobCadences('{"offlineDetection": 1}').warnings, [])
})

test('every latency job is pinned and every housekeeping job spans 1 minute up to a day (an hour for the update check)', () => {
  for (const [name, spec] of Object.entries(CRON_CADENCES)) {
    if (spec.kind === 'latency') {
      assertEquals([spec.min, spec.max, spec.everyMinutes], [1, 1, 1], name)
    } else {
      assertEquals(spec.min, 1, name)
      assertEquals(spec.max, name === 'upgradeCheck' || name === 'ingressTick' ? 60 : 1440, name)
    }
  }
})

test('isDue honours an override together with the job offset', () => {
  const resolved = resolveJobCadences('{"commandDispatchCleanup": 60, "daemonNonces": 1440}')
  // Default: every 15 minutes on minute 3. Overridden: once an hour on minute 3 (60 % 60 = 0, offset 3 % 60).
  assertEquals(dueMinutes('commandDispatchCleanup').slice(0, 4), [3, 18, 33, 48])
  assertEquals(dueMinutes('commandDispatchCleanup', resolved.table).slice(0, 3), [3, 63, 123])
  // Once a day on minute 9 of the UTC day.
  assertEquals(dueMinutes('daemonNonces', resolved.table), [9])
})

test('the tunnel sweeps default to every 5 minutes and run once per window', () => {
  assertEquals(CRON_CADENCES.tunnelSweeps.everyMinutes, 5)
  assertEquals(dueMinutes('tunnelSweeps').length, 288)
  const stretched = resolveJobCadences('{"tunnelSweeps": 15}')
  assertEquals(stretched.warnings, [])
  assertEquals(dueMinutes('tunnelSweeps', stretched.table).length, 96)
})

test('a tick with no scheduled time runs every job', () => {
  for (const job of Object.keys(CRON_CADENCES) as CronJob[])
    assertEquals(isDue(job, undefined), true)
})
