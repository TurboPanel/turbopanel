import { assertEquals } from '@std/assert'
import {
  bestReportedAddress,
  emptyServerIps,
  ipsFromDaemonPresence,
  parseServerIps,
  preferredIpv4FromIps,
  privateAddressesFromIps,
  publicIpv4FromIps,
  reportedIpsFromServerMetadata,
  serverIpsEquals,
  type ServerReportedIp,
} from './server-addresses.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRIVATE_V4: ServerReportedIp = {
  address: '203.0.113.10',
  version: 4,
  scope: 'private',
  cidr: '203.0.113.0/24',
  interface: 'eth0',
}

const PUBLIC_V4: ServerReportedIp = {
  address: '203.0.113.20',
  version: 4,
  scope: 'public',
  preferred: true,
}

const PUBLIC_V6: ServerReportedIp = {
  address: '2001:db8::1',
  version: 6,
  scope: 'public',
}

test('emptyServerIps returns a fresh empty array', () => {
  const a = emptyServerIps()
  const b = emptyServerIps()
  assertEquals(a, [])
  assertEquals(b, [])
  a.push(PRIVATE_V4)
  assertEquals(b, [])
})

test('parseServerIps rejects non-arrays and dedupes by address', () => {
  assertEquals(parseServerIps(null), undefined)
  assertEquals(parseServerIps({}), undefined)
  assertEquals(parseServerIps([]), [])
  const rows = parseServerIps([
    { address: '203.0.113.20/32', version: 4, scope: 'public' },
    { address: '203.0.113.20', version: 4, scope: 'public' },
    { address: '203.0.113.10', version: 4, scope: 'private', interface: '  enp1s0  ' },
    { address: 'bad', version: 9, scope: 'public' },
    { address: '203.0.113.11', version: 4, scope: 'unknown' },
    { interface: 'eth99' },
  ])
  assertEquals(rows?.map((r) => r.address), ['203.0.113.10', '203.0.113.20'])
  assertEquals(rows?.[0]?.interface, 'enp1s0')
})

test('parseServerIps sorts addresses and keeps optional fields', () => {
  const rows = parseServerIps([
    {
      address: '203.0.113.30',
      version: 4,
      scope: 'private',
      cidr: '203.0.113.0/25',
      preferred: true,
    },
    PUBLIC_V4,
  ])
  assertEquals(rows?.[0]?.address, '203.0.113.20')
  assertEquals(rows?.[1]?.preferred, true)
  assertEquals(rows?.[1]?.cidr, '203.0.113.0/25')
})

test('ipsFromDaemonPresence reads resources.ips', () => {
  assertEquals(ipsFromDaemonPresence(null), undefined)
  assertEquals(ipsFromDaemonPresence({ resources: {} }), undefined)
  assertEquals(ipsFromDaemonPresence({ resources: { ips: [] } }), [])
  const ips = ipsFromDaemonPresence({
    resources: { ips: [PUBLIC_V4, PRIVATE_V4] },
  })
  assertEquals(ips?.length, 2)
})

test('reportedIpsFromServerMetadata prefers nested resources.ips', () => {
  const nested = reportedIpsFromServerMetadata({
    resources: { ips: [PUBLIC_V4] },
    ips: [PRIVATE_V4],
  })
  assertEquals(nested?.[0]?.address, '203.0.113.20')

  const legacy = reportedIpsFromServerMetadata({ ips: [PRIVATE_V4] })
  assertEquals(legacy?.[0]?.address, '203.0.113.10')
})

test('serverIpsEquals compares normalized rows', () => {
  const left = [PUBLIC_V4, PRIVATE_V4]
  const right: ServerReportedIp[] = [
    {
      address: '203.0.113.10',
      version: 4,
      scope: 'private',
      cidr: '203.0.113.0/24',
      interface: 'eth0',
    },
    { address: '203.0.113.20', version: 4, scope: 'public', preferred: true },
  ]
  assertEquals(serverIpsEquals(left, right), true)
  assertEquals(serverIpsEquals(left, null), false)
  assertEquals(serverIpsEquals(left, left), true)
  assertEquals(
    serverIpsEquals(left, [{ ...PUBLIC_V4, preferred: false }]),
    false,
  )
})

test('privateAddressesFromIps and preferredIpv4FromIps', () => {
  const ips = [PRIVATE_V4, PUBLIC_V4]
  assertEquals(privateAddressesFromIps(ips), ['203.0.113.10'])
  assertEquals(preferredIpv4FromIps(ips), '203.0.113.20')
  assertEquals(preferredIpv4FromIps([PRIVATE_V4]), '203.0.113.10')
  assertEquals(publicIpv4FromIps(ips), '203.0.113.20')
  assertEquals(publicIpv4FromIps([PRIVATE_V4]), undefined)
})

test('bestReportedAddress follows public-before-private preference', () => {
  const row = bestReportedAddress([PRIVATE_V4, PUBLIC_V6, PUBLIC_V4])
  assertEquals(row?.address, '203.0.113.20')
  assertEquals(bestReportedAddress([]), undefined)
})
