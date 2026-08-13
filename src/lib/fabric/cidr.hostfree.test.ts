import { assertEquals } from 'jsr:@std/assert'
import {
  cidrOverlaps,
  composeNetworkHostName,
  hostRoute32,
  nthHostAddress,
  nthSubnet,
  parseFabricOptions,
  pickDefaultFabricHostCidr,
} from './cidr.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('pickDefaultFabricHostCidr skips overlapping occupied ranges', () => {
  assertEquals(pickDefaultFabricHostCidr([]), '10.250.0.0/16')
  assertEquals(pickDefaultFabricHostCidr(['10.250.0.0/16']), '10.251.0.0/16')
})

test('nthHostAddress walks usable hosts inside a /16', () => {
  assertEquals(nthHostAddress('10.250.0.0/16', 0), '10.250.0.1')
  assertEquals(nthHostAddress('10.250.0.0/16', 1), '10.250.0.2')
  assertEquals(nthHostAddress('10.250.0.0/30', 0), '10.250.0.1')
  assertEquals(nthHostAddress('10.250.0.0/30', 2), null)
})

test('nthSubnet carves /16s from the default container pool', () => {
  assertEquals(nthSubnet('10.192.0.0/12', 16, 0), '10.192.0.0/16')
  assertEquals(nthSubnet('10.192.0.0/12', 16, 1), '10.193.0.0/16')
})

test('cidrOverlaps and hostRoute32', () => {
  assertEquals(cidrOverlaps('10.250.0.0/16', '10.250.1.0/24'), true)
  assertEquals(cidrOverlaps('10.250.0.0/16', '10.251.0.0/16'), false)
  assertEquals(hostRoute32('10.250.0.11/32'), '10.250.0.11/32')
})

test('parseFabricOptions falls back to defaults', () => {
  assertEquals(parseFabricOptions(null).listenPort, 51821)
  assertEquals(parseFabricOptions({ listenPort: 51830 }).listenPort, 51830)
  assertEquals(composeNetworkHostName('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').startsWith('tpn_'), true)
})
