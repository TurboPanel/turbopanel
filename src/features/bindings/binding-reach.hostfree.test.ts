import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  BINDING_ENDPOINT_UNAVAILABLE_ERROR,
  BINDING_NO_PRIVATE_PATH_MESSAGE,
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
const APP_SERVER = '55555555-5555-4555-8555-555555555555'

type MembershipPinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

function fixtureDb(params: {
  memberServerIds: string[]
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
  let selectN = 0

  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
      const keySet = new Set(keys)
      selectN += 1
      if (selectN === 1 && keySet.has('serverId') && keys.length === 1) {
        return {
          from: () => ({
            where: () => thenable(params.memberServerIds.map((serverId) => ({ serverId }))),
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
  const error = await remoteBindingReachError(fixtureDb({ memberServerIds: [DB_SERVER] }), {
    managedId: 'm1',
    consumerServerIds: [DB_SERVER],
  })
  assertEquals(error, null)
})

test('remoteBindingReachError is null when a private datacenter path exists', async () => {
  const error = await remoteBindingReachError(
    fixtureDb({
      memberServerIds: [DB_SERVER],
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
    { managedId: 'm1', consumerServerIds: [APP_SERVER] }
  )
  assertEquals(error, null)
})

test('remoteBindingReachError refuses when the app host has no private path', async () => {
  const error = await remoteBindingReachError(fixtureDb({ memberServerIds: [DB_SERVER] }), {
    managedId: 'm1',
    consumerServerIds: [APP_SERVER],
  })
  assertEquals(error, {
    error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
    message: BINDING_NO_PRIVATE_PATH_MESSAGE,
  })
})
