import { assertEquals } from 'jsr:@std/assert'
import {
  bigIntToIp,
  cidrHostRange,
  deriveIpVersion,
  ipToBigInt,
  isValidCidr,
  isValidIpAddress,
  nextFreeHostAddress,
  parseCidr,
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

test('parseCidr network-aligns and rejects garbage', () => {
  const parsed = parseCidr('203.0.113.10/24')
  assertEquals(parsed?.version, 4)
  assertEquals(parsed?.prefix, 24)
  assertEquals(parsed?.base, ipToBigInt('203.0.113.0'))
  assertEquals(parseCidr('not-a-cidr'), null)
})

test('cidrHostRange skips IPv4 network and broadcast for /24', () => {
  const range = cidrHostRange('203.0.113.0/24')
  assertEquals(range?.first, ipToBigInt('203.0.113.1'))
  assertEquals(range?.last, ipToBigInt('203.0.113.254'))
})

test('cidrHostRange keeps whole range for /31 and /32', () => {
  const slash31 = cidrHostRange('203.0.113.0/31')
  assertEquals(slash31?.first, ipToBigInt('203.0.113.0'))
  assertEquals(slash31?.last, ipToBigInt('203.0.113.1'))

  const slash32 = cidrHostRange('203.0.113.10/32')
  assertEquals(slash32?.first, ipToBigInt('203.0.113.10'))
  assertEquals(slash32?.last, ipToBigInt('203.0.113.10'))
})

test('cidrHostRange skips IPv6 subnet-router anycast', () => {
  const range = cidrHostRange('2001:db8::/126')
  assertEquals(range?.first, ipToBigInt('2001:db8::1'))
  assertEquals(bigIntToIp(range!.last, 6), '2001:db8::3')
})

test('cidrHostRange returns null for ::/128 (unspecified is not allocatable)', () => {
  assertEquals(cidrHostRange('::/128'), null)
  assertEquals(nextFreeHostAddress('::/128', []), null)
})

test('bigIntToIp formats IPv6 RFC 5952-canonical', () => {
  assertEquals(bigIntToIp(ipToBigInt('2001:db8::1')!, 6), '2001:db8::1')
  assertEquals(bigIntToIp(0n, 6), '::')
  assertEquals(parseIpVersion(bigIntToIp(ipToBigInt('2001:db8:0:0:0:0:0:1')!, 6)!), 6)
})

test('nextFreeHostAddress picks lowest free and reuses gaps', () => {
  assertEquals(
    nextFreeHostAddress('203.0.113.0/30', []),
    '203.0.113.1',
  )
  assertEquals(
    nextFreeHostAddress('203.0.113.0/30', ['203.0.113.1']),
    '203.0.113.2',
  )
  assertEquals(
    nextFreeHostAddress('203.0.113.0/30', ['203.0.113.2']),
    '203.0.113.1',
  )
  assertEquals(
    nextFreeHostAddress('203.0.113.0/30', ['203.0.113.1', '203.0.113.2']),
    null,
  )
})

test('nextFreeHostAddress strips inet /prefix suffixes from used set', () => {
  assertEquals(
    nextFreeHostAddress('203.0.113.0/30', ['203.0.113.1/32']),
    '203.0.113.2',
  )
})
