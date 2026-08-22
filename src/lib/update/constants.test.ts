import { assertEquals } from '@std/assert'
import {
  TERMINAL_UPDATE_RETENTION_MS,
  TRUNK_MANIFEST_CACHE_MS,
  UPDATE_PENDING_MS,
  UPDATE_REQUEST_TTL_MS,
} from './constants.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('update timing constants stay positive and retention matches pending window', () => {
  assertEquals(UPDATE_PENDING_MS > 0, true)
  assertEquals(UPDATE_REQUEST_TTL_MS > UPDATE_PENDING_MS, true)
  assertEquals(TERMINAL_UPDATE_RETENTION_MS, UPDATE_PENDING_MS)
  assertEquals(TRUNK_MANIFEST_CACHE_MS > 0, true)
})
