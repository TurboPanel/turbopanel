import { assertEquals } from 'jsr:@std/assert'
import {
  WIREGUARD_DEFAULT_LISTEN_PORT,
  WIREGUARD_PERSISTENT_KEEPALIVE,
  isValidWireguardAllowedIp,
  isValidWireguardEndpoint,
  isValidWireguardListenPort,
  isValidWireguardPublicKey,
} from './wg.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('wireguard constants match product defaults', () => {
  assertEquals(WIREGUARD_DEFAULT_LISTEN_PORT, 51820)
  assertEquals(WIREGUARD_PERSISTENT_KEEPALIVE, 25)
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

test('isValidWireguardEndpoint rejects shell metacharacters and malformed hosts', () => {
  assertEquals(isValidWireguardEndpoint('host;rm:51820'), false)
  assertEquals(isValidWireguardEndpoint(':51820'), false)
  assertEquals(isValidWireguardEndpoint('host:'), false)
})
