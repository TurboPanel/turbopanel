/**
 * Host-free coverage for the switchover catch-up evidence.
 */

import { assertEquals } from '@std/assert'
import { evaluateSwitchoverCatchUp, SWITCHOVER_CATCHUP_MAX_AGE_MS } from './switchover-catchup.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-01-01T00:00:30.000Z')
const FRESH = '2026-01-01T00:00:20.000Z'

const caughtUp = {
  state: 'streaming',
  observedAt: FRESH,
  lagBytes: 0,
  receiveLagBytes: 0,
  lagSeconds: 0,
}

test('a fresh, streaming Postgres reading with zero lag is proven caught up', () => {
  assertEquals(evaluateSwitchoverCatchUp('postgres', caughtUp, NOW).caughtUp, true)
})

test('any non-zero or unknown lag is not proof', () => {
  for (const key of ['lagBytes', 'receiveLagBytes', 'lagSeconds'] as const) {
    assertEquals(
      evaluateSwitchoverCatchUp('postgres', { ...caughtUp, [key]: 1 }, NOW).caughtUp,
      false
    )
    const { [key]: _omit, ...missing } = caughtUp
    assertEquals(evaluateSwitchoverCatchUp('postgres', missing, NOW).caughtUp, false)
  }
})

test('not streaming, stale or missing readings are not proof', () => {
  assertEquals(
    evaluateSwitchoverCatchUp('postgres', { ...caughtUp, state: 'catching_up' }, NOW).caughtUp,
    false
  )
  const stale = new Date(NOW - SWITCHOVER_CATCHUP_MAX_AGE_MS - 1).toISOString()
  assertEquals(
    evaluateSwitchoverCatchUp('postgres', { ...caughtUp, observedAt: stale }, NOW).caughtUp,
    false
  )
  assertEquals(evaluateSwitchoverCatchUp('postgres', undefined, NOW).caughtUp, false)
  assertEquals(evaluateSwitchoverCatchUp('postgres', null, NOW).caughtUp, false)
})

test('MySQL and MariaDB are never proven: asynchronous, no final position to compare', () => {
  for (const engine of ['mysql', 'mariadb']) {
    assertEquals(evaluateSwitchoverCatchUp(engine, caughtUp, NOW).caughtUp, false)
  }
})
