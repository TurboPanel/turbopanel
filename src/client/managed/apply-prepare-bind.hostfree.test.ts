/**
 * Host-free coverage for the managed private-listener bind resolver (no
 * Postgres). The bind is derived by reverse-resolving every remote peer back to
 * this member, so these fixtures drive `resolvePrivateEndpoints` directly.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ManagedMemberRow } from './members.ts'
import { resolveMemberPrivateBindAddress } from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRIMARY_SERVER = '11111111-1111-4111-8111-111111111111'
const FAILOVER_SERVER = '22222222-2222-4222-8222-222222222222'
const READ_SERVER = '33333333-3333-4333-8333-333333333333'

type MembershipPinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}

type RelayRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
}

type Fixture = {
  memberships?: MembershipPinRow[]
  relays?: RelayRow[]
  publicAddresses?: Array<{ serverId: string; address: string }>
}

function membershipPin(
  serverId: string,
  datacenterId: string,
  address: string,
): MembershipPinRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}-${address}`,
    serverId,
    datacenterId,
    networkId: null,
    address,
  }
}

function relayRow(serverId: string, address: string): RelayRow {
  return {
    relayId: `relay-${serverId}`,
    serverId,
    fabricId: 'fab-1',
    fabricCreatedAt: '2026-01-01T00:00:00.000Z',
    address,
  }
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

/**
 * Routes `resolvePrivateEndpoints` batch queries by projected field keys (same
 * approach as the private-endpoint pure tests).
 */
function fixtureDb(fixture: Fixture): Db {
  const memberships = fixture.memberships ?? []
  const relays = fixture.relays ?? []
  const publicAddresses = fixture.publicAddresses ?? []
  const datacenterOptions = [
    ...new Set(memberships.map((row) => row.datacenterId)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, options: {} }))

  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
      const keySet = new Set(keys)

      // loadDatacenterMembershipsForServers
      if (keySet.has('ipId') && keySet.has('networkId') && keySet.has('address')) {
        return { from: () => ({ where: () => thenable(memberships) }) }
      }

      // loadPublicAddressesForServers
      if (keys.length === 2 && keySet.has('serverId') && keySet.has('address')) {
        return {
          from: () => ({
            where: () => ({ orderBy: () => thenable(publicAddresses) }),
          }),
        }
      }

      // fabric membership probe
      if (keys.length === 1 && keySet.has('fabricId')) {
        return {
          from: () => ({
            where: () =>
              thenable(relays.map((row) => ({ fabricId: row.fabricId }))),
          }),
        }
      }

      // relay join
      if (keySet.has('relayId') && keySet.has('fabricCreatedAt')) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => ({ orderBy: () => thenable(relays) }),
            }),
          }),
        }
      }

      // loadDatacenterAddressPreferences
      if (keys.length === 2 && keySet.has('id') && keySet.has('options')) {
        return { from: () => ({ where: () => thenable(datacenterOptions) }) }
      }

      throw new TypeError(`unexpected select keys: ${keys.join(',')}`)
    },
  } as unknown as Db
}

