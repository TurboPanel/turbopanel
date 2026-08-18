import { assertEquals } from '@std/assert'
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

test('parseDatacenterOptions keeps trimmed timezone, boolean enforce, and host defaults', () => {
  assertEquals(
    parseDatacenterOptions({
      defaultServerTimezone: '  Europe/Berlin  ',
      enforceServerTimezone: true,
      sshPort: 2200,
      ntp: { enabled: false },
    }),
    {
      defaultServerTimezone: 'Europe/Berlin',
      enforceServerTimezone: true,
      sshPort: 2200,
      ntp: { enabled: false },
    },
  )
})

test('parseDatacenterOptions keeps explicit ipv6 and ipv4 addressPreference', () => {
  assertEquals(parseDatacenterOptions({ addressPreference: 'ipv6' }), {
    addressPreference: 'ipv6',
  })
  assertEquals(parseDatacenterOptions({ addressPreference: 'ipv4' }), {
    addressPreference: 'ipv4',
  })
})

test('parseDatacenterOptions drops invalid addressPreference', () => {
  assertEquals(parseDatacenterOptions({ addressPreference: 'dual' }), {})
})

test('parseDatacenterOptions omits addressPreference when absent', () => {
  assertEquals(
    parseDatacenterOptions({ enforceServerTimezone: false }),
    { enforceServerTimezone: false },
  )
})
