import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  ALL_INTERFACES_BIND,
  isManagedAccessAddressError,
  LOOPBACK_BIND,
  resolveManagedBindAddress,
  resolveManagedDialHost,
  type ManagedAddressLoaders,
} from './access-address.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isManagedAccessAddressError recognizes only bind/dial resolution failures', () => {
  assertEquals(isManagedAccessAddressError(null), false)
  assertEquals(isManagedAccessAddressError('datacenter_ip_required'), false)
  assertEquals(isManagedAccessAddressError({ kind: 'other' }), false)
  assertEquals(
    isManagedAccessAddressError({
      kind: 'datacenter_ip_required',
      serverId: '550e8400-e29b-41d4-a716-446655440000',
    }),
    true,
  )
  assertEquals(
    isManagedAccessAddressError({
      kind: 'fabric_address_required',
      serverId: '550e8400-e29b-41d4-a716-446655440000',
    }),
    true,
  )
})

test('bind constants stay loopback and all-interfaces wildcards', () => {
  assertEquals(LOOPBACK_BIND, '127.0.0.1')
  assertEquals(ALL_INTERFACES_BIND, '0.0.0.0')
})

const SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const DC_ADDR = '203.0.113.10'
const FABRIC_ADDR = '198.51.100.20'
const PUBLIC_ADDR = '203.0.113.50'
const unusedDb = {} as Db

function loaders(overrides: ManagedAddressLoaders = {}): ManagedAddressLoaders {
  return {
    loadDatacenterAddress: async () => DC_ADDR,
    loadFabricAddress: async () => FABRIC_ADDR,
    loadPublicAddress: async () => PUBLIC_ADDR,
    loadHostname: async () => 'edge.example',
    ...overrides,
  }
}

test('resolveManagedBindAddress maps each scope without widening on miss', async () => {
  assertEquals(
    await resolveManagedBindAddress(unusedDb, { serverId: SERVER_ID, scope: 'local' }, loaders()),
    LOOPBACK_BIND,
  )
  assertEquals(
    await resolveManagedBindAddress(unusedDb, { serverId: SERVER_ID, scope: 'public' }, loaders()),
    ALL_INTERFACES_BIND,
  )
  assertEquals(
    await resolveManagedBindAddress(
      unusedDb,
      { serverId: SERVER_ID, scope: 'datacenter' },
      loaders(),
    ),
    DC_ADDR,
  )
  assertEquals(
    await resolveManagedBindAddress(
      unusedDb,
      { serverId: SERVER_ID, scope: 'turbofabric' },
      loaders(),
    ),
    FABRIC_ADDR,
  )
  assertEquals(
    await resolveManagedBindAddress(
      unusedDb,
      { serverId: SERVER_ID, scope: 'datacenter' },
      loaders({ loadDatacenterAddress: async () => null }),
    ),
    { kind: 'datacenter_ip_required', serverId: SERVER_ID },
  )
  assertEquals(
    await resolveManagedBindAddress(
      unusedDb,
      { serverId: SERVER_ID, scope: 'turbofabric' },
      loaders({ loadFabricAddress: async () => null }),
    ),
    { kind: 'fabric_address_required', serverId: SERVER_ID },
  )
})

test('resolveManagedDialHost prefers a pinned public IP then hostname', async () => {
  assertEquals(
    await resolveManagedDialHost(unusedDb, { serverId: SERVER_ID, scope: 'local' }, loaders()),
    LOOPBACK_BIND,
  )
  assertEquals(
    await resolveManagedDialHost(
      unusedDb,
      { serverId: SERVER_ID, scope: 'datacenter' },
      loaders(),
    ),
    DC_ADDR,
  )
  assertEquals(
    await resolveManagedDialHost(
      unusedDb,
      { serverId: SERVER_ID, scope: 'turbofabric' },
      loaders(),
    ),
    FABRIC_ADDR,
  )
  assertEquals(
    await resolveManagedDialHost(unusedDb, { serverId: SERVER_ID, scope: 'public' }, loaders()),
    PUBLIC_ADDR,
  )
  assertEquals(
    await resolveManagedDialHost(
      unusedDb,
      { serverId: SERVER_ID, scope: 'public' },
      loaders({ loadPublicAddress: async () => null }),
    ),
    'edge.example',
  )
  assertEquals(
    await resolveManagedDialHost(
      unusedDb,
      { serverId: SERVER_ID, scope: 'public' },
      loaders({
        loadPublicAddress: async () => null,
        loadHostname: async () => null,
      }),
    ),
    null,
  )
})

test('resolveManagedDialHost trims a hostname from the default column read', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ hostname: '  edge.lan  ' }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await resolveManagedDialHost(db, { serverId: SERVER_ID, scope: 'public' }, {
      loadPublicAddress: async () => null,
    }),
    'edge.lan',
  )
  const empty = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ hostname: '   ' }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await resolveManagedDialHost(empty, { serverId: SERVER_ID, scope: 'public' }, {
      loadPublicAddress: async () => null,
    }),
    null,
  )
})
