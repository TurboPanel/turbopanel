import { assertEquals } from '@std/assert'
import {
  DEFAULT_NATIVE_APP_DENO_SERIES,
  denoRuntimeSeries,
  NEWEST_NATIVE_APP_NODE_SERIES,
  newestRuntimeSeries,
  runtimeSeries,
} from './runtime-registry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('runtimeSeries returns PHP and Node series only for known runtimes', () => {
  assertEquals(runtimeSeries('php'), ['8.1', '8.2', '8.3', '8.4', '8.5'])
  assertEquals(runtimeSeries('node'), ['22', '24', '26'])
  assertEquals(runtimeSeries('deno'), ['2'])
  assertEquals(runtimeSeries('ruby'), [])
  assertEquals(runtimeSeries(''), [])
})

test('denoRuntimeSeries normalizes Deno pins to the major series', () => {
  assertEquals(denoRuntimeSeries('2.9.7'), '2')
  assertEquals(denoRuntimeSeries('2'), '2')
  assertEquals(denoRuntimeSeries(''), DEFAULT_NATIVE_APP_DENO_SERIES)
  assertEquals(denoRuntimeSeries('latest'), DEFAULT_NATIVE_APP_DENO_SERIES)
})

test('an app with no Node pin runs the newest offered series, compared as numbers', () => {
  assertEquals(NEWEST_NATIVE_APP_NODE_SERIES, '26')
  assertEquals(newestRuntimeSeries('node'), '26')
  assertEquals(newestRuntimeSeries('php'), '8.5')
  assertEquals(newestRuntimeSeries('ruby'), undefined)
  // The newest offered series is the highest number, not the last string.
  assertEquals(
    Math.max(...runtimeSeries('node').map(Number)),
    Number(NEWEST_NATIVE_APP_NODE_SERIES)
  )
})
