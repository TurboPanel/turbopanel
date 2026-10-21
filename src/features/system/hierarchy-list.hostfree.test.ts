import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { listSystemEnvironmentIdsForServer } from './hierarchy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('listSystemEnvironmentIdsForServer returns every system environment on the server', async () => {
  const db = {
    execute: () => [{ id: 'env-a' }, { id: 'env-b' }],
  } as unknown as Db
  assertEquals(await listSystemEnvironmentIdsForServer(db, 'srv'), ['env-a', 'env-b'])
})
