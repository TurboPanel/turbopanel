import { assertEquals } from '@std/assert'
import {
  isUpgradeCheckDue,
  nextUpgradeCheckAt,
  pickUpgradeCheckMinute,
  shouldAutoStartRun,
  type UpgradeCheckSchedule,
} from './schedule.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function schedule(overrides: Partial<UpgradeCheckSchedule> = {}): UpgradeCheckSchedule {
  return {
    minute: 17,
    createdAt: '2026-10-27T09:40:00.000Z',
    lastCheckAt: null,
    ...overrides,
  }
}

const at = (iso: string) => new Date(iso)

test('the minute of the hour comes from the draw and stays in 0..59', () => {
  assertEquals(pickUpgradeCheckMinute(0), 0)
  assertEquals(pickUpgradeCheckMinute(0.5), 30)
  assertEquals(pickUpgradeCheckMinute(0.9999), 59)
  assertEquals(pickUpgradeCheckMinute(1), 59)
  assertEquals(pickUpgradeCheckMinute(-1), 0)
  assertEquals(pickUpgradeCheckMinute(Number.NaN), 0)
})

test('many installs spread their checks over the hour', () => {
  const minutes = new Set<number>()
  for (let i = 0; i < 600; i++) minutes.add(pickUpgradeCheckMinute((i * 0.6180339887) % 1))
  // A golden-ratio walk stands in for random draws: every minute gets used.
  assertEquals(minutes.size, 60)
})

test('before the first check the next one is the first slot after the row was created', () => {
  const s = schedule()
  assertEquals(
    nextUpgradeCheckAt(s, at('2026-10-27T09:45:00.000Z')).toISOString(),
    '2026-10-27T10:17:00.000Z'
  )
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T10:16:59.000Z')), false)
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T10:17:00.000Z')), true)
})

test('after a check the next one is the same minute an hour later', () => {
  const s = schedule({ lastCheckAt: '2026-10-27T10:17:00.300Z' })
  assertEquals(
    nextUpgradeCheckAt(s, at('2026-10-27T10:18:00.000Z')).toISOString(),
    '2026-10-27T11:17:00.000Z'
  )
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T10:59:00.000Z')), false)
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T11:17:00.000Z')), true)
})

test('the schedule is stable: the same row gives the same slot every hour', () => {
  for (const hour of ['10', '11', '23']) {
    const s = schedule({ lastCheckAt: `2026-10-27T${hour}:17:05.000Z` })
    const next = nextUpgradeCheckAt(s, at(`2026-10-27T${hour}:30:00.000Z`))
    assertEquals(next.getUTCMinutes(), 17)
  }
})

test('a tick that lands after the slot (the hosted tick runs every few minutes) still checks once', () => {
  const s = schedule({ lastCheckAt: '2026-10-27T10:30:00.000Z' })
  // The slot is 11:17; a tick at 11:30 is the first one after it.
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T11:15:00.000Z')), false)
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T11:30:00.000Z')), true)
  // Once that tick records its check, the next slot is 12:17.
  const after = schedule({ lastCheckAt: '2026-10-27T11:30:00.000Z' })
  assertEquals(isUpgradeCheckDue(after, at('2026-10-27T11:45:00.000Z')), false)
  assertEquals(
    nextUpgradeCheckAt(after, at('2026-10-27T11:45:00.000Z')).toISOString(),
    '2026-10-27T12:17:00.000Z'
  )
})

test('a control plane that was down catches up once, then keeps its minute', () => {
  const s = schedule({ lastCheckAt: '2026-10-25T08:17:00.000Z' })
  assertEquals(isUpgradeCheckDue(s, at('2026-10-27T10:02:00.000Z')), true)
})

test('a last check in the future (clock moved back) never stalls the schedule past an hour', () => {
  const s = schedule({ lastCheckAt: '2026-10-28T10:17:00.000Z' })
  assertEquals(
    nextUpgradeCheckAt(s, at('2026-10-27T10:00:00.000Z')).toISOString(),
    '2026-10-27T10:17:00.000Z'
  )
})

test('an automatic run starts only on drift, with no run open and updates not paused', () => {
  const base = { targetDiffers: true, runActive: false, paused: false }
  assertEquals(shouldAutoStartRun(base), true)
  assertEquals(shouldAutoStartRun({ ...base, targetDiffers: false }), false)
  assertEquals(shouldAutoStartRun({ ...base, runActive: true }), false)
  assertEquals(shouldAutoStartRun({ ...base, paused: true }), false)
})
