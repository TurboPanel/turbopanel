import { assertEquals } from '@std/assert'
import { daemonAllowedIpsRefusal } from './daemon-allowed-ips-oracle.test.support.ts'
import {
  advertisedRangeProblemMessage,
  checkAdvertisedRangeOverlaps,
  checkAdvertisedRanges,
  checkAdvertisedRangesAgainstPool,
  checkAdvertisedRangeShape,
  safeAdvertisedRangesByGateway,
} from './advertised-ranges.ts'

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
  otherGateways: [] as { serverId: string; cidrs: string[] }[],
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

test('a range that covers the fabric range is refused, whatever its size', () => {
  const problem = checkAdvertisedRanges(['10.0.0.0/8'], context)
  assertEquals(problem?.code, 'overlaps_fabric')
  assertEquals(
    advertisedRangeProblemMessage(problem as NonNullable<typeof problem>),
    '10.0.0.0/8 overlaps the fabric address range 10.250.0.0/16'
  )
})

test('checkAdvertisedRanges runs the shape check before the overlap check', () => {
  assertEquals(checkAdvertisedRanges(['0.0.0.0/0'], context)?.code, 'too_broad')
  assertEquals(checkAdvertisedRanges(['8.8.8.0/24'], context)?.code, 'not_private')
  assertEquals(checkAdvertisedRanges(['192.168.5.0/24', '172.16.4.0/24'], context), null)
})

const withGateways = {
  ...context,
  otherGateways: [{ serverId: 'srv-b', cidrs: ['192.168.0.0/16', '172.16.0.0/16', 'fd00:1::/48'] }],
}

test('a partly overlapping or nested range of another gateway is refused, naming it', () => {
  for (const cidr of ['192.168.4.0/24', '172.16.0.0/12', 'fd00:1:0:5::/64']) {
    const problem = checkAdvertisedRanges([cidr], withGateways)
    assertEquals(problem?.code, 'overlaps_gateway', cidr)
    assertEquals(problem?.otherServerId, 'srv-b', cidr)
  }
  const message = advertisedRangeProblemMessage(
    checkAdvertisedRanges(['192.168.4.0/24'], withGateways) as never
  )
  assertEquals(message.includes('192.168.4.0/24'), true)
  assertEquals(message.includes('192.168.0.0/16'), true)
  assertEquals(message.includes('srv-b'), true)
})

test('two gateways may advertise the very same range', () => {
  assertEquals(checkAdvertisedRanges(['192.168.0.0/16'], withGateways), null)
  assertEquals(checkAdvertisedRanges(['fd00:1::/48'], withGateways), null)
  assertEquals(checkAdvertisedRanges(['172.20.0.0/16', 'fd00:2::/48'], withGateways), null)
})

test('a candidate pool is refused when it swallows a gateway range', () => {
  assertEquals(
    checkAdvertisedRangesAgainstPool(['192.168.0.0/16', '10.200.4.0/24'], '10.192.0.0/12')?.cidr,
    '10.200.4.0/24'
  )
  assertEquals(checkAdvertisedRangesAgainstPool(['192.168.0.0/16'], '10.192.0.0/12'), null)
})

test('safeAdvertisedRangesByGateway drops what the daemon would refuse, smaller id first', () => {
  const safe = safeAdvertisedRangesByGateway(
    [
      { id: 'g3', serverId: 's3', cidrs: ['192.168.4.0/24', '172.16.0.0/16'] },
      { id: 'g1', serverId: 's1', cidrs: ['10.0.0.0/8', '192.168.0.0/16'] },
      { id: 'g2', serverId: 's2', cidrs: ['172.16.0.0/16', '0.0.0.0/0'] },
    ],
    context
  )
  assertEquals(safe.get('g1'), ['192.168.0.0/16'])
  assertEquals(safe.get('g2'), ['172.16.0.0/16'])
  assertEquals(safe.get('g3'), ['172.16.0.0/16'])
})

test('every range the policy keeps passes the daemon rules', () => {
  const candidates = [
    '10.0.0.0/8',
    '10.250.4.0/24',
    '10.200.0.0/24',
    '10.193.4.0/24',
    '10.30.0.0/16',
    '10.30.5.0/24',
    '192.168.0.0/16',
    '192.168.4.0/24',
    '172.16.0.0/12',
    '172.20.0.0/16',
    '100.64.0.0/10',
    '8.8.8.0/24',
    '0.0.0.0/0',
    'fd00:1::/48',
    'fd00:1:0:5::/64',
    'fd00:2::/48',
    'fc00::/7',
    '2001:db8::/48',
  ]
  const safe = safeAdvertisedRangesByGateway(
    candidates.map((cidr, index) => ({
      id: `g${String(index).padStart(2, '0')}`,
      serverId: `s${index}`,
      cidrs: [cidr],
    })),
    context
  )
  const peers = [...safe.values()].map((cidrs) => ({ allowedIPs: cidrs }))
  const self = { address: '10.250.0.9', prefix: '10.194.0.0/16' }
  assertEquals(daemonAllowedIpsRefusal({ ...self, peers }), null)
  assertEquals(
    daemonAllowedIpsRefusal({ ...self, peers: [{ allowedIPs: ['10.0.0.0/8'] }] })?.includes(
      'overlaps'
    ),
    true
  )
})
