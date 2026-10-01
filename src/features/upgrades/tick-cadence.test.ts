import { assertEquals } from '@std/assert'
import {
  parseUpgradeTickMinutes,
  shouldRunUpgradeTick,
  UPGRADE_TICK_ALLOWED_MINUTES,
  UPGRADE_TICK_DEFAULT_MINUTES,
} from './tick-cadence.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar typescript:S2187). */
const test = Deno.test.bind(Deno)

test('the default tick stays 15 minutes', () => {
  assertEquals(UPGRADE_TICK_DEFAULT_MINUTES, 15)
  assertEquals(parseUpgradeTickMinutes(undefined), 15)
  assertEquals(parseUpgradeTickMinutes(''), 15)
  assertEquals(parseUpgradeTickMinutes('   '), 15)
})

test('every allowed value is honored, with surrounding spaces ignored', () => {
  for (const minutes of UPGRADE_TICK_ALLOWED_MINUTES) {
    assertEquals(parseUpgradeTickMinutes(String(minutes)), minutes)
  }
  assertEquals(parseUpgradeTickMinutes(' 5 '), 5)
})

test('anything else is rejected and falls back to the default', () => {
  for (const bad of ['0', '-1', '7', '13', '61', '120', '1.5', 'five', '5m', '1e1', '0x5']) {
    assertEquals(parseUpgradeTickMinutes(bad), 15, bad)
  }
})

test('every allowed value divides the hour evenly', () => {
  for (const minutes of UPGRADE_TICK_ALLOWED_MINUTES) assertEquals(60 % minutes, 0)
})

test('shouldRunUpgradeTick fires on every Nth UTC minute only', () => {
  const at = (hhmm: string) => Date.parse(`2026-01-01T${hhmm}:00.000Z`)
  assertEquals(shouldRunUpgradeTick(at('00:00'), 15), true)
  assertEquals(shouldRunUpgradeTick(at('00:15'), 15), true)
  assertEquals(shouldRunUpgradeTick(at('00:05'), 15), false)
  assertEquals(shouldRunUpgradeTick(at('00:05'), 5), true)
  assertEquals(shouldRunUpgradeTick(at('00:06'), 5), false)
  assertEquals(shouldRunUpgradeTick(at('00:07'), 1), true)
  assertEquals(shouldRunUpgradeTick(at('00:30'), 60), false)
  assertEquals(shouldRunUpgradeTick(at('01:00'), 60), true)
})
