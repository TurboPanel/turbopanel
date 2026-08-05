import { assertEquals } from 'jsr:@std/assert'
import {
  createRedisCellClient,
  type RedisCellClient,
} from '../cell/redis/client.ts'
import { rateLimitKey } from '../cell/redis/keys.ts'
import {
  createRedisRateLimiter,
  resolveDaemonConnectRateLimit,
  resolveDaemonRestRateLimit,
} from './redis-rate-limiter.ts'
import {
  daemonConnectRateLimitKey,
  daemonRestRateLimitKey,
} from './keys.ts'

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

function withRedis(
  fn: (client: RedisCellClient) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping Redis rate-limiter test: socket not found at ${DEFAULT_SOCKET}`,
      )
      return
    }

    const client = createRedisCellClient()
    try {
      await fn(client)
    } finally {
      await client.close()
    }
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test(
  'redis rate limiter allows up to limit then denies for a key',
  withRedis(async (client) => {
    const key = `test-limit-${crypto.randomUUID()}`
    const storageKey = rateLimitKey(key)
    const limiter = createRedisRateLimiter({
      client,
      limit: 2,
      periodSeconds: 60,
    })
    try {
      assertEquals(await limiter.limit({ key }), { success: true })
      assertEquals(await limiter.limit({ key }), { success: true })
      assertEquals(await limiter.limit({ key }), { success: false })
    } finally {
      await client.del(storageKey)
    }
  }),
)

test(
  'redis rate limiter treats distinct keys independently',
  withRedis(async (client) => {
    const keyA = `test-a-${crypto.randomUUID()}`
    const keyB = `test-b-${crypto.randomUUID()}`
    const limiter = createRedisRateLimiter({
      client,
      limit: 1,
      periodSeconds: 60,
    })
    try {
      assertEquals(await limiter.limit({ key: keyA }), { success: true })
      assertEquals(await limiter.limit({ key: keyA }), { success: false })
      assertEquals(await limiter.limit({ key: keyB }), { success: true })
      assertEquals(await limiter.limit({ key: keyB }), { success: false })
    } finally {
      await client.del(rateLimitKey(keyA), rateLimitKey(keyB))
    }
  }),
)

test(
  'redis rate limiter refills capacity over time',
  withRedis(async (client) => {
    const key = `test-refill-${crypto.randomUUID()}`
    const limiter = createRedisRateLimiter({
      client,
      limit: 1,
      periodSeconds: 1,
    })
    try {
      assertEquals(await limiter.limit({ key }), { success: true })
      assertEquals(await limiter.limit({ key }), { success: false })
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      assertEquals(await limiter.limit({ key }), { success: true })
    } finally {
      await client.del(rateLimitKey(key))
    }
  }),
)

test(
  'redis rate limiter stores under tp:ratelimit:* namespace',
  withRedis(async (client) => {
    const logical = daemonConnectRateLimitKey(`test-${crypto.randomUUID()}`)
    const storageKey = rateLimitKey(logical)
    const limiter = createRedisRateLimiter({
      client,
      limit: 1,
      periodSeconds: 60,
    })
    try {
      assertEquals(await limiter.limit({ key: logical }), { success: true })
      const hash = await client.hgetall(storageKey)
      assertEquals(hash !== null && hash.tokens !== undefined, true)
      assertEquals(storageKey.startsWith('tp:ratelimit:'), true)
      assertEquals(storageKey, `tp:ratelimit:${logical}`)
    } finally {
      await client.del(storageKey)
    }
  }),
)

test('createRedisRateLimiter fails open when eval throws (daemon default)', async () => {
  const badClient = {
    eval: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisCellClient
  const limiter = createRedisRateLimiter({
    client: badClient,
    limit: 1,
    periodSeconds: 60,
  })
  assertEquals(await limiter.limit({ key: 'any' }), { success: true })
})

test('createRedisRateLimiter fails closed when onError is closed', async () => {
  const badClient = {
    eval: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisCellClient
  const limiter = createRedisRateLimiter({
    client: badClient,
    limit: 1,
    periodSeconds: 60,
    onError: 'closed',
  })
  assertEquals(await limiter.limit({ key: 'auth-key' }), { success: false })
})

test('createRedisRateLimiter satisfies RateLimiter with shared keys', async () => {
  const seen: string[] = []
  const client = {
    eval: (
      _script: string,
      _numkeys: number,
      storageKey: string | number,
    ) => {
      seen.push(String(storageKey))
      return Promise.resolve(1)
    },
  } as unknown as RedisCellClient

  const limiter = createRedisRateLimiter({
    client,
    limit: 6,
    periodSeconds: 60,
  })
  const connectKey = daemonConnectRateLimitKey('srv-1')
  const restKey = daemonRestRateLimitKey('srv-1', 'auth-session')
  assertEquals(await limiter.limit({ key: connectKey }), { success: true })
  assertEquals(await limiter.limit({ key: restKey }), { success: true })
  assertEquals(seen, [
    rateLimitKey(connectKey),
    rateLimitKey(restKey),
  ])
})

test('resolveDaemonConnectRateLimit / REST defaults match Workers wrangler', () => {
  const empty = { get: () => undefined }
  assertEquals(resolveDaemonConnectRateLimit(empty), {
    limit: 6,
    periodSeconds: 60,
  })
  assertEquals(resolveDaemonRestRateLimit(empty), {
    limit: 30,
    periodSeconds: 60,
  })
})
