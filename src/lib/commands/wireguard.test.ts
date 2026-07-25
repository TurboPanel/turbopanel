import { assertEquals } from 'jsr:@std/assert'
import { deriveWireguardInterfaceName } from './wireguard.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('deriveWireguardInterfaceName is deterministic and within length limit', () => {
  const vpnId = '550e8400-e29b-41d4-a716-446655440000'
  const name = deriveWireguardInterfaceName(vpnId)
  assertEquals(name, 'tpwg550e8400')
  assertEquals(name, deriveWireguardInterfaceName(vpnId))
  assertEquals(name.length <= 15, true)
})
