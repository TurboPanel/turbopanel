import { assertEquals } from '@std/assert'
import { EDGE_MODES, heartbeatSecondsFor } from './heartbeat-policy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('workers always advise 60 seconds, even with an edge hostname', () => {
  assertEquals(heartbeatSecondsFor(['cloudflare-tunnel'], 'workers'), 60)
})

test('deno advises 25 seconds when any hostname sits behind an edge', () => {
  for (const mode of EDGE_MODES) {
    assertEquals(heartbeatSecondsFor(['direct', mode], 'deno'), 25)
  }
})

test('deno advises 60 seconds with no edge hostname', () => {
  assertEquals(heartbeatSecondsFor([], 'deno'), 60)
  assertEquals(heartbeatSecondsFor(['direct', 'lan-only'], 'deno'), 60)
})
