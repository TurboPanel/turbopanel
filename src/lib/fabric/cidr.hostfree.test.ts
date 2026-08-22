import { assertEquals } from '@std/assert'
import {
  cidrContains,
  cidrOverlaps,
  composeNetworkHostName,
  hostRoute32,
  isRelayAddressUniqueViolation,
  isRelayPrefixUniqueViolation,
  nextFreeSubnet,
  nthHostAddress,
  nthSubnet,
  parseFabricOptions,
  pickDefaultFabricHostCidr,
  reservedManagedIngressAddress,
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

test('reservedManagedIngressAddress is the last usable host', () => {
  assertEquals(reservedManagedIngressAddress('203.0.113.0/24'), '203.0.113.254')
  assertEquals(reservedManagedIngressAddress('10.250.0.0/30'), '10.250.0.2')
  assertEquals(reservedManagedIngressAddress('10.250.0.0/31'), null)
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
  assertEquals(parseFabricOptions(null).mtu, 1420)
  assertEquals(parseFabricOptions({ listenPort: 51830 }).listenPort, 51830)
  assertEquals(parseFabricOptions({ mtu: 1500 }).mtu, 1500)
  assertEquals(composeNetworkHostName('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').startsWith('tpn_'), true)
})

test('isRelayAddressUniqueViolation matches uniq_relay_fabric_address', () => {
  const hit = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_relay_fabric_address"'),
    { code: '23505' },
  )
  const miss = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_ip_org_address"'),
    { code: '23505' },
  )
  assertEquals(isRelayAddressUniqueViolation(hit), true)
  assertEquals(isRelayAddressUniqueViolation(miss), false)
  assertEquals(isRelayAddressUniqueViolation({ code: '23505' }), false)
})

test('isRelayPrefixUniqueViolation matches uniq_relay_fabric_prefix', () => {
  const hit = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_relay_fabric_prefix"'),
    { code: '23505' },
  )
  const miss = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_relay_fabric_address"'),
    { code: '23505' },
  )
  assertEquals(isRelayPrefixUniqueViolation(hit), true)
  assertEquals(isRelayPrefixUniqueViolation(miss), false)
  assertEquals(isRelayPrefixUniqueViolation({ code: '23505' }), false)
})

test('cidrContains and nextFreeSubnet skip taken subnets', () => {
  assertEquals(cidrContains('10.192.0.0/16', '10.192.1.0/24'), true)
  assertEquals(cidrContains('10.192.0.0/16', '10.193.0.0/24'), false)
  assertEquals(nextFreeSubnet('10.192.0.0/16', 24, []), '10.192.0.0/24')
  assertEquals(
    nextFreeSubnet('10.192.0.0/16', 24, ['10.192.0.0/24', '10.192.2.0/24']),
    '10.192.1.0/24',
  )
  assertEquals(nextFreeSubnet('10.192.0.0/24', 24, ['10.192.0.0/24']), null)
})
