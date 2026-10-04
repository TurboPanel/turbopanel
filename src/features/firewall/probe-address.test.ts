import { assertEquals } from '@std/assert'
import { classifyProbeAddress, mayProbeAddress } from './probe-address.ts'

const test = Deno.test.bind(Deno)

const FORBIDDEN = [
  '127.0.0.1',
  '127.8.8.8',
  '0.0.0.0',
  '0.1.2.3',
  '169.254.169.254',
  '169.254.0.1',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  '192.0.0.8',
  '192.0.2.10',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '::',
  '::1',
  'fe80::1',
  'febf::1',
  'fec0::1',
  'ff02::1',
  '2001:db8::1',
  '64:ff9b::808:808',
  '::ffff:127.0.0.1',
  '::ffff:169.254.169.254',
  '::10.0.0.1',
  'not an address',
  '',
  '999.1.1.1',
  '1.2.3',
  '1.2.3.4.5',
  'fe80::1%eth0',
  '1::2::3',
  '12345::1',
  'gggg::1',
]

const PRIVATE = [
  '10.0.0.1',
  '10.255.255.254',
  '172.16.0.1',
  '172.31.255.1',
  '192.168.1.1',
  '100.64.0.1',
  '100.127.255.254',
  'fc00::1',
  'fd12:3456:789a::1',
  '::ffff:10.1.2.3',
]

const PUBLIC = [
  '93.184.216.34',
  '1.1.1.1',
  '8.8.8.8',
  '172.15.0.1',
  '172.32.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '192.167.1.1',
  '2606:4700:4700::1111',
  '2a00:1450:4001::200e',
  '::ffff:8.8.8.8',
]

test('loopback, link-local, metadata, multicast, reserved and malformed addresses are forbidden', () => {
  for (const address of FORBIDDEN) {
    assertEquals(classifyProbeAddress(address), 'forbidden', address)
  }
})

test('private networks are classified private', () => {
  for (const address of PRIVATE) {
    assertEquals(classifyProbeAddress(address), 'private', address)
  }
})

test('ordinary routable addresses are public', () => {
  for (const address of PUBLIC) {
    assertEquals(classifyProbeAddress(address), 'public', address)
  }
})

test('a forbidden address is never probed, a private one only when the platform can reach it', () => {
  for (const canReachPrivate of [true, false]) {
    for (const address of FORBIDDEN) {
      assertEquals(mayProbeAddress(address, canReachPrivate), false, address)
    }
    for (const address of PUBLIC) {
      assertEquals(mayProbeAddress(address, canReachPrivate), true, address)
    }
  }
  for (const address of PRIVATE) {
    assertEquals(mayProbeAddress(address, true), true, address)
    assertEquals(mayProbeAddress(address, false), false, address)
  }
})

test('surrounding whitespace does not change the answer', () => {
  assertEquals(classifyProbeAddress(' 169.254.169.254 '), 'forbidden')
  assertEquals(classifyProbeAddress(' 93.184.216.34 '), 'public')
})