function memberRow(
  overrides: Pick<ManagedMemberRow, 'id' | 'serverId' | 'role' | 'ordinal'> &
    Partial<ManagedMemberRow>,
): ManagedMemberRow {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    managedId: '44444444-4444-4444-8444-444444444444',
    replicaClass: overrides.role === 'replica' ? 'failover' : null,
    readEligible: overrides.role !== 'replica',
    replicationTransport: null,
    privatePort: 45_001,
    status: 'ready',
    metadata: null,
    options: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function primary(): ManagedMemberRow {
  return memberRow({
    id: 'member-primary',
    serverId: PRIMARY_SERVER,
    role: 'primary',
    ordinal: 1,
  })
}

function failoverReplica(): ManagedMemberRow {
  return memberRow({
    id: 'member-failover',
    serverId: FAILOVER_SERVER,
    role: 'replica',
    ordinal: 2,
    replicaClass: 'failover',
  })
}

function readReplica(serverId = READ_SERVER): ManagedMemberRow {
  return memberRow({
    id: 'member-read',
    serverId,
    role: 'replica',
    ordinal: 3,
    replicaClass: 'read',
    readEligible: true,
  })
}

test('a single-member cluster publishes no private listener', async () => {
  const sole = primary()
  assertEquals(
    await resolveMemberPrivateBindAddress({} as Db, sole, [sole]),
    undefined,
  )
})

test('co-resident members need no published bind', async () => {
  const member = primary()
  const coResident = readReplica(PRIMARY_SERVER)
  assertEquals(
    await resolveMemberPrivateBindAddress({} as Db, member, [
      member,
      coResident,
    ]),
    undefined,
  )
})

test('the bind is the datacenter address a same-datacenter peer dials', async () => {
  const member = primary()
  const bind = await resolveMemberPrivateBindAddress(
    fixtureDb({
      memberships: [
        membershipPin(PRIMARY_SERVER, 'dc-a', '10.0.0.1'),
        membershipPin(FAILOVER_SERVER, 'dc-a', '10.0.0.2'),
      ],
    }),
    member,
    [member, failoverReplica()],
  )
  assertEquals(bind, { address: '10.0.0.1', transport: 'datacenter' })
})

test('a read replica on the fabric binds this member relay address', async () => {
  const member = primary()
  const bind = await resolveMemberPrivateBindAddress(
    fixtureDb({
      relays: [
        relayRow(PRIMARY_SERVER, '10.90.0.1'),
        relayRow(READ_SERVER, '10.90.0.3'),
      ],
    }),
    member,
    [member, readReplica()],
  )
  assertEquals(bind, { address: '10.90.0.1', transport: 'fabric' })
})

test('a remote public read replica binds this member public address', async () => {
  const member = primary()
  const bind = await resolveMemberPrivateBindAddress(
    fixtureDb({
      publicAddresses: [
        { serverId: PRIMARY_SERVER, address: '203.0.113.1' },
        { serverId: READ_SERVER, address: '203.0.113.3' },
      ],
    }),
    member,
    [member, readReplica()],
  )
  assertEquals(bind, { address: '203.0.113.1', transport: 'public' })
})

test('a same-datacenter failover replica plus a remote public read replica is rejected', async () => {
  const member = primary()
  const result = await resolveMemberPrivateBindAddress(
    fixtureDb({
      memberships: [
        membershipPin(PRIMARY_SERVER, 'dc-a', '10.0.0.1'),
        membershipPin(FAILOVER_SERVER, 'dc-a', '10.0.0.2'),
      ],
      publicAddresses: [
        { serverId: PRIMARY_SERVER, address: '203.0.113.1' },
        { serverId: READ_SERVER, address: '203.0.113.3' },
      ],
    }),
    member,
    [member, failoverReplica(), readReplica()],
  )
  // One `privateListener` cannot serve a datacenter dial and a public dial.
  assertEquals(result, {
    kind: 'managed_listener_bind_conflict',
    serverId: PRIMARY_SERVER,
  })
})

test('a failover peer never falls back to fabric or public on re-apply', async () => {
  const member = primary()
  const result = await resolveMemberPrivateBindAddress(
    fixtureDb({
      // No shared datacenter: fabric + public exist but are off-limits for a
      // failover link, so the bind must fail instead of publishing one.
      relays: [
        relayRow(PRIMARY_SERVER, '10.90.0.1'),
        relayRow(FAILOVER_SERVER, '10.90.0.2'),
      ],
      publicAddresses: [
        { serverId: PRIMARY_SERVER, address: '203.0.113.1' },
        { serverId: FAILOVER_SERVER, address: '203.0.113.2' },
      ],
    }),
    member,
    [member, failoverReplica()],
  )
  assertEquals(result, {
    kind: 'private_path_unavailable',
    fromServerId: FAILOVER_SERVER,
    toServerId: PRIMARY_SERVER,
  })
})

test('a legacy null replica class is treated as failover for the bind', async () => {
  const member = primary()
  const legacy = memberRow({
    id: 'member-legacy',
    serverId: FAILOVER_SERVER,
    role: 'replica',
    ordinal: 2,
    replicaClass: null,
  })
  const result = await resolveMemberPrivateBindAddress(
    fixtureDb({
      relays: [
        relayRow(PRIMARY_SERVER, '10.90.0.1'),
        relayRow(FAILOVER_SERVER, '10.90.0.2'),
      ],
    }),
    member,
    [member, legacy],
  )
  assertEquals(result, {
    kind: 'private_path_unavailable',
    fromServerId: FAILOVER_SERVER,
    toServerId: PRIMARY_SERVER,
  })
})

test('agreeing remote peers collapse to one bind', async () => {
  const member = primary()
  const bind = await resolveMemberPrivateBindAddress(
    fixtureDb({
      memberships: [
        membershipPin(PRIMARY_SERVER, 'dc-a', '10.0.0.1'),
        membershipPin(FAILOVER_SERVER, 'dc-a', '10.0.0.2'),
        membershipPin(READ_SERVER, 'dc-a', '10.0.0.3'),
      ],
    }),
    member,
    [member, failoverReplica(), readReplica()],
  )
  assertEquals(bind, { address: '10.0.0.1', transport: 'datacenter' })
})

test('a replica publishes the address the primary dials', async () => {
  const replica = failoverReplica()
  const bind = await resolveMemberPrivateBindAddress(
    fixtureDb({
      memberships: [
        membershipPin(PRIMARY_SERVER, 'dc-a', '10.0.0.1'),
        membershipPin(FAILOVER_SERVER, 'dc-a', '10.0.0.2'),
      ],
    }),
    replica,
    [primary(), replica],
  )
  assertEquals(bind, { address: '10.0.0.2', transport: 'datacenter' })
})
