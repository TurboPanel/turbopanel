/**
 * Host-free placement + member list helpers for binding endpoints.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  consumerServerIdsForManaged,
  isBindingEndpointError,
  loadServicePlacementServerId,
  memberServerIdsForManaged,
  resolveBindingEndpoint,
} from './resolve-endpoint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableLimit(rows: unknown[]) {
  return {
    limit: () => Promise.resolve(rows),
  }
}

test('loadServicePlacementServerId returns null when service missing', async () => {
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => thenableLimit([]),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await loadServicePlacementServerId(db, 'missing'), null)
})

test('loadServicePlacementServerId prefers environment server over project default', async () => {
  const envServer = '00000000-0000-4000-8000-0000000000e1'
  const projectServer = '00000000-0000-4000-8000-0000000000f1'
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () =>
              thenableLimit([
                {
                  environmentServerId: envServer,
                  projectOptions: { defaultServerId: projectServer },
                },
              ]),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await loadServicePlacementServerId(db, 'svc'), envServer)

  const projectOnly = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () =>
              thenableLimit([
                {
                  environmentServerId: null,
                  projectOptions: { defaultServerId: projectServer },
                },
              ]),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await loadServicePlacementServerId(projectOnly, 'svc'),
    projectServer,
  )
})

function consumerServerQuery(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                leftJoin: () => ({
                  where: () => Promise.resolve(rows),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
}

test('consumerServerIdsForManaged uses environment pin', async () => {
  const envServer = '00000000-0000-4000-8000-0000000000c1'
  const db = consumerServerQuery([
    {
      environmentServerId: envServer,
      projectOptions: null,
      taskServerId: null,
    },
  ])
  assertEquals(await consumerServerIdsForManaged(db, 'm1'), [envServer])
})

test('consumerServerIdsForManaged uses project default when env is unpinned', async () => {
  const projectServer = '00000000-0000-4000-8000-0000000000c2'
  const db = consumerServerQuery([
    {
      environmentServerId: null,
      projectOptions: { defaultServerId: projectServer },
      taskServerId: null,
    },
  ])
  assertEquals(await consumerServerIdsForManaged(db, 'm1'), [projectServer])
})

test('consumerServerIdsForManaged unions task pin with effective placement', async () => {
  const envServer = '00000000-0000-4000-8000-0000000000c3'
  const taskServer = '00000000-0000-4000-8000-0000000000c4'
  const db = consumerServerQuery([
    {
      environmentServerId: envServer,
      projectOptions: null,
      taskServerId: taskServer,
    },
  ])
  const ids = await consumerServerIdsForManaged(db, 'm1')
  assertEquals(ids.includes(envServer), true)
  assertEquals(ids.includes(taskServer), true)
  assertEquals(ids.length, 2)
})

test('memberServerIdsForManaged maps node rows', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { serverId: 's1' },
            { serverId: 's2' },
          ]),
      }),
    }),
  } as unknown as Db
  assertEquals(await memberServerIdsForManaged(db, 'm1'), ['s1', 's2'])
})

test('resolveBindingEndpoint unavailable when cluster has no members', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await resolveBindingEndpoint(db, {
      serviceId: 'svc',
      managedId: 'm1',
      engineCode: 'postgres',
      engineDefaultPort: 5432,
    }),
    { kind: 'binding_endpoint_unavailable' },
  )
})

test('resolveBindingEndpoint unavailable when listener server has no organization', async () => {
  let n = 0
  const db = {
    select: () => {
      n += 1
      if (n === 1) {
        // loadClusterMembers
        return {
          from: () => ({
            where: () => ({
              orderBy: () =>
                Promise.resolve([
                  {
                    serverId: 'srv-1',
                    role: 'primary',
                    ordinal: 1,
                    readEligible: false,
                  },
                ]),
            }),
          }),
        }
      }
      if (n === 2) {
        // loadServicePlacementServerId → miss (fall back to member)
        return {
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => thenableLimit([]),
              }),
            }),
          }),
        }
      }
      // listenerForServer: server row without organizationId
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => thenableLimit([{ organizationId: null }]),
          }),
        }),
      }
    },
  } as unknown as Db

  assertEquals(
    await resolveBindingEndpoint(db, {
      serviceId: 'svc',
      managedId: 'm1',
      engineCode: 'postgres',
      engineDefaultPort: 5432,
    }),
    { kind: 'binding_endpoint_unavailable' },
  )
})

test('isBindingEndpointError covers unavailable and non-errors', () => {
  assertEquals(
    isBindingEndpointError({ kind: 'binding_endpoint_unavailable' }),
    true,
  )
  assertEquals(isBindingEndpointError({ host: 'x', port: 1 }), false)
  assertEquals(isBindingEndpointError(null), false)
})
