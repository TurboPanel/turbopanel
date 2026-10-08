import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  ALL_INTERFACES_BIND,
  LOOPBACK_BIND,
  resolveManagedExternalDialHost,
  type ManagedAddressLoaders,
} from './access-address.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('bind constants stay loopback and all-interfaces wildcards', () => {
  assertEquals(LOOPBACK_BIND, '127.0.0.1')
  assertEquals(ALL_INTERFACES_BIND, '0.0.0.0')
})

const SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const PUBLIC_ADDR = '203.0.113.50'
const unusedDb = {} as Db

function loaders(overrides: ManagedAddressLoaders = {}): ManagedAddressLoaders {
  return {
    loadPublicAddress: async () => PUBLIC_ADDR,
    loadHostname: async () => 'edge.example',
    ...overrides,
  }
}

test('resolveManagedExternalDialHost prefers a pinned public IP then hostname', async () => {
  assertEquals(await resolveManagedExternalDialHost(unusedDb, SERVER_ID, loaders()), PUBLIC_ADDR)
  assertEquals(
    await resolveManagedExternalDialHost(
      unusedDb,
      SERVER_ID,
      loaders({ loadPublicAddress: async () => null })
    ),
    'edge.example'
  )
  assertEquals(
    await resolveManagedExternalDialHost(
      unusedDb,
      SERVER_ID,
      loaders({
        loadPublicAddress: async () => null,
        loadHostname: async () => null,
      })
    ),
    null
  )
})

function hostnameDb(hostname: string): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ hostname }]),
        }),
      }),
    }),
  } as unknown as Db
}

test('resolveManagedExternalDialHost trims a hostname from the default column read', async () => {
  const noPinned = { loadPublicAddress: async () => null }
  assertEquals(
    await resolveManagedExternalDialHost(hostnameDb('  edge.lan  '), SERVER_ID, noPinned),
    'edge.lan'
  )
  assertEquals(await resolveManagedExternalDialHost(hostnameDb('   '), SERVER_ID, noPinned), null)
})
