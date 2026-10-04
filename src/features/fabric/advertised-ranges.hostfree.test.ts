import { assertEquals } from '@std/assert'
import { checkAdvertisedRangeOverlaps, checkAdvertisedRangeShape } from './advertised-ranges.ts'

// Sonar typescript:S2187 only recognizes `test()`; keep this alias.
const test = Deno.test.bind(Deno)

test('default routes and short prefixes are refused', () => {
  for (const cidr of ['0.0.0.0/0', '0.0.0.0/1', '128.0.0.0/1', '8.0.0.0/7', '::/0']) {
    assertEquals(checkAdvertisedRangeShape(cidr)?.code, 'too_broad', cidr)
  }
})

test('public, loopback, link-local and reserved ranges are refused', () => {
  for (const cidr of [
    '8.8.8.0/24',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '224.0.0.0/24',
    '2001:db8::/48',
    'fe80::/64',
  ]) {
    assertEquals(checkAdvertisedRangeShape(cidr)?.code, 'not_private', cidr)
  }
})

test('private ranges of sensible size pass', () => {
  for (const cidr of [
    '10.0.0.0/24',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '10.1.2.3/32',
    'fd00:1234:5678::/48',
  ]) {
    assertEquals(checkAdvertisedRangeShape(cidr), null, cidr)
  }
})

test('a very short IPv6 prefix is refused even inside ULA space', () => {
  assertEquals(checkAdvertisedRangeShape('fc00::/7')?.code, 'too_broad')
})

const context = {
  fabricCidr: '10.250.0.0/16',
  containerPool: '10.192.0.0/12',
  relayPrefixes: ['10.192.0.0/16', '10.193.0.0/16'],
}

test('overlap with the fabric range, pool or a member prefix is refused', () => {
  assertEquals(checkAdvertisedRangeOverlaps(['10.250.1.0/24'], context)?.code, 'overlaps_fabric')
  assertEquals(checkAdvertisedRangeOverlaps(['10.0.0.0/8'], context)?.code, 'overlaps_fabric')
  assertEquals(
    checkAdvertisedRangeOverlaps(['10.200.0.0/24'], context)?.code,
    'overlaps_fabric_pool'
  )
  assertEquals(
    checkAdvertisedRangeOverlaps(['10.193.4.0/24'], {
      ...context,
      containerPool: '10.100.0.0/16',
    })?.code,
    'overlaps_member'
  )
})

test('a free private range passes the overlap check', () => {
  assertEquals(checkAdvertisedRangeOverlaps(['192.168.5.0/24'], context), null)
})
