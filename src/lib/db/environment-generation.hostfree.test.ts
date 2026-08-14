/**
 * Host-free coverage for environment generation bumps (no Postgres).
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { bumpEnvironmentGeneration } from './environment-generation.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createBumpDb(rows: Array<{ generation: number }>): Db {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

test('bumpEnvironmentGeneration returns the new generation', async () => {
  const db = createBumpDb([{ generation: 4 }])
  assertEquals(
    await bumpEnvironmentGeneration(db, '00000000-0000-4000-8000-000000000001'),
    4,
  )
})

test('bumpEnvironmentGeneration throws when the environment is missing', async () => {
  const db = createBumpDb([])
  await assertRejects(
    () => bumpEnvironmentGeneration(db, 'missing'),
    TypeError,
    'environment missing not found',
  )
})
