import { assertEquals, assertMatch } from '@std/assert'
import { newCorrelationId, nowIso } from './ids.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('newCorrelationId returns a UUID string', () => {
  const id = newCorrelationId()
  assertMatch(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )
  assertEquals(newCorrelationId() === id, false)
})

test('nowIso returns an ISO-8601 timestamp', () => {
  const iso = nowIso()
  assertEquals(Number.isNaN(Date.parse(iso)), false)
  assertEquals(new Date(iso).toISOString(), iso)
})
