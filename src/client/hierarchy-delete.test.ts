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

test('parsePostgresForeignKeyViolation reads postgres.js table and constraint fields', () => {
  assertEquals(
    parsePostgresForeignKeyViolation({
      code: '23503',
      table: 'stage',
      constraint: 'stage_server_id_server_id_fk',
      column: 'server_id',
    }),
    {
      table: 'stage',
      constraint: 'stage_server_id_server_id_fk',
      column: 'server_id',
    }
  )
})

test('parsePostgresForeignKeyViolation reads information_schema-style names', () => {
  assertEquals(
    parsePostgresForeignKeyViolation({
      code: '23503',
      table_name: 'container',
      constraint_name: 'container_server_id_server_id_fk',
    }),
    { table: 'container', constraint: 'container_server_id_server_id_fk' }
  )
})

test('parsePostgresForeignKeyViolation reads detail when table fields are absent', () => {
  assertEquals(
    parsePostgresForeignKeyViolation({
      code: '23503',
      detail: 'Key (id)=(2030f113-0000-7000-8000-000000000001) is still referenced from table "environment".',
      constraint: 'environment_server_id_server_id_fk',
    }),
    { table: 'environment', constraint: 'environment_server_id_server_id_fk' }
  )
})

test('parsePostgresForeignKeyViolation walks drizzle cause chain', () => {
  assertEquals(
    parsePostgresForeignKeyViolation({
      message: 'Failed query',
      cause: {
        code: '23503',
        table: 'relay',
        constraint: 'relay_server_id_server_id_fk',
      },
    }),
    { table: 'relay', constraint: 'relay_server_id_server_id_fk' }
  )
})

test('hierarchyDeleteHasChildrenMessage keeps the generic error string', () => {
  assertEquals(hierarchyDeleteHasChildrenMessage(), HIERARCHY_DELETE_HAS_CHILDREN_ERROR)
})

test('runHierarchyDelete returns ok when the transaction succeeds', async () => {
  const db = {
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn({} as Db)
    },
  } as unknown as Db

  const result = await runHierarchyDelete(db, async () => {})
  assertEquals(result, { status: 'ok' })
})

test('runHierarchyDelete maps FK violations to has_children with table detail', async () => {
  const db = {
    transaction: async () => {
      throw {
        code: '23503',
        table: 'relay',
        constraint: 'relay_server_id_server_id_fk',
      }
    },
  } as unknown as Db

  const result = await runHierarchyDelete(db, async () => {})
  assertEquals(result, {
    status: 'has_children',
    blockers: [{ table: 'relay', constraint: 'relay_server_id_server_id_fk' }],
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
  assertEquals(hierarchyDeleteHasChildrenResponseIfNeeded(c, { status: 'ok' }), null)
})

test('hierarchyDeleteHasChildrenResponse returns 409 JSON with structured blockers', async () => {
  const app = new Hono()
  app.delete('/resource', (c) =>
    hierarchyDeleteHasChildrenResponse(c, [
      { table: 'managed', constraint: 'managed_server_id_server_id_fk' },
    ])
  )

  const res = await app.request('http://localhost/resource', { method: 'DELETE' })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    error: HIERARCHY_DELETE_HAS_CHILDREN_ERROR,
    code: HIERARCHY_DELETE_HAS_CHILDREN_CODE,
    blockers: [{ table: 'managed', constraint: 'managed_server_id_server_id_fk' }],
  })
})
