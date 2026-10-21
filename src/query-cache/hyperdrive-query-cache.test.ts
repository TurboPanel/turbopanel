import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../db/connection.ts'
import { createDbUsage } from './db-usage.ts'
import { createHyperdriveQueryCache } from './hyperdrive-query-cache.ts'
import { UncacheableStatementError } from './statement-guard.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('hyperdrive cache loads approved models against the cached db', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  let loadTarget: Db | undefined
  const value = await cache.getReadModel({
    readModel: 'servers-list',
    key: 'unused-on-hyperdrive',
    ttlSeconds: 999,
    load: async (passed) => {
      loadTarget = passed
      return [{ id: 'srv-1' }]
    },
  })
  assertEquals(loadTarget, cachedDb)
  assertEquals(value, [{ id: 'srv-1' }])
})

test('hyperdrive cache rejects unapproved read models before load', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  let loaded = false
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'daemon-status',
        key: 'k',
        load: async () => {
          loaded = true
          return null
        },
      } as unknown as Parameters<typeof cache.getReadModel>[0]),
    Error,
    'Unapproved read model for cached database'
  )
  assertEquals(loaded, false)
})

test('hyperdrive cache ignores ttlSeconds and still loads server-detail', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  const value = await cache.getReadModel({
    readModel: 'server-detail',
    key: 'k',
    ttlSeconds: 1,
    load: async (passed) => {
      assertEquals(passed, cachedDb)
      return { id: 'srv-1' }
    },
  })
  assertEquals(value, { id: 'srv-1' })
})

test('hyperdrive cache re-runs a refused statement once on the primary connection', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const primaryDb = { kind: 'primary' } as unknown as Db
  const usage = createDbUsage()
  const cache = createHyperdriveQueryCache(cachedDb, { usage })
  const targets: Db[] = []
  const value = await cache.getReadModel({
    readModel: 'servers-list',
    key: 'k',
    primaryDb,
    load: async (db) => {
      targets.push(db)
      if (db === cachedDb) throw new UncacheableStatementError('uses now()')
      return ['row']
    },
  })
  assertEquals(value, ['row'])
  assertEquals(targets, [cachedDb, primaryDb])
  assertEquals(usage.fallback, 1)
  assertEquals(usage.readModels, [{ id: 'servers-list', outcome: 'fallback' }])
  assertEquals(usage.rerunning, 0)
})

test('hyperdrive cache falls back when the cached connection closed', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const primaryDb = { kind: 'primary' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  const value = await cache.getReadModel({
    readModel: 'server-detail',
    key: 'k',
    primaryDb,
    load: async (db) => {
      if (db === cachedDb) throw Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })
      return 'row'
    },
  })
  assertEquals(value, 'row')
})

test('hyperdrive cache does not hide other errors or a closed primary connection', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const primaryDb = { kind: 'primary' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'servers-list',
        key: 'k',
        primaryDb,
        load: async () => {
          throw new Error('syntax error')
        },
      }),
    Error,
    'syntax error'
  )
  const closed = Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'servers-list',
        key: 'k',
        primaryDb,
        load: async () => {
          throw closed
        },
      }),
    Error,
    'closed'
  )
})

test('strict mode makes a refused statement fail loudly', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb, { strict: true })
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'servers-list',
        key: 'k',
        primaryDb: cachedDb,
        load: async () => {
          throw new UncacheableStatementError('not a SELECT')
        },
      }),
    UncacheableStatementError
  )
})
