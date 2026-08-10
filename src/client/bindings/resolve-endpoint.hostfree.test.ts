/**
 * Host-free placement + member list helpers for binding endpoints.
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
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
      protocolPort: 5432,
    }),
    { kind: 'binding_endpoint_unavailable' },
  )
})
