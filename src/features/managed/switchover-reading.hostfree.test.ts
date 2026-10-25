/**
 * Host-free coverage for the reading taken at switchover start.
 */

import { assertEquals } from '@std/assert'
import { SWITCHOVER_CATCHUP_MAX_AGE_MS } from './switchover-evidence.ts'
import { readSwitchoverReplication } from './switchover-reading.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-01-01T00:10:00.000Z')
const FRESH = { state: 'streaming', observedAt: '2026-01-01T00:09:50.000Z' }
const STALE = {
  state: 'streaming',
  observedAt: new Date(NOW - SWITCHOVER_CATCHUP_MAX_AGE_MS - 1000).toISOString(),
}
const PROBED = { state: 'streaming', observedAt: '2026-01-01T00:10:00.000Z' }

test('a fresh stored reading is used without probing', async () => {
  let probed = false
  const reading = await readSwitchoverReplication({
    engine: 'postgres',
    stored: () => Promise.resolve(FRESH),
    probe: () => {
      probed = true
      return Promise.resolve(PROBED)
    },
    nowMs: NOW,
  })
  assertEquals(reading, FRESH)
  assertEquals(probed, false)
})

test('a stale or missing stored reading is replaced by one fresh probe', async () => {
  for (const stored of [STALE, undefined]) {
    const reading = await readSwitchoverReplication({
      engine: 'postgres',
      stored: () => Promise.resolve(stored),
      probe: () => Promise.resolve(PROBED),
      nowMs: NOW,
    })
    assertEquals(reading, PROBED)
  }
})

test('other engines and any failure give no reading', async () => {
  assertEquals(
    await readSwitchoverReplication({
      engine: 'mysql',
      stored: () => Promise.resolve(FRESH),
      probe: () => Promise.resolve(PROBED),
      nowMs: NOW,
    }),
    undefined
  )
  assertEquals(
    await readSwitchoverReplication({
      engine: 'postgres',
      stored: () => Promise.reject(new TypeError('database down')),
      probe: () => Promise.resolve(PROBED),
      nowMs: NOW,
    }),
    undefined
  )
})
