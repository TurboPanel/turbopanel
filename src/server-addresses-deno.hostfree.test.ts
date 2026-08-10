/**
 * Host-free coverage for Deno interface address classification.
 */

import { assertEquals } from 'jsr:@std/assert'
import { collectServerAddresses } from './server-addresses-deno.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type FakeIface = {
  name: string
  family: 'IPv4' | 'IPv6'
  address: string
}

function withNetworkInterfaces(
  ifaces: FakeIface[],
  fn: () => void,
): void {
  const original = Deno.networkInterfaces
  // deno-lint-ignore no-explicit-any
  ;(Deno as any).networkInterfaces = () => ifaces
  try {
    fn()
  } finally {
    // deno-lint-ignore no-explicit-any
    ;(Deno as any).networkInterfaces = original
  }
}

test('collectServerAddresses classifies private/public IPv4 and skips virtual NICS', () => {
  withNetworkInterfaces(
    [
      { name: 'lo', family: 'IPv4', address: '127.0.0.1' },
      { name: 'docker0', family: 'IPv4', address: '172.17.0.1' },
      { name: 'br-abc', family: 'IPv4', address: '10.99.0.1' },
      { name: 'veth0a', family: 'IPv4', address: '169.254.1.1' },
      { name: 'wg0', family: 'IPv4', address: '10.8.0.1' },
      { name: 'eth0', family: 'IPv4', address: '10.0.0.5' },
      { name: 'eth0', family: 'IPv4', address: '192.168.1.10' },
      { name: 'eth0', family: 'IPv4', address: '172.16.4.2' },
      { name: 'eth0', family: 'IPv4', address: '203.0.113.9' },
      { name: 'eth0', family: 'IPv4', address: '169.254.8.8' },
      { name: 'eth0', family: 'IPv4', address: '127.0.0.9' },
      { name: 'eth0', family: 'IPv4', address: '224.0.0.1' },
      { name: 'eth0', family: 'IPv4', address: '0.1.2.3' },
      { name: 'eth0', family: 'IPv4', address: 'not-an-ip' },
    ],
    () => {
      assertEquals(collectServerAddresses(), {
        privateIpv4: ['10.0.0.5', '172.16.4.2', '192.168.1.10'],
        privateIpv6: [],
        publicIpv4: ['203.0.113.9'],
        publicIpv6: [],
      })
    },
  )
})

test('collectServerAddresses classifies IPv6 private ULAs public and skips unusable', () => {
  withNetworkInterfaces(
    [
      { name: 'lo', family: 'IPv6', address: '::1' },
      { name: 'eth0', family: 'IPv6', address: 'fe80::1' },
      { name: 'eth0', family: 'IPv6', address: 'ff02::1' },
      { name: 'eth0', family: 'IPv6', address: 'fd12:3456::1' },
      { name: 'eth0', family: 'IPv6', address: 'fc00::abcd' },
      { name: 'eth0', family: 'IPv6', address: '2001:db8::1' },
      { name: 'eth0', family: 'IPv6', address: '3ffe::1' },
      { name: 'tailscale0', family: 'IPv6', address: '2001:db8::99' },
      { name: 'eth0', family: 'IPv6', address: '0:0:0:0:0:0:0:1' },
    ],
    () => {
      const got = collectServerAddresses()
      assertEquals(got.privateIpv6, ['fc00::abcd', 'fd12:3456::1'])
      assertEquals(got.publicIpv6, ['2001:db8::1', '3ffe::1'])
      assertEquals(got.privateIpv4, [])
      assertEquals(got.publicIpv4, [])
    },
  )
})

test('collectServerAddresses sorts and dedupes addresses', () => {
  withNetworkInterfaces(
    [
      { name: 'eth1', family: 'IPv4', address: '10.0.0.2' },
      { name: 'eth0', family: 'IPv4', address: '10.0.0.1' },
      { name: 'eth0', family: 'IPv4', address: '10.0.0.1' },
      { name: 'eth0', family: 'IPv4', address: '198.51.100.2' },
      { name: 'eth0', family: 'IPv4', address: '198.51.100.1' },
    ],
    () => {
      assertEquals(collectServerAddresses().privateIpv4, ['10.0.0.1', '10.0.0.2'])
      assertEquals(collectServerAddresses().publicIpv4, [
        '198.51.100.1',
        '198.51.100.2',
      ])
    },
  )
})
