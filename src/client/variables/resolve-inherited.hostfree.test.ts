/**
 * Host-free inherited variable resolution coverage.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  mergeHostingVariablesForService,
  resolveInheritedVariablesForEnvironment,
  resolveInheritedVariablesForHosting,
  resolveInheritedVariablesForService,
  resolveServerScopedVariables,
  type ResolvedVariableMap,
} from './resolve-inherited.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function variableRow(
  key: string,
  value: string,
) {
  return {
    key,
    value,
    isSecret: false,
    isLiteral: false,
    forBuild: false,
    forRuntime: true,
  }
}

test('resolveInheritedVariablesForService returns empty when service missing', async () => {
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db

  assertEquals((await resolveInheritedVariablesForService(db, 'missing')).size, 0)
})

test('resolveInheritedVariablesForService later scopes override earlier ones', async () => {
  let varLoads = 0
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      organizationId: 'org',
                      workspaceId: 'ws',
                      projectId: 'proj',
                      environmentId: 'env',
                    },
                  ]),
              }),
            }),
          }),
        }),
        where: () => {
          varLoads += 1
          // org → workspace → project → environment → service
          const packs: unknown[][] = [
            [variableRow('A', 'org'), variableRow('B', 'org-b')],
            [variableRow('A', 'ws')],
            [],
            [variableRow('B', 'env-b')],
            [variableRow('C', 'svc')],
          ]
          return thenableRows(packs[varLoads - 1] ?? [])
        },
      }),
    }),
  } as unknown as Db

  const map = await resolveInheritedVariablesForService(db, 'svc')
  assertEquals(map.get('A')?.value, 'ws')
  assertEquals(map.get('B')?.value, 'env-b')
  assertEquals(map.get('C')?.value, 'svc')
})

test('mergeHostingVariablesForService sorts hosting ids for deterministic overrides', async () => {
  let call = 0
  const map: ResolvedVariableMap = new Map()
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1
          if (call === 1) {
            return thenableRows([{ id: 'h-b' }, { id: 'h-a' }])
          }
          if (call === 2) {
            return thenableRows([variableRow('K', 'from-a')])
          }
          return thenableRows([variableRow('K', 'from-b')])
        },
      }),
    }),
  } as unknown as Db

  await mergeHostingVariablesForService(db, 'svc', map)
  assertEquals(map.get('K')?.value, 'from-b')
})

test('resolveServerScopedVariables loads server parent only', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([variableRow('HOST_ONLY', '1')]),
      }),
    }),
  } as unknown as Db
  const map = await resolveServerScopedVariables(db, 'srv')
  assertEquals(map.get('HOST_ONLY')?.value, '1')
  assertEquals(map.size, 1)
})

test('resolveInheritedVariablesForEnvironment returns empty for missing env', async () => {
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals((await resolveInheritedVariablesForEnvironment(db, 'e')).size, 0)
})

test('resolveInheritedVariablesForHosting returns empty for missing hosting', async () => {
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve([]),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals((await resolveInheritedVariablesForHosting(db, 'h')).size, 0)
})

test('resolveInheritedVariablesForEnvironment merges org through environment scopes', async () => {
  let varLoads = 0
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    organizationId: 'org',
                    workspaceId: 'ws',
                    projectId: 'proj',
                  },
                ]),
            }),
          }),
        }),
        where: () => {
          varLoads += 1
          const packs: unknown[][] = [
            [variableRow('KEY', 'org')],
            [variableRow('KEY', 'ws')],
            [variableRow('KEY', 'proj')],
            [variableRow('KEY', 'env')],
          ]
          return thenableRows(packs[varLoads - 1] ?? [])
        },
      }),
    }),
  } as unknown as Db

  const map = await resolveInheritedVariablesForEnvironment(db, 'env')
  assertEquals(map.get('KEY')?.value, 'env')
  assertEquals(varLoads, 4)
})

test('resolveInheritedVariablesForHosting merges through hosting scope', async () => {
  let varLoads = 0
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        organizationId: 'org',
                        workspaceId: 'ws',
                        projectId: 'proj',
                        environmentId: 'env',
                        serviceId: 'svc',
                      },
                    ]),
                }),
              }),
            }),
          }),
        }),
        where: () => {
          varLoads += 1
          const packs: unknown[][] = [
            [variableRow('PORT', 'org')],
            [],
            [],
            [variableRow('PORT', 'env-only')],
            [variableRow('PORT', 'svc')],
            [variableRow('PORT', 'host')],
          ]
          return thenableRows(packs[varLoads - 1] ?? [])
        },
      }),
    }),
  } as unknown as Db

  const map = await resolveInheritedVariablesForHosting(db, 'hosting')
  assertEquals(map.get('PORT')?.value, 'host')
  assertEquals(varLoads, 6)
})

test('mergeHostingVariablesForService no-ops when service has no hostings', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([]),
      }),
    }),
  } as unknown as Db
  const map: ResolvedVariableMap = new Map([
    ['KEEP', {
      value: '1',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    }],
  ])
  await mergeHostingVariablesForService(db, 'svc', map)
  assertEquals(map.get('KEEP')?.value, '1')
  assertEquals(map.size, 1)
})

test('resolveInheritedVariablesForService preserves secret and build flags', async () => {
  let varLoads = 0
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      organizationId: 'org',
                      workspaceId: 'ws',
                      projectId: 'proj',
                      environmentId: 'env',
                    },
                  ]),
              }),
            }),
          }),
        }),
        where: () => {
          varLoads += 1
          if (varLoads === 5) {
            return thenableRows([
              {
                key: 'SECRET',
                value: 'sealed',
                isSecret: true,
                isLiteral: true,
                forBuild: true,
                forRuntime: false,
              },
            ])
          }
          return thenableRows([])
        },
      }),
    }),
  } as unknown as Db

  const map = await resolveInheritedVariablesForService(db, 'svc')
  const entry = map.get('SECRET')
  if (!entry) throw new TypeError('expected SECRET entry')
  assertEquals(entry.isSecret, true)
  assertEquals(entry.isLiteral, true)
  assertEquals(entry.forBuild, true)
  assertEquals(entry.forRuntime, false)
})
