/**
 * Host-free VPN tunnel IP allocation stubs (no Postgres).
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  allocateVpnTunnelIp,
  allocateVpnTunnelIpOnce,
  createVpnTunnelIpAt,
  createVpnTunnelIpAtOnce,
  isAddressInVpnCidr,
  releaseVpnTunnelIpIfOrphaned,
} from './vpn-address-allocator.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableLimit(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

/** Minimal sequential select/from/where/limit queue. */
function selectQueue(responses: unknown[][]): {
  db: Db
  remaining: () => number
} {
  let i = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = responses[i] ?? []
          i += 1
          return thenableLimit(rows)
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () =>
          Promise.resolve([
            {
              id: 'ip-new',
              address: '10.8.0.2/32',
            },
          ]),
      }),
    }),
    delete: () => ({
      where: () => thenableLimit([]),
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  } as unknown as Db
  return { db, remaining: () => responses.length - i }
}

test('allocateVpnTunnelIpOnce returns vpn_not_found', async () => {
  const { db } = selectQueue([[]])
  assertEquals(
    await allocateVpnTunnelIpOnce(db, {
      vpnId: 'vpn',
      serverId: 'srv',
    }),
    { kind: 'vpn_not_found' },
  )
})

test('allocateVpnTunnelIpOnce allocates next free address and names from server', async () => {
  // 1) vpn row 2) server row 3) used addresses
  const { db } = selectQueue([
    [{ organizationId: 'org', cidr: '10.8.0.0/30' }],
    [{ displayName: '  edge  ', hostname: 'edge.local' }],
    [{ address: '10.8.0.1/32' }],
  ])
  // /30 hosts: .1 network-ish nextFreeHostAddress from lib
  const result = await allocateVpnTunnelIpOnce(db, {
    vpnId: 'vpn',
    serverId: 'srv',
  })
  assertEquals('ipId' in result, true)
  if ('ipId' in result) {
    assertEquals(result.ipId, 'ip-new')
    assertEquals(result.address.includes('10.8.0.'), true)
  }
})

test('allocateVpnTunnelIpOnce pool exhausted', async () => {
  const { db } = selectQueue([
    [{ organizationId: 'org', cidr: '10.8.0.0/32' }],
    [{ displayName: null, hostname: null }],
    [{ address: '10.8.0.0' }],
  ])
  assertEquals(
    await allocateVpnTunnelIpOnce(db, { vpnId: 'vpn', serverId: 'srv' }),
    { kind: 'vpn_address_pool_exhausted' },
  )
})

test('allocateVpnTunnelIp retries once on unique violation then exhausted', async () => {
  let attempts = 0
  const db = {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      attempts += 1
      const err = Object.assign(
        new Error('duplicate key value violates unique constraint "uniq_ip_vpn_address"'),
        { code: '23505' },
      )
      throw err
    },
  } as unknown as Db

  assertEquals(
    await allocateVpnTunnelIp(db, { vpnId: 'vpn', serverId: 'srv' }),
    { kind: 'vpn_address_pool_exhausted' },
  )
  assertEquals(attempts, 2)
})

test('allocateVpnTunnelIp rethrows non-unique errors', async () => {
  const db = {
    transaction: async () => {
      throw new TypeError('boom')
    },
  } as unknown as Db
  await assertRejects(
    () => allocateVpnTunnelIp(db, { vpnId: 'vpn', serverId: 'srv' }),
    TypeError,
    'boom',
  )
})

test('createVpnTunnelIpAt rejects invalid addresses', async () => {
  assertEquals(
    await createVpnTunnelIpAt({} as Db, {
      vpnId: 'vpn',
      serverId: 'srv',
      address: 'not-an-ip',
    }),
    { kind: 'vpn_address_out_of_cidr' },
  )
})

test('createVpnTunnelIpAtOnce maps out of cidr and inserts in-range', async () => {
  const out = selectQueue([
    [{ organizationId: 'org', cidr: '10.8.0.0/24' }],
    [{ displayName: null, hostname: 'host' }],
    [], // contained miss
  ])
  assertEquals(
    await createVpnTunnelIpAtOnce(out.db, {
      vpnId: 'vpn',
      serverId: 'srv',
      address: '10.8.0.9',
    }),
    { kind: 'vpn_address_out_of_cidr' },
  )

  const ok = selectQueue([
    [{ organizationId: 'org', cidr: '10.8.0.0/24' }],
    [{ displayName: 'gw', hostname: null }],
    [{ id: 'vpn' }], // contained
  ])
  const result = await createVpnTunnelIpAtOnce(ok.db, {
    vpnId: 'vpn',
    serverId: 'srv',
    address: '10.8.0.9',
  })
  assertEquals('ipId' in result && result.ipId, 'ip-new')
})

test('createVpnTunnelIpAt maps unique violation to conflict', async () => {
  const db = {
    transaction: async () => {
      throw Object.assign(new Error('uniq_ip_vpn_address'), { code: '23505' })
    },
  } as unknown as Db
  assertEquals(
    await createVpnTunnelIpAt(db, {
      vpnId: 'vpn',
      serverId: 'srv',
      address: '10.8.0.5',
    }),
    { kind: 'vpn_address_conflict' },
  )
})

test('isAddressInVpnCidr rejects invalid and missing', async () => {
  assertEquals(await isAddressInVpnCidr({} as Db, 'vpn', 'bad'), false)
  const miss = selectQueue([[]])
  assertEquals(await isAddressInVpnCidr(miss.db, 'vpn', '10.8.0.1'), false)
  const hit = selectQueue([[{ id: 'vpn' }]])
  assertEquals(await isAddressInVpnCidr(hit.db, 'vpn', '10.8.0.1'), true)
})

test('releaseVpnTunnelIpIfOrphaned skips when peer still references', async () => {
  let deleted = false
  const ref = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ id: 'peer-1' }]),
      }),
    }),
    delete: () => {
      deleted = true
      return { where: () => thenableLimit([]) }
    },
  } as unknown as Db
  await releaseVpnTunnelIpIfOrphaned(ref, {
    vpnId: 'vpn',
    tunnelIpId: 'ip',
  })
  assertEquals(deleted, false)

  const orphan = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([]),
      }),
    }),
    delete: () => {
      deleted = true
      return { where: () => thenableLimit([]) }
    },
  } as unknown as Db
  deleted = false
  await releaseVpnTunnelIpIfOrphaned(orphan, {
    vpnId: 'vpn',
    tunnelIpId: 'ip',
  })
  assertEquals(deleted, true)
})
