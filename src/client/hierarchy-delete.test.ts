import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { Db } from '../db.ts'
import {
  HIERARCHY_DELETE_HAS_CHILDREN_ERROR,
  hierarchyDeleteHasChildrenResponse,
  isForeignKeyViolation,
  runHierarchyDelete,
} from './hierarchy-delete.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isForeignKeyViolation detects Postgres FK and restrict codes', () => {
  assertEquals(isForeignKeyViolation({ code: '23503' }), true)
  assertEquals(isForeignKeyViolation({ code: '23001' }), true)
  assertEquals(isForeignKeyViolation({ cause: { code: '23503' } }), true)
  assertEquals(isForeignKeyViolation({ code: '23505' }), false)
  assertEquals(isForeignKeyViolation(null), false)
  assertEquals(isForeignKeyViolation('nope'), false)
})

test('runHierarchyDelete returns ok when the transaction succeeds', async () => {
  const db = {
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn({} as Db)
    },
  } as unknown as Db

  const result = await runHierarchyDelete(db, async () => {})
  assertEquals(result, 'ok')
})

test('runHierarchyDelete maps FK violations to has_children', async () => {
  const db = {
    transaction: async () => {
      throw { code: '23503' }
    },
  } as unknown as Db

  assertEquals(await runHierarchyDelete(db, async () => {}), 'has_children')
})

test('runHierarchyDelete rethrows unrelated errors', async () => {
  const db = {
    transaction: async () => {
      throw new Error('boom')
    },
  } as unknown as Db

  await assertRejects(
    () => runHierarchyDelete(db, async () => {}),
    Error,
    'boom',
  )
})

test('hierarchyDeleteHasChildrenResponse returns 409 JSON', async () => {
  const app = new Hono()
  app.delete('/resource', (c) => hierarchyDeleteHasChildrenResponse(c))

  const res = await app.request('http://localhost/resource', { method: 'DELETE' })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: HIERARCHY_DELETE_HAS_CHILDREN_ERROR })
})
