/**
 * Host-free coverage for datacenter membership address/CIDR helpers.
 */

import { assertEquals } from '@std/assert'
import {
  loadDatacenterMembershipsForServers,
  reportedCidrForAddress,
  resolveSubnetForAddress,
  siteCidrForAddress,
  validateMemberPinAddress,
} from './datacenter-membership.ts'
import type { DatacenterSubnetRow } from './datacenter-networks.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createQueuedDb(
  queue: Array<Array<Record<string, unknown>>>,
): Parameters<typeof loadDatacenterMembershipsForServers>[0] {
  let i = 0
  return {
    select() {
      const value = queue[i++] ?? []
      return {
        from() {
          return {
            where() {
              return {
                then(
                  resolve: (v: unknown) => unknown,
                  reject?: (e: unknown) => unknown,
                ) {
                  return Promise.resolve(value).then(resolve, reject)
                },
              }
            },
          }
        },
      }
    },
  } as unknown as Parameters<typeof loadDatacenterMembershipsForServers>[0]
}

const V4_SUBNET: DatacenterSubnetRow = {
  networkId: 'net-v4',
  cidr: '203.0.113.0/24',
  version: 4,
  name: null,
}
const V6_SUBNET: DatacenterSubnetRow = {
  networkId: 'net-v6',
  cidr: '2001:db8::/32',
  version: 6,
  name: null,
}

test('reportedCidrForAddress uses the aligned interface prefix', () => {
  const metadata = {
    ips: [
      { address: '10.0.0.10', version: 4, scope: 'private', cidr: '10.0.0.10/24' },
    ],
  }
  assertEquals(reportedCidrForAddress(metadata, '10.0.0.10'), '10.0.0.0/24')
  assertEquals(reportedCidrForAddress(metadata, '10.0.0.11'), null)
  assertEquals(
    reportedCidrForAddress(
      { ips: [{ address: '10.0.0.10', version: 4, scope: 'private' }] },
      '10.0.0.10',
    ),
    null,
  )
  assertEquals(reportedCidrForAddress(null, '10.0.0.10'), null)
})

test('siteCidrForAddress infers a typical LAN when the prefix is omitted', () => {
  const withoutPrefix = {
    ips: [{ address: '10.0.0.10', version: 4, scope: 'private' }],
  }
  assertEquals(siteCidrForAddress(withoutPrefix, '10.0.0.10'), '10.0.0.0/24')
  assertEquals(reportedCidrForAddress(withoutPrefix, '10.0.0.10'), null)
  assertEquals(
    siteCidrForAddress(
      {
        ips: [
          {
            address: '10.0.0.10',
            version: 4,
            scope: 'private',
            cidr: '10.0.0.10/16',
          },
        ],
      },
      '10.0.0.10',
    ),
    '10.0.0.0/16',
  )
  assertEquals(siteCidrForAddress(withoutPrefix, '10.0.0.11'), null)
})

test('validateMemberPinAddress still requires a reported host IP in CIDR', () => {
  const metadata = {
    ips: [
      { address: '10.0.0.10', version: 4, scope: 'private', cidr: '10.0.0.0/24' },
    ],
  }
  assertEquals(
    validateMemberPinAddress('10.0.0.10', '10.0.0.0/24', metadata),
    { ok: true, address: '10.0.0.10' },
  )
  assertEquals(
    validateMemberPinAddress('10.0.0.10', '10.0.1.0/24', metadata).ok,
    false,
  )
  assertEquals(
    validateMemberPinAddress('10.0.0.11', '10.0.0.0/24', metadata).ok,
    false,
  )
})

test('resolveSubnetForAddress matches the first containing subnet', () => {
  const subnets = [V6_SUBNET, V4_SUBNET]
  assertEquals(
    resolveSubnetForAddress(subnets, '203.0.113.10'),
    V4_SUBNET,
  )
  assertEquals(resolveSubnetForAddress(subnets, '2001:db8::10'), V6_SUBNET)
  assertEquals(resolveSubnetForAddress(subnets, '198.51.100.10'), null)
  assertEquals(resolveSubnetForAddress([V4_SUBNET], '2001:db8::10'), null)
})

test('validateMemberPinAddress matches a later subnet and returns its networkId', () => {
  const metadata = {
    ips: [
      {
        address: '203.0.113.10',
        version: 4,
        scope: 'private',
        cidr: '203.0.113.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress(
      '203.0.113.10',
      [V6_SUBNET, V4_SUBNET],
      metadata,
    ),
    { ok: true, address: '203.0.113.10', networkId: 'net-v4' },
  )
})

test('validateMemberPinAddress rejects an address in no subnet', () => {
  const metadata = {
    ips: [
      {
        address: '198.51.100.10',
        version: 4,
        scope: 'private',
        cidr: '198.51.100.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress('198.51.100.10', [V4_SUBNET, V6_SUBNET], metadata),
    { ok: false, error: 'address_not_in_any_subnet' },
  )
})

test('validateMemberPinAddress rejects a matching address that is not reported', () => {
  const metadata = {
    ips: [
      {
        address: '203.0.113.11',
        version: 4,
        scope: 'private',
        cidr: '203.0.113.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress('203.0.113.10', [V4_SUBNET], metadata),
    { ok: false, error: 'address_not_reported' },
  )
})

test('loadDatacenterMembershipsForServers derives family for v4 and v6 pins', async () => {
  const db = createQueuedDb([[
    {
      ipId: 'ip-v4',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
    },
    {
      ipId: 'ip-v6',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v6',
      address: '2001:db8::10',
    },
    {
      ipId: 'ip-bad',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-bad',
      address: 'not-an-ip',
    },
  ]])
  const map = await loadDatacenterMembershipsForServers(db, ['s1'])
  assertEquals(map.get('s1'), [
    {
      ipId: 'ip-v4',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
      family: 4,
    },
    {
      ipId: 'ip-v6',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v6',
      address: '2001:db8::10',
      family: 6,
    },
  ])
})
