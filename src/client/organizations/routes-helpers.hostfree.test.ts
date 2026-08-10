/**
 * Host-free coverage for organization route pure validation helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseOrganizationCreateDisplayName,
  parseServerCapacityPutBody,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseDefaultTimezonePatch rejects empty and invalid patches', () => {
  assertEquals(parseDefaultTimezonePatch({}).ok, false)
  assertEquals(
    parseDefaultTimezonePatch({ defaultServerTimezone: 'Not/AZone' }),
    { ok: false, error: 'Invalid defaultServerTimezone', status: 400 },
  )
  assertEquals(
    parseDefaultTimezonePatch({ enforceServerTimezone: 'yes' }),
    { ok: false, error: 'Invalid enforceServerTimezone', status: 400 },
  )
})

test('parseDefaultTimezonePatch accepts null timezone and boolean enforcement', () => {
  const reset = parseDefaultTimezonePatch({ defaultServerTimezone: null })
  if (!reset.ok) {
    throw new TypeError('expected null timezone reset to succeed')
  }
  assertEquals(reset.patch.defaultServerTimezone, null)

  const enforce = parseDefaultTimezonePatch({
    defaultServerTimezone: 'America/New_York',
    enforceServerTimezone: true,
  })
  if (!enforce.ok) {
    throw new TypeError('expected valid timezone patch')
  }
  assertEquals(enforce.patch.defaultServerTimezone, 'America/New_York')
  assertEquals(enforce.patch.enforceServerTimezone, true)
})

test('parseDefaultEnvironmentPutBody requires field and validates names', () => {
  assertEquals(parseDefaultEnvironmentPutBody({}).ok, false)
  assertEquals(parseDefaultEnvironmentPutBody({ defaultEnvironmentName: '' }).ok, false)
  assertEquals(parseDefaultEnvironmentPutBody({ defaultEnvironmentName: 'bad/name' }).ok, false)

  const ok = parseDefaultEnvironmentPutBody({ defaultEnvironmentName: ' Staging ' })
  if (!ok.ok) {
    throw new TypeError('expected valid default environment name')
  }
  assertEquals(ok.defaultEnvironmentName, 'Staging')

  const reset = parseDefaultEnvironmentPutBody({ defaultEnvironmentName: null })
  if (!reset.ok) {
    throw new TypeError('expected null default environment reset')
  }
  assertEquals(reset.defaultEnvironmentName, null)
})

test('parseServerCapacityPutBody requires maxServers and validates values', () => {
  assertEquals(parseServerCapacityPutBody({}).ok, false)
  assertEquals(parseServerCapacityPutBody({ maxServers: -1 }).ok, false)
  assertEquals(parseServerCapacityPutBody({ maxServers: 1.5 }).ok, false)

  const unlimited = parseServerCapacityPutBody({ maxServers: null })
  if (!unlimited.ok) {
    throw new TypeError('expected null maxServers')
  }
  assertEquals(unlimited.maxServers, null)

  const capped = parseServerCapacityPutBody({ maxServers: 3 })
  if (!capped.ok) {
    throw new TypeError('expected integer maxServers')
  }
  assertEquals(capped.maxServers, 3)
})

test('parseOrganizationCreateDisplayName defaults when displayName is absent', () => {
  const defaultName = parseOrganizationCreateDisplayName({})
  if (!defaultName.ok) {
    throw new TypeError('expected default organization name')
  }
  assertEquals(defaultName.displayName, 'New Organization')

  // parseDisplayName reads `name`, not `displayName` — invalid displayName is ignored.
  const ignoredInvalid = parseOrganizationCreateDisplayName({ displayName: 'bad@name' })
  if (!ignoredInvalid.ok) {
    throw new TypeError('expected default despite invalid displayName key')
  }
  assertEquals(ignoredInvalid.displayName, 'New Organization')
})
