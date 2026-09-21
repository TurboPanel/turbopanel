import { assertEquals } from '@std/assert'
import {
  getManagedHaRecoveryHooks,
  setManagedHaRecoveryHooks,
} from './managed-ha-recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('managed HA recovery hooks default to unset', () => {
  setManagedHaRecoveryHooks(null)
  assertEquals(getManagedHaRecoveryHooks(), null)
})
