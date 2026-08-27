/**
 * Host-free coverage for organization source-id loading (mock Db).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { loadOrganizationSourceIds } from './source-records.ts'

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

test('loadOrganizationSourceIds returns a set of ids', async () => {
  const ids = await loadOrganizationSourceIds(
    sourceDb([{ id: 'src-a' }, { id: 'src-b' }]),
    'org-1',
  )
  assertEquals(ids, new Set(['src-a', 'src-b']))
})

test('loadOrganizationSourceIds returns an empty set when none exist', async () => {
  const ids = await loadOrganizationSourceIds(sourceDb([]), 'org-1')
  assertEquals(ids.size, 0)
})
