import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../db.ts'
import {
  APPROVED_READ_MODELS,
  isApprovedReadModelId,
} from './approved-read-models.ts'
import { runApprovedCachedReadModel } from './cached-query.ts'
import {
  clampQueryCacheTtlSeconds,
  DEFAULT_QUERY_CACHE_TTL_SECONDS,
  MAX_QUERY_CACHE_TTL_SECONDS,
} from './contracts.ts'
import { createHyperdriveQueryCache } from './hyperdrive-query-cache.ts'
import { QUERY_CACHE_PREFIX, queryCacheKey } from './keys.ts'
import { createPassthroughQueryCache } from './passthrough-query-cache.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isApprovedReadModelId accepts only allowlisted ids', () => {
  assertEquals(APPROVED_READ_MODELS, ['servers-list', 'server-detail'])
  assertEquals(isApprovedReadModelId('servers-list'), true)
  assertEquals(isApprovedReadModelId('server-detail'), true)
  assertEquals(isApprovedReadModelId('daemon-status'), false)
  assertEquals(isApprovedReadModelId(''), false)
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
      } as unknown as Parameters<typeof cache.getReadModel>[0]),
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

test('queryCacheKey prefixes namespace and joins parts', () => {
  assertEquals(QUERY_CACHE_PREFIX, 'tp:qcache:')
  assertEquals(
    queryCacheKey('servers-list', 'org-1', 'a,b'),
    'tp:qcache:servers-list:org-1:a,b',
  )
})

test('clampQueryCacheTtlSeconds bounds ttl to the approved window', () => {
  assertEquals(clampQueryCacheTtlSeconds(), DEFAULT_QUERY_CACHE_TTL_SECONDS)
  assertEquals(clampQueryCacheTtlSeconds(0), 1)
  assertEquals(clampQueryCacheTtlSeconds(-5), 1)
  assertEquals(clampQueryCacheTtlSeconds(30), 30)
  assertEquals(clampQueryCacheTtlSeconds(60), MAX_QUERY_CACHE_TTL_SECONDS)
  assertEquals(clampQueryCacheTtlSeconds(120), MAX_QUERY_CACHE_TTL_SECONDS)
})

test('queryCacheKey joins empty trailing parts without dropping namespace', () => {
  assertEquals(queryCacheKey('servers-list'), 'tp:qcache:servers-list')
  assertEquals(
    queryCacheKey('server-detail', 'org', ''),
    'tp:qcache:server-detail:org:',
  )
})

test('runApprovedCachedReadModel bypasses cache when absent', async () => {
  const db = { kind: 'db' } as unknown as Db
  const loaded = await runApprovedCachedReadModel(
    undefined,
    db,
    'servers-list',
    ['org-1'],
    async (passed) => {
      assertEquals(passed, db)
      return [{ id: 'srv-1' }]
    },
  )
  assertEquals(loaded, [{ id: 'srv-1' }])
})

test('runApprovedCachedReadModel delegates to QueryCache when present', async () => {
  const db = { kind: 'db' } as unknown as Db
  const cache = createPassthroughQueryCache(db)
  const loaded = await runApprovedCachedReadModel(
    cache,
    db,
    'server-detail',
    ['org-1', 'srv-1'],
    async () => ({ id: 'srv-1' }),
    30,
  )
  assertEquals(loaded, { id: 'srv-1' })
})

test('hyperdrive cache loads approved models and rejects others', async () => {
  const db = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(db)
  const value = await cache.getReadModel({
    readModel: 'server-detail',
    key: 'k',
    ttlSeconds: 999,
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
      } as unknown as Parameters<typeof cache.getReadModel>[0]),
    Error,
    'Unapproved read model for cached database',
  )
})

test('passthrough cache ignores ttlSeconds and still loads', async () => {
  const db = { kind: 'db' } as unknown as Db
  const cache = createPassthroughQueryCache(db)
  const value = await cache.getReadModel({
    readModel: 'servers-list',
    key: 'k',
    ttlSeconds: 1,
    load: async () => [{ id: 'ttl-ignored' }],
  })
  assertEquals(value, [{ id: 'ttl-ignored' }])
})
