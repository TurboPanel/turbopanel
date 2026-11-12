import { assertEquals } from '@std/assert'
import {
  TUNNEL_FORWARDING_FEATURE,
  TUNNEL_LOCK_ADD_FEATURE,
  TUNNEL_LOCK_FOLLOW_FEATURE,
} from '../../lib/version-wire.ts'
import {
  daemonAddsLockFromTable,
  daemonCanCarryTunnels,
  daemonLockFollowsTable,
} from './daemon-gate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('only a daemon that advertises the feature can carry tunnel names', () => {
  assertEquals(daemonCanCarryTunnels(undefined), false)
  assertEquals(daemonCanCarryTunnels([]), false)
  assertEquals(daemonCanCarryTunnels(['deploy-cancel-v1']), false)
  assertEquals(daemonCanCarryTunnels(['deploy-cancel-v1', TUNNEL_FORWARDING_FEATURE]), true)
})

test('only a daemon that advertises it takes the name lock from the forwarding table', () => {
  assertEquals(daemonLockFollowsTable(undefined), false)
  assertEquals(daemonLockFollowsTable([TUNNEL_FORWARDING_FEATURE]), false)
  assertEquals(
    daemonLockFollowsTable([TUNNEL_FORWARDING_FEATURE, TUNNEL_LOCK_FOLLOW_FEATURE]),
    true
  )
})

test('only a daemon that advertises tunnel-lock-add-v1 adds a lock from the table', () => {
  assertEquals(daemonAddsLockFromTable(undefined), false)
  assertEquals(daemonAddsLockFromTable([TUNNEL_LOCK_FOLLOW_FEATURE]), false)
  assertEquals(daemonAddsLockFromTable([TUNNEL_LOCK_ADD_FEATURE]), true)
})
