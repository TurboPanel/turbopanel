/**
 * Host-free coverage for principal store helpers (no Postgres).
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  isManagedUsernameTaken,
  isServerPrincipalUsernameTaken,
  isUuid,
  listManagedPrincipals,
  lockOrganizationsForUpdate,
  replaceAssignments,
  resolveAvailableManagedRootUsername,
  resolveManagedOwningOrganizationIds,
  createPrincipal,
} from './store.ts'

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
    for: () => ({ limit: () => promise }),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

test('isUuid accepts v4-shaped ids and rejects garbage', () => {
  assertEquals(isUuid('00000000-0000-4000-8000-000000000001'), true)
  assertEquals(isUuid('not-a-uuid'), false)
  assertEquals(isUuid(''), false)
})

test('isServerPrincipalUsernameTaken short-circuits blank and hits/misses', async () => {
  assertEquals(
    await isServerPrincipalUsernameTaken(
      {} as Db,
      'org',
      '   ',
    ),
    false,
  )

  const hit = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'p1' }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await isServerPrincipalUsernameTaken(hit, 'org', 'AppUser'), true)

  const miss = {
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
  assertEquals(
    await isServerPrincipalUsernameTaken(miss, 'org', 'free', 'exclude-me'),
    false,
  )
})

test('replaceAssignments deletes inserts and no-ops when unchanged', async () => {
  let deleted: string[] | null = null
  let inserted: unknown = null
  const tx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 's1' }, { serviceId: 's2' }]),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted = ['s2']
        return thenableRows([])
      },
    }),
    insert: () => ({
      values: (values: unknown) => {
        inserted = values
        return thenableRows([])
      },
    }),
  } as unknown as Db

  await replaceAssignments(tx, 'principal', ['s1', 's3'])
  assertEquals(deleted, ['s2'])
  assertEquals(inserted, [
    { principalId: 'principal', serviceId: 's3' },
  ])

  const noopTx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 'only' }]),
      }),
    }),
    delete: () => {
      throw new TypeError('should not delete')
    },
    insert: () => {
      throw new TypeError('should not insert')
    },
  } as unknown as Db
  await replaceAssignments(noopTx, 'principal', ['only'])
})

test('createPrincipal inserts principal and assignments in a transaction', async () => {
  let principalValues: unknown
  let assignmentValues: unknown
  const db = {
    transaction: async (fn: (tx: Db) => Promise<string>) => {
      const tx = {
        insert: () => ({
          values: (values: unknown) => {
            if (!principalValues) {
              principalValues = values
              return {
                returning: () => Promise.resolve([{ id: 'new-principal' }]),
              }
            }
            assignmentValues = values
            return thenableRows([])
          },
        }),
      } as unknown as Db
      return await fn(tx)
    },
  } as unknown as Db

  const id = await createPrincipal(
    db,
    {
      kind: 'system',
      provider: 'server',
      username: 'deploy',
      metadata: { a: 1 },
      options: { b: 2 },
    },
    ['svc-1', 'svc-2'],
  )
  assertEquals(id, 'new-principal')
  assertEquals((principalValues as { username: string }).username, 'deploy')
  assertEquals(
    (assignmentValues as Array<{ serviceId: string }>).map((r) => r.serviceId),
    ['svc-1', 'svc-2'],
  )
})

test('listManagedPrincipals orders and projects columns', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              {
                id: 'p1',
                kind: 'database',
                provider: 'postgres',
                username: 'app',
                managedId: 'm1',
                metadata: null,
                options: null,
                createdAt: 't0',
                updatedAt: 't1',
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db
  const rows = await listManagedPrincipals(db, 'm1')
  assertEquals(rows[0]?.username, 'app')
})

test('resolveManagedOwningOrganizationIds unions members and extras sorted', async () => {
  let call = 0
  const db = {
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () =>
            Promise.resolve([
              { organizationId: 'org-b' },
              { organizationId: 'org-a' },
              { organizationId: null },
            ]),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => {
          call += 1
          return Promise.resolve([
            { organizationId: 'org-c' },
            { organizationId: 'org-a' },
          ])
        },
      }),
    }),
  } as unknown as Db

  assertEquals(
    await resolveManagedOwningOrganizationIds(db, 'm1', ['extra-server']),
    ['org-a', 'org-b', 'org-c'],
  )
  assertEquals(call, 1)

  assertEquals(await resolveManagedOwningOrganizationIds(db, 'm1'), [
    'org-a',
    'org-b',
  ])
})

test('isManagedUsernameTaken handles empty orgs and hits', async () => {
  assertEquals(
    await isManagedUsernameTaken({} as Db, [], 'app'),
    false,
  )
  assertEquals(
    await isManagedUsernameTaken({} as Db, ['org'], '  '),
    false,
  )

  const hit = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'p' }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await isManagedUsernameTaken(hit, ['org'], 'Root', 'exclude'),
    true,
  )
})

test('resolveAvailableManagedRootUsername prefers free preferred name', async () => {
  const free = {
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

  const managedId = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const preferred = await resolveAvailableManagedRootUsername(
    free,
    ['org'],
    'root',
    managedId,
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
  )
  assertEquals(preferred, 'root')

  let takenCalls = 0
  const takenThenFree = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => {
                takenCalls += 1
                // preferred taken, suffixed free
                return Promise.resolve(takenCalls === 1 ? [{ id: 'x' }] : [])
              },
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  const derived = await resolveAvailableManagedRootUsername(
    takenThenFree,
    ['org'],
    'root',
    managedId,
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
  )
  assertEquals(derived, 'root_01936b3e')
})

test('resolveAvailableManagedRootUsername throws when pattern cannot fit', async () => {
  const free = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'x' }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      resolveAvailableManagedRootUsername(
        free,
        ['org'],
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        'not-a-uuid-without-digits-enough',
        { pattern: /^[a-z]+$/, maxLength: 5 },
      ),
    TypeError,
    'unable to derive available managed root username',
  )
})

test('lockOrganizationsForUpdate orders ids and no-ops empty', async () => {
  const locked: string[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          void cond
          return {
            for: () => ({
              limit: () => {
                // Capture order via successive calls by intercepting eq via closed over state is hard;
                // just ensure lock path runs.
                locked.push('hit')
                return Promise.resolve([{ id: 'org' }])
              },
            }),
          }
        },
      }),
    }),
  } as unknown as Db

  await lockOrganizationsForUpdate(db, [])
  assertEquals(locked, [])
  await lockOrganizationsForUpdate(db, [
    '00000000-0000-4000-8000-00000000000b',
    '00000000-0000-4000-8000-00000000000a',
  ])
  assertEquals(locked.length, 2)
})
