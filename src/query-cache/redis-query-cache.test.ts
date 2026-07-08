import { assert, assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../db.ts'
import {
  createRedisCellClient,
  type RedisCellClient,
} from '../daemon/cell/redis/client.ts'
import { createRedisQueryCache } from './redis-query-cache.ts'
import { queryCacheKey } from './keys.ts'

const DEFAULT_SOCKET = Deno.env.get('TURBOPANEL_REDIS_SOCKET') ??
  '/run/turbopanel/redis.sock'

async function redisAvailable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(DEFAULT_SOCKET)
    return stat.isSocket === true
  } catch {
    return false
  }
}

function withRedisQueryCache(
  fn: (ctx: {
    client: RedisCellClient
    namespace: string
    db: Db
  }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping Redis query cache test: socket not found at ${DEFAULT_SOCKET}`,
      )
      return
    }

    const client = createRedisCellClient()
    const namespace = `test-${crypto.randomUUID()}`
    const db = null as unknown as Db

    try {
      await fn({ client, namespace, db })
    } finally {
      await client.deleteByPattern(`tp:qcache:${namespace}:*`)
      await client.close()
    }
  }
}

Deno.test(
  'cached returns loader result on miss then serves from cache on hit',
  withRedisQueryCache(async ({ client, namespace, db }) => {
    const cache = createRedisQueryCache({ client, db })
    const key = queryCacheKey(namespace, 'miss-hit')
    let loadCount = 0
    const listRows = [{
      id: 'srv-1',
      displayName: 'Test',
      organizationId: 'org-1',
      licenseId: null,
      options: null,
      createdAt: '2024-01-01T00:00:00.000Z',
    }]

    const first = await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 60,
      load: async () => {
        loadCount += 1
        return listRows
      },
    })
    assertEquals(first, listRows)
    assertEquals(loadCount, 1)

    const rawValue = await client.get(key)
    assert(rawValue !== null)
    const parsed = JSON.parse(rawValue!)
    assert(Array.isArray(parsed))
    assertEquals(parsed, listRows)

    const second = await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 60,
      load: async () => {
        loadCount += 1
        return listRows
      },
    })
    assertEquals(second, listRows)
    assertEquals(loadCount, 1)
  }),
)

Deno.test(
  'cached clamps ttlSeconds to MAX_QUERY_CACHE_TTL_SECONDS',
  withRedisQueryCache(async ({ client, namespace, db }) => {
    const cache = createRedisQueryCache({ client, db })
    const key = queryCacheKey(namespace, 'ttl-clamp')

    await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 9999,
      load: async () => ({ ok: true }),
    })

    const pttl = await client.pttl(key)
    assert(pttl > 0)
    assert(pttl <= 60_000)
  }),
)

Deno.test('cached falls back to loader when Redis get throws', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  const client = {
    get: () => Promise.reject(new Error('redis read failure')),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'servers-list',
    key: queryCacheKey('stub', 'redis-get-error'),
    ttlSeconds: 60,
    load: async () => {
      loadCount += 1
      return { fromLoader: true }
    },
  })

  assertEquals(result, { fromLoader: true })
  assertEquals(loadCount, 1)
})

Deno.test('cached returns loader result when Redis set throws', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  let setKey: string | undefined
  const expectedKey = queryCacheKey('servers-list', 'redis-set-error')
  const client = {
    get: () => Promise.resolve(null),
    set: (key: string) => {
      setKey = key
      return Promise.reject(new Error('redis write failure'))
    },
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'servers-list',
    key: expectedKey,
    ttlSeconds: 60,
    load: async () => {
      loadCount += 1
      return { fromLoader: true }
    },
  })

  assertEquals(result, { fromLoader: true })
  assertEquals(loadCount, 1)
  assertEquals(setKey, expectedKey)
  assertEquals(setKey, queryCacheKey('servers-list', 'redis-set-error'))
})

Deno.test('getReadModel rejects unapproved read models', async () => {
  const db = null as unknown as Db
  const client = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  await assertRejects(
    () => cache.getReadModel({
      readModel: 'not-allowed',
      key: queryCacheKey('stub', 'unapproved'),
      load: async () => ({ ok: true }),
    } as Parameters<typeof cache.getReadModel>[0]),
    Error,
    'Unapproved read model',
  )
})

Deno.test(
  'cached falls back to loader when cached value is invalid JSON',
  withRedisQueryCache(async ({ client, namespace, db }) => {
    const cache = createRedisQueryCache({ client, db })
    const key = queryCacheKey(namespace, 'bad-json')
    await client.set(key, '{not-json')

    let loadCount = 0
    const result = await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 60,
      load: async () => {
        loadCount += 1
        return { recovered: true }
      },
    })

    assertEquals(result, { recovered: true })
    assertEquals(loadCount, 1)
  }),
)
