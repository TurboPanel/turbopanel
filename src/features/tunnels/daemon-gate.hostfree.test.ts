import { assertEquals } from '@std/assert'
import { daemonCanCarryTunnels, TUNNEL_FORWARDING_FEATURE } from './daemon-gate.ts'

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
