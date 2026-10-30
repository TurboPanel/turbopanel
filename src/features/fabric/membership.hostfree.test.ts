/**
 * Host-free coverage for per-server TurboFabric membership: the automatic
 * role, operator overrides and the dependents that block switching a server
 * out of the mesh.
 */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { replica, subnet } from '../../db/schema.ts'
import {
  automaticFabricRole,
  fabricDependentsMessage,
  findFabricDependents,
  resolveFabricRole,
} from './membership.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('automaticFabricRole: a public address makes a gateway, none makes a client', () => {
  assertEquals(automaticFabricRole('203.0.113.7'), 'gateway')
  assertEquals(automaticFabricRole(null), 'client')
})

test('resolveFabricRole: an operator choice wins, anything else is automatic', () => {
  assertEquals(resolveFabricRole('client', 'gateway'), { role: 'client', roleSource: 'operator' })
  assertEquals(resolveFabricRole('gateway', 'client'), {
    role: 'gateway',
    roleSource: 'operator',
  })
  assertEquals(resolveFabricRole(null, 'gateway'), { role: 'gateway', roleSource: 'automatic' })
  // The old relay vocabulary is never read as a server role.
  assertEquals(resolveFabricRole('member', 'client'), { role: 'client', roleSource: 'automatic' })
})

function rows<T>(value: T[]) {
  const promise = Promise.resolve(value)
  return Object.assign(promise, { limit: () => promise })
}

/**
 * Answers the dependent queries by the table they start from: subnets
 * (container networks), replicas (the server's clusters, then the ones
 * replicating over the fabric), bindings (app connections) and relays (LAN
 * gateway). Joins are accepted and ignored.
 */
function dependentsDb(opts: {
  networks: Array<{
    id: string
    name: string | null
    composeKey: string | null
    environmentName: string | null
  }>
  clusters: Array<{ managedId: string }>
  fabricClusters: Array<{ id: string; name: string | null }>
}): Db {
  const chain = (table: unknown, distinct: boolean) => {
    let joined = false
    const node = {
      innerJoin: () => {
        joined = true
        return node
      },
      leftJoin: () => node,
      where: () => {
        if (table === subnet) return rows(opts.networks)
        if (table === replica && distinct && !joined) return rows(opts.clusters)
        if (table === replica) return rows(opts.fabricClusters)
        return rows([])
      },
    }
    return node
  }
  return {
    select: () => ({ from: (table: unknown) => chain(table, false) }),
    selectDistinct: () => ({ from: (table: unknown) => chain(table, true) }),
  } as unknown as Db
}

test('findFabricDependents names cross-server container networks and fabric replication', async () => {
  const found = await findFabricDependents(
    dependentsDb({
      networks: [{ id: 'net-1', name: 'tpn_x', composeKey: 'app', environmentName: 'production' }],
      clusters: [{ managedId: 'm-1' }],
      fabricClusters: [{ id: 'm-1', name: 'orders' }],
    }),
    { serverId: 'srv-1', organizationId: 'org-1' }
  )
  assertEquals(found, [
    {
      kind: 'container_network',
      id: 'net-1',
      label: 'container network "app" in environment "production"',
    },
    { kind: 'database_replication', id: 'm-1', label: 'replication of managed database "orders"' },
  ])
})

test('findFabricDependents is empty for a server nothing reaches over the fabric', async () => {
  const found = await findFabricDependents(
    dependentsDb({ networks: [], clusters: [], fabricClusters: [] }),
    { serverId: 'srv-1', organizationId: 'org-1' }
  )
  assertEquals(found, [])
})

test('fabricDependentsMessage is one plain sentence naming what depends on the server', () => {
  assertEquals(
    fabricDependentsMessage('web-1', [
      { kind: 'container_network', id: 'n', label: 'container network "app"' },
    ]),
    'TurboFabric stays on for web-1 because container network "app" reaches it over TurboFabric. Move or remove it first, then switch TurboFabric off for this server.'
  )
  assertEquals(
    fabricDependentsMessage('web-1', [
      { kind: 'container_network', id: 'n', label: 'container network "app"' },
      { kind: 'database_replication', id: 'm', label: 'replication of managed database "orders"' },
    ]).includes('reach it over TurboFabric. Move or remove them first'),
    true
  )
})

test('fabricDependentsMessage gives the LAN-sharing refusal its own sentence', () => {
  assertEquals(
    fabricDependentsMessage('gw-1', [
      { kind: 'lan_gateway', id: 'dc', label: 'datacenter "rack-a"' },
    ]),
    'This server is the only one sharing the LAN of datacenter "rack-a" over TurboFabric. Let another server share it first, or stop sharing it.'
  )
  assertEquals(
    fabricDependentsMessage('gw-1', [
      { kind: 'container_network', id: 'n', label: 'container network "app"' },
      { kind: 'lan_gateway', id: 'dc', label: 'datacenter "rack-a"' },
    ]),
    'TurboFabric stays on for gw-1 because container network "app" reaches it over TurboFabric. Move or remove it first, then switch TurboFabric off for this server. This server is the only one sharing the LAN of datacenter "rack-a" over TurboFabric. Let another server share it first, or stop sharing it.'
  )
})
