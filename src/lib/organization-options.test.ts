import { assertEquals } from '@std/assert'
import {
  isUnlimitedMaxServers,
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
  parseOrganizationOptions,
  resolveDefaultEnvironmentName,
} from './organization-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseOrganizationOptions reads timezone and maxServers', () => {
  const options = parseOrganizationOptions({
    defaultServerTimezone: ' America/Chicago ',
    enforceServerTimezone: true,
    maxServers: 5,
  })
  assertEquals(options.defaultServerTimezone, 'America/Chicago')
  assertEquals(options.enforceServerTimezone, true)
  assertEquals(options.maxServers, 5)
})

test('parseOrganizationOptions treats null maxServers as unlimited sentinel', () => {
  const options = parseOrganizationOptions({ maxServers: null })
  assertEquals(options.maxServers, null)
  assertEquals(isUnlimitedMaxServers(options.maxServers), true)
})

test('parseOrganizationOptions ignores invalid maxServers', () => {
  assertEquals(parseOrganizationOptions({ maxServers: -1 }).maxServers, undefined)
  assertEquals(parseOrganizationOptions({ maxServers: 1.5 }).maxServers, undefined)
  assertEquals(parseOrganizationOptions({ maxServers: '3' }).maxServers, undefined)
})

test('parseOrganizationOptions trims defaultEnvironmentName and omits blank', () => {
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: ' Staging ' })
      .defaultEnvironmentName,
    'Staging',
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: '   ' })
      .defaultEnvironmentName,
    undefined,
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: 12 })
      .defaultEnvironmentName,
    undefined,
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: null })
      .defaultEnvironmentName,
    undefined,
  )
})

test('parseMaxServersInput accepts zero and rejects negatives', () => {
  assertEquals(parseMaxServersInput(0), { ok: true, value: 0 })
  assertEquals(parseMaxServersInput(null), { ok: true, value: null })
  assertEquals(parseMaxServersInput(-1).ok, false)
})

test('parseDefaultEnvironmentNameInput accepts valid names and resets', () => {
  assertEquals(parseDefaultEnvironmentNameInput('Staging'), {
    ok: true,
    value: 'Staging',
  })
  assertEquals(parseDefaultEnvironmentNameInput(' Live Env '), {
    ok: true,
    value: 'Live Env',
  })
  assertEquals(parseDefaultEnvironmentNameInput(null), {
    ok: true,
    value: null,
  })
})

test('parseDefaultEnvironmentNameInput rejects invalid values', () => {
  assertEquals(parseDefaultEnvironmentNameInput(12).ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('   ').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('bad/name').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('a'.repeat(256)).ok, false)
})

test('resolveDefaultEnvironmentName uses option or Production fallback', () => {
  assertEquals(
    resolveDefaultEnvironmentName({ defaultEnvironmentName: 'Staging' }),
    'Staging',
  )
  assertEquals(resolveDefaultEnvironmentName({}), 'Production')
})

test('isUnlimitedMaxServers for omitted and null', () => {
  assertEquals(isUnlimitedMaxServers(undefined), true)
  assertEquals(isUnlimitedMaxServers(null), true)
  assertEquals(isUnlimitedMaxServers(0), false)
  assertEquals(isUnlimitedMaxServers(2), false)
})
