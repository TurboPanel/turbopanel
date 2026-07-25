import { assertEquals } from 'jsr:@std/assert'
import { parseDatacenterOptions } from './datacenter-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseDatacenterOptions returns empty object for non-records', () => {
  assertEquals(parseDatacenterOptions(null), {})
  assertEquals(parseDatacenterOptions([]), {})
  assertEquals(parseDatacenterOptions('nope'), {})
})

test('parseDatacenterOptions omits blank timezone and invalid enforce flag', () => {
  assertEquals(
    parseDatacenterOptions({
      defaultServerTimezone: '  ',
      enforceServerTimezone: 'yes',
    }),
    {},
  )
})

test('parseDatacenterOptions keeps trimmed timezone and boolean enforce', () => {
  assertEquals(
    parseDatacenterOptions({
      defaultServerTimezone: '  Europe/Berlin  ',
      enforceServerTimezone: true,
    }),
    {
      defaultServerTimezone: 'Europe/Berlin',
      enforceServerTimezone: true,
    },
  )
})
