import { assertEquals } from '@std/assert'
import {
  nodeEntitlementSeries,
  runtimeSeries,
  SUPPORTED_RUNTIME_SERIES,
  SUPPORTED_RUNTIMES,
} from './runtime-registry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('SUPPORTED_RUNTIMES lists principal-executable runtimes', () => {
  assertEquals(SUPPORTED_RUNTIMES, ['php', 'node'])
})

test('SUPPORTED_RUNTIME_SERIES is the flat union of known series', () => {
  assertEquals(SUPPORTED_RUNTIME_SERIES, ['8.3', '8.4', '22', '24'])
})

test('runtimeSeries returns PHP and Node series only for known runtimes', () => {
  assertEquals(runtimeSeries('php'), ['8.3', '8.4'])
  assertEquals(runtimeSeries('node'), ['22', '24'])
  assertEquals(runtimeSeries('ruby'), [])
  assertEquals(runtimeSeries(''), [])
})

test('nodeEntitlementSeries normalizes Node pins to the major series', () => {
  assertEquals(nodeEntitlementSeries('24.17.0'), '24')
  assertEquals(nodeEntitlementSeries('22'), '22')
  assertEquals(nodeEntitlementSeries(''), '24')
})
