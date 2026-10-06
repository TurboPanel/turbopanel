import { assertEquals } from '@std/assert'
import {
  newestAllowedSeries,
  parseNodeVersionRange,
  rangeAllowsMajor,
} from './node-version-range.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const OFFERED = ['22', '24', '26']

function newest(range: string, offered: readonly string[] = OFFERED): string | null | 'invalid' {
  const parsed = parseNodeVersionRange(range)
  return parsed ? newestAllowedSeries(parsed, offered) : 'invalid'
}

test('picks the newest offered series each range form allows', () => {
  const cases: Array<[string, string | null]> = [
    // The real case: TurboPanel/website declares engines.node ">=26.7.0".
    ['>=26.7.0', '26'],
    ['>=22', '26'],
    ['>= 22', '26'],
    ['>=v22.0.0', '26'],
    ['^22', '22'],
    ['^22.11.0', '22'],
    ['^24.1', '24'],
    ['~22.1', '22'],
    ['~22.1.4', '22'],
    ['~>24.2', '24'],
    ['22.x', '22'],
    ['22.X', '22'],
    ['22.*', '22'],
    ['22', '22'],
    ['=24', '24'],
    ['v24.17.0', '24'],
    ['24.17.0-rc.1', '24'],
    ['24.1.0+build.5', '24'],
    ['*', '26'],
    ['x', '26'],
    ['20 || 22', '22'],
    ['18.x || 20.x || 22.x', '22'],
    ['^20 || ^24', '24'],
    ['>=22 <25', '24'],
    ['>=22.5 <22.8', '22'],
    ['>22', '26'],
    ['>24.99.99', '26'],
    ['<=24', '24'],
    ['<26', '24'],
    ['<24.0.0', '22'],
    ['20 - 24', '24'],
    ['22 - 24.3', '24'],
    ['22\t||\t24', '24'],
  ]
  for (const [range, expected] of cases) {
    assertEquals(newest(range), expected, range)
  }
})

test('says no offered series fits when the range only allows other versions', () => {
  for (const range of ['^20', '18.x', '>=28', '<22', '>26', '>=22.5 <22.3', '20 || 21', '<*']) {
    assertEquals(newest(range), null, range)
  }
})

test('treats text that is not a version range as saying nothing', () => {
  for (const range of [
    '',
    '   ',
    'lts/*',
    'lts/iron',
    'node',
    'latest',
    '22.x.1',
    '1.2.3.4',
    'abc',
  ]) {
    assertEquals(newest(range), 'invalid', range)
  }
})

test('the offered list decides, newest first, in numeric order', () => {
  assertEquals(newest('>=22', ['8', '24', '100']), '100')
  assertEquals(newest('>=22', []), null)
  assertEquals(newest('*', ['22', 'not-a-series']), '22')
})

test('a series is allowed when any of its releases is', () => {
  const range = parseNodeVersionRange('>=26.7.0')
  if (!range) throw new TypeError('expected a range')
  assertEquals(rangeAllowsMajor(range, 26), true)
  assertEquals(rangeAllowsMajor(range, 25), false)
  assertEquals(rangeAllowsMajor(range, 27), true)
})

test('caret on a zero major stays inside the first non-zero part', () => {
  const zeroMinor = parseNodeVersionRange('^0.2.3')
  const zeroPatch = parseNodeVersionRange('^0.0.3')
  if (!zeroMinor || !zeroPatch) throw new TypeError('expected ranges')
  assertEquals(rangeAllowsMajor(zeroMinor, 0), true)
  assertEquals(rangeAllowsMajor(zeroMinor, 1), false)
  assertEquals(rangeAllowsMajor(zeroPatch, 0), true)
})
