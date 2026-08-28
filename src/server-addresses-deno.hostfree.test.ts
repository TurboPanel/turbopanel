/**
 * Host-free coverage for Deno interface address classification.
 */

import { assertEquals } from '@std/assert'
import {
  collectServerIps,
  readDefaultRouteInterfaces,
} from './server-addresses-deno.ts'

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
  cidr?: string
  netmask?: string
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

test('collectServerIps classifies private/public IPv4 and skips virtual NICS', () => {
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
      assertEquals(collectServerIps(), [
        { address: '10.0.0.5', version: 4, scope: 'private', interface: 'eth0' },
        { address: '172.16.4.2', version: 4, scope: 'private', interface: 'eth0' },
        { address: '192.168.1.10', version: 4, scope: 'private', interface: 'eth0' },
        { address: '203.0.113.9', version: 4, scope: 'public', interface: 'eth0' },
      ])
    },
  )
})

test('collectServerIps classifies IPv6 private ULAs public and skips unusable', () => {
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
      const got = collectServerIps()
      assertEquals(
        got.filter((row) => row.scope === 'private').map((row) => row.address),
        ['fc00::abcd', 'fd12:3456::1'],
      )
      assertEquals(
        got.filter((row) => row.scope === 'public').map((row) => row.address),
        ['2001:db8::1', '3ffe::1'],
      )
      assertEquals(got.every((row) => row.version === 6), true)
    },
  )
})

test('collectServerIps sorts and dedupes addresses', () => {
  withNetworkInterfaces(
    [
      { name: 'eth1', family: 'IPv4', address: '10.0.0.2' },
      { name: 'eth0', family: 'IPv4', address: '10.0.0.1' },
      { name: 'eth0', family: 'IPv4', address: '10.0.0.1' },
      { name: 'eth0', family: 'IPv4', address: '198.51.100.2' },
      { name: 'eth0', family: 'IPv4', address: '198.51.100.1' },
    ],
    () => {
      assertEquals(
        collectServerIps().filter((row) => row.scope === 'private').map((row) => row.address),
        ['10.0.0.1', '10.0.0.2'],
      )
      assertEquals(
        collectServerIps().filter((row) => row.scope === 'public').map((row) => row.address),
        ['198.51.100.1', '198.51.100.2'],
      )
    },
  )
})

test('collectServerIps includes private interface CIDRs', () => {
  withNetworkInterfaces(
    [
      {
        name: 'eth0',
        family: 'IPv4',
        address: '10.0.0.5',
        cidr: '10.0.0.5/24',
      },
      {
        name: 'eth0',
        family: 'IPv4',
        address: '192.168.1.10',
        netmask: '255.255.255.0',
      },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: '10.0.0.5',
          version: 4,
          scope: 'private',
          cidr: '10.0.0.5/24',
          interface: 'eth0',
        },
        {
          address: '192.168.1.10',
          version: 4,
          scope: 'private',
          cidr: '192.168.1.10/24',
          interface: 'eth0',
        },
      ])
    },
  )
})

/**
 * `/proc/net/route`, tab-separated with a header row. Destination and mask are
 * little-endian hex; `00000000` for both marks the default route.
 */
const PROC_NET_ROUTE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth1\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  '',
].join('\n')

const PROC_NET_IPV6_ROUTE = [
  'fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000003 00000000 00000001       eth0',
  '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003       eth0',
  '',
].join('\n')

function withProcRoutes(
  files: Record<string, string>,
  fn: () => void,
): void {
  const original = Deno.readTextFileSync
  // deno-lint-ignore no-explicit-any
  ;(Deno as any).readTextFileSync = (path: string | URL) => {
    const key = String(path)
    if (key in files) return files[key]
    throw new Deno.errors.NotFound(key)
  }
  try {
    fn()
  } finally {
    // deno-lint-ignore no-explicit-any
    ;(Deno as any).readTextFileSync = original
  }
}

test('readDefaultRouteInterfaces picks the lowest-metric default route', () => {
  withProcRoutes(
    {
      '/proc/net/route': PROC_NET_ROUTE,
      '/proc/net/ipv6_route': PROC_NET_IPV6_ROUTE,
    },
    () => {
      assertEquals(readDefaultRouteInterfaces(), { v4: 'eth0', v6: 'eth0' })
    },
  )
})

test('readDefaultRouteInterfaces is empty when /proc is unreadable', () => {
  withProcRoutes({}, () => {
    assertEquals(readDefaultRouteInterfaces(), {})
  })
})

test('readDefaultRouteInterfaces ignores non-default and malformed rows', () => {
  withProcRoutes(
    {
      '/proc/net/route': [
        'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
        // On-link subnet route, not a default route.
        'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF',
        // Zero destination but a non-zero mask — not ::/0 either.
        'eth9\t00000000\t00000000\t0001\t0\t0\t1\t000000FF',
        'truncated',
        '',
      ].join('\n'),
    },
    () => {
      assertEquals(readDefaultRouteInterfaces(), {})
    },
  )
})

test('collectServerIps marks the default-route interface as preferred', () => {
  withNetworkInterfaces(
    [
      { name: 'eth1', family: 'IPv4', address: '10.20.0.7' },
      { name: 'eth0', family: 'IPv4', address: '192.168.1.50' },
    ],
    () => {
      assertEquals(collectServerIps({ v4: 'eth0' }), [
        {
          address: '10.20.0.7',
          version: 4,
          scope: 'private',
          interface: 'eth1',
        },
        {
          address: '192.168.1.50',
          version: 4,
          scope: 'private',
          interface: 'eth0',
          preferred: true,
        },
      ])
    },
  )
})

test('collectServerIps without a route table marks nothing', () => {
  withNetworkInterfaces(
    [{ name: 'eth0', family: 'IPv4', address: '192.168.1.50' }],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: '192.168.1.50',
          version: 4,
          scope: 'private',
          interface: 'eth0',
        },
      ])
    },
  )
})
