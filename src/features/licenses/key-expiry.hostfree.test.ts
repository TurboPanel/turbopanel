/** Unused registration keys expire a fixed number of days after mint; bound keys never do. */

import { assertEquals } from '@std/assert'
import {
  isUnusedKeyExpired,
  LICENSE_KEY_UNUSED_TTL_DAYS,
  unusedKeyExpiresAt,
} from './key-expiry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MINTED = Date.parse('2026-10-27T12:00:00.000Z')

test('a key minted now expires LICENSE_KEY_UNUSED_TTL_DAYS days later', () => {
  assertEquals(LICENSE_KEY_UNUSED_TTL_DAYS, 7)
  assertEquals(unusedKeyExpiresAt(MINTED), '2026-11-03T12:00:00.000Z')
})

test('an unused key is expired from its expiry on, a bound or undated key never is', () => {
  const expiresAt = unusedKeyExpiresAt(MINTED)
  const at = Date.parse(expiresAt)
  assertEquals(isUnusedKeyExpired({ serverId: null, expiresAt }, at - 1), false)
  assertEquals(isUnusedKeyExpired({ serverId: null, expiresAt }, at), true)
  assertEquals(isUnusedKeyExpired({ serverId: 'server-1', expiresAt }, at + 1), false)
  assertEquals(isUnusedKeyExpired({ serverId: null, expiresAt: null }, at + 1), false)
  assertEquals(isUnusedKeyExpired({ serverId: null, expiresAt: 'not a date' }, at + 1), false)
})
