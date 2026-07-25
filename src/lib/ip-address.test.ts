import { assertEquals } from 'jsr:@std/assert'
import {
  deriveIpVersion,
  isValidCidr,
  isValidIpAddress,
  parseIpVersion,
} from './ip-address.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseIpVersion detects IPv4 TEST-NET addresses', () => {
  assertEquals(parseIpVersion('203.0.113.10'), 4)
  assertEquals(parseIpVersion('192.0.2.1'), 4)
  assertEquals(parseIpVersion('256.0.0.1'), null)
})

test('parseIpVersion detects documentation IPv6', () => {
  assertEquals(parseIpVersion('2001:db8::1'), 6)
  assertEquals(parseIpVersion('::1'), 6)
})

test('parseIpVersion rejects malformed IPv6', () => {
  assertEquals(parseIpVersion('2001:db8:'), null)
  assertEquals(parseIpVersion('2001::db8::1'), null)
  assertEquals(parseIpVersion(':2001:db8:1'), null)
  assertEquals(parseIpVersion('::::'), null)
})

test('isValidCidr rejects malformed IPv6 host parts', () => {
  assertEquals(isValidCidr('2001:db8:/32'), false)
  assertEquals(isValidCidr('2001::db8::1/64'), false)
})

test('isValidIpAddress rejects garbage', () => {
  assertEquals(isValidIpAddress('not-an-ip'), false)
  assertEquals(isValidIpAddress('203.0.113.10'), true)
  assertEquals(isValidIpAddress('2001:db8::1'), true)
})

test('isValidCidr validates prefix bounds', () => {
  assertEquals(isValidCidr('203.0.113.0/24'), true)
  assertEquals(isValidCidr('203.0.113.0/33'), false)
  assertEquals(isValidCidr('2001:db8::/32'), true)
  assertEquals(isValidCidr('2001:db8::/129'), false)
  assertEquals(isValidCidr('203.0.113.10'), false)
})

test('deriveIpVersion matches parseIpVersion', () => {
  assertEquals(deriveIpVersion('203.0.113.10'), 4)
  assertEquals(deriveIpVersion('2001:db8::1'), 6)
  assertEquals(deriveIpVersion('bad'), null)
})
