import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { ManagedMemberRow } from '../managed/members.ts'
import {
  BINDING_ENDPOINT_UNAVAILABLE_ERROR,
  BINDING_NO_PRIVATE_PATH_MESSAGE,
  BINDING_PUBLISHED_LISTENER_UNREACHABLE_MESSAGE,
  remoteBindingReachError,
} from './binding-reach.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DB_SERVER = '11111111-1111-4111-8111-111111111111'
const FAILOVER_SERVER = '22222222-2222-4222-8222-222222222222'
const APP_SERVER = '55555555-5555-4555-8555-555555555555'
const MANAGED_ID = '00000000-0000-4000-8000-000000000001'

type MembershipPinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}

function memberRow(serverId: string, role: 'primary' | 'replica' = 'primary'): ManagedMemberRow {
  return {
    id: `member-${serverId}`,
    managedId: MANAGED_ID,
    serverId,
    role,
    replicaClass: role === 'replica' ? 'failover' : null,
    readEligible: true,
    ordinal: role === 'primary' ? 1 : 2,
    replicationTransport: null,
    privatePort: 45_001,
    status: 'ready',
    metadata: {},
    options: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

function fixtureDb(params: {
  members: ManagedMemberRow[]
  memberships?: MembershipPinRow[]
  relays?: Array<{
    relayId: string
    serverId: string
    fabricId: string
    fabricCreatedAt: string
    address: string
  }>
  publicAddresses?: Array<{ serverId: string; address: string }>
}): Db {
  const memberships = params.memberships ?? []
  const relays = params.relays ?? []
  const publicAddresses = params.publicAddresses ?? []
  const datacenterOptions = [...new Set(memberships.map((row) => row.datacenterId))]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, options: {} }))

  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
      const keySet = new Set(keys)
      if (keySet.has('managedId') && keySet.has('serverId') && keySet.has('ordinal')) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => thenable(params.members),
            }),
          }),
        }
      }
      if (keySet.has('ipId') && keySet.has('networkId') && keySet.has('address')) {
        return { from: () => ({ where: () => thenable(memberships) }) }
      }
      if (keys.length === 2 && keySet.has('serverId') && keySet.has('address')) {
        return {
          from: () => ({
            where: () => ({ orderBy: () => thenable(publicAddresses) }),
          }),
        }
      }
      if (keys.length === 1 && keySet.has('fabricId')) {
        return {
          from: () => ({
            where: () => thenable(relays.map((row) => ({ fabricId: row.fabricId }))),
          }),
        }
      }
      if (keySet.has('relayId') && keySet.has('fabricCreatedAt')) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => ({ orderBy: () => thenable(relays) }),
            }),
          }),
        }
      }
      if (keys.length === 2 && keySet.has('id') && keySet.has('options')) {
        return { from: () => ({ where: () => thenable(datacenterOptions) }) }
      }
      throw new TypeError(`unexpected select keys: ${keys.join(',')}`)
    },
  } as unknown as Db
}

test('remoteBindingReachError is null when the app is co-resident', async () => {
  const error = await remoteBindingReachError(fixtureDb({ members: [memberRow(DB_SERVER)] }), {
    managedId: MANAGED_ID,
    consumerServerIds: [DB_SERVER],
  })
  assertEquals(error, null)
})

test('remoteBindingReachError is null when a private datacenter path exists', async () => {
  const error = await remoteBindingReachError(
    fixtureDb({
      members: [memberRow(DB_SERVER)],
      memberships: [
        {
          ipId: 'ip-db',
          serverId: DB_SERVER,
          datacenterId: 'dc-a',
          networkId: null,
          address: '10.0.0.1',
        },
        {
          ipId: 'ip-app',
          serverId: APP_SERVER,
          datacenterId: 'dc-a',
          networkId: null,
          address: '10.0.0.9',
        },
      ],
    }),
    { managedId: MANAGED_ID, consumerServerIds: [APP_SERVER] }
  )
  assertEquals(error, null)
})

test('remoteBindingReachError refuses when the app host has no private path', async () => {
  const error = await remoteBindingReachError(fixtureDb({ members: [memberRow(DB_SERVER)] }), {
    managedId: MANAGED_ID,
    consumerServerIds: [APP_SERVER],
  })
  assertEquals(error, {
    error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
    message: BINDING_NO_PRIVATE_PATH_MESSAGE,
  })
})

test('remoteBindingReachError refuses when the published bind disagrees with the consumer path', async () => {
  const error = await remoteBindingReachError(
    fixtureDb({
      members: [memberRow(DB_SERVER), memberRow(FAILOVER_SERVER, 'replica')],
      memberships: [
        {
          ipId: 'ip-db',
          serverId: DB_SERVER,
          datacenterId: 'dc-a',
          networkId: null,
          address: '10.0.0.1',
        },
        {
          ipId: 'ip-failover',
          serverId: FAILOVER_SERVER,
          datacenterId: 'dc-a',
          networkId: null,
          address: '10.0.0.2',
        },
      ],
      relays: [
        {
          relayId: 'relay-app',
          serverId: APP_SERVER,
          fabricId: 'fab-1',
          fabricCreatedAt: '2026-01-01T00:00:00.000Z',
          address: '10.90.0.9',
        },
        {
          relayId: 'relay-db',
          serverId: DB_SERVER,
          fabricId: 'fab-1',
          fabricCreatedAt: '2026-01-01T00:00:00.000Z',
          address: '10.90.0.1',
        },
      ],
    }),
    { managedId: MANAGED_ID, consumerServerIds: [APP_SERVER] }
  )
  assertEquals(error, {
    error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
    message: BINDING_PUBLISHED_LISTENER_UNREACHABLE_MESSAGE,
  })
})
