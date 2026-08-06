import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../db.ts'
import { isApprovedReadModelId } from './approved-read-models.ts'
import { createHyperdriveQueryCache } from './hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from './passthrough-query-cache.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isApprovedReadModelId accepts only allowlisted ids', () => {
  assertEquals(isApprovedReadModelId('servers-list'), true)
  assertEquals(isApprovedReadModelId('server-detail'), true)
  assertEquals(isApprovedReadModelId('daemon-status'), false)
})

test('passthrough cache loads approved models and rejects others', async () => {
  const db = { kind: 'db' } as unknown as Db
  const cache = createPassthroughQueryCache(db)
  const value = await cache.getReadModel({
    readModel: 'servers-list',
    key: 'k',
    load: async (passed) => {
      assertEquals(passed, db)
      return [{ id: '1' }]
    },
  })
  assertEquals(value, [{ id: '1' }])

  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'not-approved',
        key: 'k',
        load: async () => null,
      }),
    Error,
    'Unapproved read model',
  )
})

test('passthrough cache requires a database', async () => {
  const cache = createPassthroughQueryCache()
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'servers-list',
        key: 'k',
        load: async () => [],
      }),
    Error,
    'Database unavailable',
  )
})

test('hyperdrive cache loads approved models and rejects others', async () => {
  const db = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(db)
  const value = await cache.getReadModel({
    readModel: 'server-detail',
    key: 'k',
    load: async (passed) => {
      assertEquals(passed, db)
      return { id: 'srv-1' }
    },
  })
  assertEquals(value, { id: 'srv-1' })

  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'secrets',
        key: 'k',
        load: async () => null,
      }),
    Error,
    'Unapproved read model for cached database',
  )
})
