import { assertEquals } from 'jsr:@std/assert'
import {
  WIREGUARD_DEFAULT_LISTEN_PORT,
  WIREGUARD_INTERFACE_MAX_LENGTH,
  WIREGUARD_PERSISTENT_KEEPALIVE,
  assertValidWireguardInterfaceName,
  deriveWireguardInterfaceName,
  isValidWireguardAllowedIp,
  isValidWireguardEndpoint,
  isValidWireguardInterfaceName,
  isValidWireguardListenPort,
  isValidWireguardPublicKey,
} from './wireguard.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('deriveWireguardInterfaceName is deterministic and within length limit', () => {
  const vpnId = '550e8400-e29b-41d4-a716-446655440000'
  const name = deriveWireguardInterfaceName(vpnId)
  assertEquals(name, 'tpwg550e8400')
  assertEquals(name, deriveWireguardInterfaceName(vpnId))
  assertEquals(name.length <= WIREGUARD_INTERFACE_MAX_LENGTH, true)
})

test('wireguard constants match product defaults', () => {
  assertEquals(WIREGUARD_DEFAULT_LISTEN_PORT, 51820)
  assertEquals(WIREGUARD_PERSISTENT_KEEPALIVE, 25)
})

test('isValidWireguardInterfaceName and assertValidWireguardInterfaceName', () => {
  assertEquals(isValidWireguardInterfaceName('tpwg550e8400'), true)
  assertEquals(isValidWireguardInterfaceName(''), false)
  assertEquals(isValidWireguardInterfaceName('tpwg-INVALID!'), false)
  assertValidWireguardInterfaceName('tpwg550e8400')
})

test('assertValidWireguardInterfaceName throws for invalid names', () => {
  let threw = false
  try {
    assertValidWireguardInterfaceName('bad name')
  } catch (error) {
    threw = true
    assertEquals(error instanceof Error, true)
    assertEquals((error as Error).message, 'Invalid WireGuard interface name')
  }
  assertEquals(threw, true)
})

test('isValidWireguardPublicKey rejects unsafe or malformed keys', () => {
  assertEquals(isValidWireguardPublicKey(WG_PUBKEY), true)
  assertEquals(isValidWireguardPublicKey('short'), false)
  assertEquals(isValidWireguardPublicKey(WG_PUBKEY + ' '), false)
  assertEquals(isValidWireguardPublicKey('echo;rm'), false)
})

test('isValidWireguardListenPort accepts only integer ports in range', () => {
  assertEquals(isValidWireguardListenPort(51820), true)
  assertEquals(isValidWireguardListenPort(0), false)
  assertEquals(isValidWireguardListenPort(70_000), false)
  assertEquals(isValidWireguardListenPort(1.5), false)
})

test('isValidWireguardEndpoint accepts hostname and IPv4/IPv6 literals', () => {
  assertEquals(isValidWireguardEndpoint('203.0.113.10:51820'), true)
  assertEquals(isValidWireguardEndpoint('[2001:db8::1]:51820'), true)
  assertEquals(isValidWireguardEndpoint('vpn.example.com:51820'), true)
  assertEquals(isValidWireguardEndpoint('bad'), false)
  assertEquals(isValidWireguardEndpoint('host:0'), false)
  assertEquals(isValidWireguardEndpoint('host:99999'), false)
})

test('isValidWireguardAllowedIp accepts CIDR strings', () => {
  assertEquals(isValidWireguardAllowedIp('203.0.113.10/32'), true)
  assertEquals(isValidWireguardAllowedIp('not-a-cidr'), false)
})

test('isValidWireguardInterfaceName rejects non-string values', () => {
  assertEquals(isValidWireguardInterfaceName(null), false)
  assertEquals(isValidWireguardInterfaceName(undefined), false)
})

test('isValidWireguardEndpoint rejects shell metacharacters and malformed hosts', () => {
  assertEquals(isValidWireguardEndpoint('host;rm:51820'), false)
  assertEquals(isValidWireguardEndpoint(':51820'), false)
  assertEquals(isValidWireguardEndpoint('host:'), false)
})
