/**
 * Host-free coverage for organization source-id loading (mock Db).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  adoptProjectRepository,
  composeSourceIds,
  loadOrganizationRepositoryIds,
} from './repository-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function sourceDb(rows: Array<{ id: string }>): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Db
}

test('loadOrganizationRepositoryIds returns a set of ids', async () => {
  const ids = await loadOrganizationRepositoryIds(
    sourceDb([{ id: 'src-a' }, { id: 'src-b' }]),
    'org-1',
  )
  assertEquals(ids, new Set(['src-a', 'src-b']))
})

test('loadOrganizationRepositoryIds returns an empty set when none exist', async () => {
  const ids = await loadOrganizationRepositoryIds(sourceDb([]), 'org-1')
  assertEquals(ids.size, 0)
})

const SOURCE_A = '01989d42-9adb-7e65-bc2e-f38792c53691'
const SOURCE_B = '01989d42-9adb-7e65-bc2e-f38792c53692'

/** `options` as the write boundary hands it over. */
function optionsWithSources(
  bindings: Record<string, string | null>,
): Record<string, unknown> {
  const services: Record<string, unknown> = {}
  for (const [name, sourceId] of Object.entries(bindings)) {
    services[name] = sourceId === null
      ? { image: 'nginx' }
      : { image: 'nginx', 'x-turbopanel': { source: { sourceId } } }
  }
  return { compose: { version: 1, data: { services } } }
}

test('composeSourceIds returns nothing for options without compose', () => {
  assertEquals(composeSourceIds(null), [])
  assertEquals(composeSourceIds(undefined), [])
  assertEquals(composeSourceIds({ defaultServerId: 'srv-1' }), [])
})

test('composeSourceIds ignores services with no binding', () => {
  assertEquals(composeSourceIds(optionsWithSources({ db: null })), [])
})

test('composeSourceIds deduplicates one repository across services', () => {
  assertEquals(
    composeSourceIds(optionsWithSources({ api: SOURCE_A, web: SOURCE_A })),
    [SOURCE_A],
  )
})

test('composeSourceIds reads services in stable key order', () => {
  assertEquals(
    composeSourceIds(optionsWithSources({ web: SOURCE_B, api: SOURCE_A })),
    [SOURCE_A, SOURCE_B],
  )
})

/** Records the values an `update().set()` was called with. */
function updateSpy(): { db: Db; sets: Record<string, unknown>[] } {
  const sets: Record<string, unknown>[] = []
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values)
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db
  return { db, sets }
}

test('adoptProjectRepository binds the repository the compose names', async () => {
  const { db, sets } = updateSpy()
  await adoptProjectRepository(
    db,
    'project-1',
    optionsWithSources({ api: SOURCE_A }),
    null,
  )
  assertEquals(sets, [{ repositoryId: SOURCE_A }])
})

test('adoptProjectRepository leaves an already-bound project alone', async () => {
  const { db, sets } = updateSpy()
  await adoptProjectRepository(
    db,
    'project-1',
    optionsWithSources({ api: SOURCE_B }),
    SOURCE_A,
  )
  assertEquals(sets, [])
})

test('adoptProjectRepository does nothing when the compose names no repository', async () => {
  const { db, sets } = updateSpy()
  await adoptProjectRepository(db, 'project-1', optionsWithSources({ db: null }), null)
  assertEquals(sets, [])
})
