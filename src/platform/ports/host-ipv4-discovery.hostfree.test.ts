import { assertEquals } from '@std/assert'
import {
  discoverHostIpv4,
  setHostIpv4Discovery,
} from './host-ipv4-discovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('host IPv4 discovery is unset until the composition root registers it', () => {
  setHostIpv4Discovery(null)
  assertEquals(discoverHostIpv4(), null)
  setHostIpv4Discovery(() => '203.0.113.10')
  assertEquals(discoverHostIpv4(), '203.0.113.10')
  setHostIpv4Discovery(null)
  assertEquals(discoverHostIpv4(), null)
})
