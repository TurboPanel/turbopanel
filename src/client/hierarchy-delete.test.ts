import { assertEquals, assertRejects } from '@std/assert'
import { Hono } from 'hono'
import type { Db } from '../db/connection.ts'
import {
  HIERARCHY_DELETE_HAS_CHILDREN_CODE,
  HIERARCHY_DELETE_HAS_CHILDREN_ERROR,
  hierarchyDeleteHasChildrenMessage,
  hierarchyDeleteHasChildrenResponse,
  hierarchyDeleteHasChildrenResponseIfNeeded,
  isForeignKeyViolation,
  parsePostgresForeignKeyViolation,
  peekHierarchyDeleteFkViolation,
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

test('parsePostgresForeignKeyViolation reads table_name and constraint_name', () => {
  assertEquals(
    parsePostgresForeignKeyViolation({
      code: '23503',
      table_name: 'stage',
      constraint_name: 'stage_server_id_server_id_fk',
    }),
    { referringTable: 'stage', constraintName: 'stage_server_id_server_id_fk' }
  )
  assertEquals(
    parsePostgresForeignKeyViolation({
      code: '23503',
      constraint_name: 'container_server_id_server_id_fk',
    }),
    { referringTable: 'container', constraintName: 'container_server_id_server_id_fk' }
  )
})

test('hierarchyDeleteHasChildrenMessage names the referring table', () => {
  assertEquals(
    hierarchyDeleteHasChildrenMessage({ referringTable: 'stage' }),
    'Something still refers to this server: stage'
  )
  assertEquals(hierarchyDeleteHasChildrenMessage(), HIERARCHY_DELETE_HAS_CHILDREN_ERROR)
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

test('runHierarchyDelete maps FK violations to has_children with table detail', async () => {
  const db = {
    transaction: async () => {
      throw {
        code: '23503',
        table_name: 'relay',
        constraint_name: 'relay_server_id_server_id_fk',
      }
    },
  } as unknown as Db

  assertEquals(await runHierarchyDelete(db, async () => {}), 'has_children')
  assertEquals(peekHierarchyDeleteFkViolation(), {
    referringTable: 'relay',
    constraintName: 'relay_server_id_server_id_fk',
  })
})

test('runHierarchyDelete rethrows unrelated errors', async () => {
  const db = {
    transaction: async () => {
      throw new Error('boom')
    },
  } as unknown as Db

  await assertRejects(() => runHierarchyDelete(db, async () => {}), Error, 'boom')
})

test('hierarchyDeleteHasChildrenResponseIfNeeded returns null on success', () => {
  const c = {} as Parameters<typeof hierarchyDeleteHasChildrenResponseIfNeeded>[0]
  assertEquals(hierarchyDeleteHasChildrenResponseIfNeeded(c, 'ok'), null)
})

test('hierarchyDeleteHasChildrenResponse returns 409 JSON', async () => {
  const app = new Hono()
  app.delete('/resource', (c) =>
    hierarchyDeleteHasChildrenResponse(c, { referringTable: 'managed' })
  )

  const res = await app.request('http://localhost/resource', { method: 'DELETE' })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    error: 'Something still refers to this server: managed',
    code: HIERARCHY_DELETE_HAS_CHILDREN_CODE,
  })
})
