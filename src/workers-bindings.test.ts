import { assert, assertEquals } from 'jsr:@std/assert'
import {
  closeWorkersRequestDb,
  openWorkersRequestDb,
  resolveWorkersCachedDb,
  resolveWorkersClientAuthRateLimiter,
  resolveWorkersDaemonRateLimiters,
  resolveWorkersDb,
  resolveWorkersQueryCache,
  isPlaceholderHyperdriveCachedId,
  setWorkersDbFactoryForTests,
} from './workers-bindings.ts'
import type { Db } from './db.ts'
import type { HyperdriveBinding } from './db.ts'

function mockHyperdrive(connectionString: string) {
  return { connectionString } as Hyperdrive
}

function mockDb(label: string): Db {
  return { label } as unknown as Db
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// Workers cannot reuse a DB client/socket across requests ("Cannot perform I/O
// on behalf of a different request"), so each resolve must mint a fresh client.
// Hyperdrive pools connections server-side, so this has no startup cost.
test('resolveWorkersDb creates a fresh client per resolve (no cross-request reuse)', () => {
  let createCount = 0
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
    createCount += 1
    return mockDb(`primary:${binding.connectionString}:${createCount}`)
  })

  try {
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
    } as CloudflareBindings

    const first = resolveWorkersDb(env)
    const second = resolveWorkersDb(env)
    assert(first !== undefined)
    assert(first !== second)
    assertEquals(createCount, 2)
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('resolveWorkersCachedDb creates a fresh client per resolve', () => {
  let createCount = 0
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
    createCount += 1
    return mockDb(`cached:${binding.connectionString}:${createCount}`)
  })

  try {
    const env = {
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    const first = resolveWorkersCachedDb(env)
    const second = resolveWorkersCachedDb(env)
    assert(first !== second)
    assertEquals(createCount, 2)
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('resolveWorkersQueryCache wraps a fresh Hyperdrive client per resolve', () => {
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) =>
    mockDb(binding.connectionString)
  )

  try {
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings
    const primary = resolveWorkersDb(env)
    const first = resolveWorkersQueryCache(env, primary)
    const second = resolveWorkersQueryCache(env, primary)
    assert(first !== undefined)
    assert(second !== undefined)
    assert(first !== second)
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('resolveWorkersCachedDb returns undefined when HYPERDRIVE_CACHED is absent', () => {
  const env = {
    HYPERDRIVE: mockHyperdrive('postgres://primary'),
    TURBOPANEL_DATABASE_URL: 'postgres://fallback',
  } as CloudflareBindings

  assertEquals(resolveWorkersCachedDb(env), undefined)
})

test('resolveWorkersCachedDb returns a database when HYPERDRIVE_CACHED is present', () => {
  const cachedDb = mockDb('cached')
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
    assertEquals(binding.connectionString, 'postgres://cached')
    return cachedDb
  })

  try {
    const env = {
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    assertEquals(resolveWorkersCachedDb(env), cachedDb)
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('resolveWorkersQueryCache uses passthrough when HYPERDRIVE_CACHED is absent', async () => {
  const db = mockDb('primary')
  const env = {
    HYPERDRIVE: mockHyperdrive('postgres://primary'),
  } as CloudflareBindings

  const cache = resolveWorkersQueryCache(env, db)
  assert(cache !== undefined)

  let loadedWith: Db | undefined
  await cache!.getReadModel({
    readModel: 'servers-list',
    key: 'tp:qcache:servers-list:test',
    load: async (readDb) => {
      loadedWith = readDb
      return { ok: true }
    },
  })

  assertEquals(loadedWith, db)
})

test('resolveWorkersQueryCache uses cached Hyperdrive db when HYPERDRIVE_CACHED is present', async () => {
  const primaryDb = mockDb('primary')
  const cachedDb = mockDb('cached')
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) =>
    binding.connectionString.includes('cached') ? cachedDb : primaryDb
  )

  try {
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    const cache = resolveWorkersQueryCache(env, primaryDb)
    assert(cache !== undefined)

    let loadedWith: Db | undefined
    await cache!.getReadModel({
      readModel: 'servers-list',
      key: 'tp:qcache:servers-list:test',
      load: async (readDb) => {
        loadedWith = readDb
        return { ok: true }
      },
    })

    assertEquals(loadedWith, cachedDb)
    assert(loadedWith !== primaryDb)
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('openWorkersRequestDb mints primary + cached once; closeWorkersRequestDb ends both', async () => {
  let createCount = 0
  const ended: string[] = []
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
    createCount += 1
    const label = binding.connectionString
    return {
      label,
      $client: {
        end: () => {
          ended.push(label)
          return Promise.resolve()
        },
      },
    } as unknown as Db
  })

  try {
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    const handles = openWorkersRequestDb(env)
    assertEquals(createCount, 2)
    assert(handles.db !== undefined)
    assert(handles.cachedDb !== undefined)
    assert(handles.db !== handles.cachedDb)
    assert(handles.queryCache !== undefined)

    await closeWorkersRequestDb(handles)
    assertEquals(
      ended.sort((a, b) => a.localeCompare(b)),
      ['postgres://cached', 'postgres://primary'],
    )
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('resolveWorkersQueryCache reuses a caller-supplied cachedDb (no second mint)', () => {
  let createCount = 0
  setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
    createCount += 1
    return mockDb(binding.connectionString)
  })

  try {
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings
    const primary = resolveWorkersDb(env)
    const cached = resolveWorkersCachedDb(env)
    assertEquals(createCount, 2)
    resolveWorkersQueryCache(env, primary, cached ?? null)
    assertEquals(createCount, 2)
  } finally {
    setWorkersDbFactoryForTests(null)
  }
})

test('workers.ts and offline-sweep.ts always close per-invocation DB clients', async () => {
  const workersSource = await Deno.readTextFile(
    new URL('./workers.ts', import.meta.url),
  )
  const sweepSource = await Deno.readTextFile(
    new URL('./daemon/cell/offline-sweep.ts', import.meta.url),
  )

  assert(
    /closeWorkersRequestDb\s*\(/.test(workersSource),
    'workers.ts fetch must close via closeWorkersRequestDb',
  )
  assert(
    /endDbConnection\s*\(/.test(workersSource),
    'workers.ts queue must endDbConnection',
  )
  assert(
    /endDbConnection\s*\(/.test(sweepSource),
    'offline-sweep cron must endDbConnection',
  )
  assert(
    /finally\s*\{[\s\S]*endDbConnection/.test(sweepSource),
    'offline-sweep must end the client in finally',
  )
})

test('resolveWorkersDaemonRateLimiters returns noop adapters on dev surface when bindings absent', async () => {
  const env = { TURBOPANEL_DEV_SURFACE: '1' } as CloudflareBindings
  const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
  assertEquals(await connect.limit({ key: 'k' }), { success: true })
  assertEquals(await rest.limit({ key: 'k' }), { success: true })
  assertEquals(await metrics.limit({ key: 'k' }), { success: true })
})

test('resolveWorkersDaemonRateLimiters fails closed in production when bindings absent', async () => {
  const env = {} as CloudflareBindings
  const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
  assertEquals(await connect.limit({ key: 'k' }), { success: false })
  assertEquals(await rest.limit({ key: 'k' }), { success: false })
  assertEquals(await metrics.limit({ key: 'k' }), { success: false })
})

test('resolveWorkersDaemonRateLimiters wraps present RateLimit bindings', async () => {
  const connectKeys: string[] = []
  const restKeys: string[] = []
  const metricsKeys: string[] = []
  const env = {
    DAEMON_CONNECT_RATE_LIMITER: {
      limit: (options: { key: string }) => {
        connectKeys.push(options.key)
        return Promise.resolve({ success: true })
      },
    },
    DAEMON_REST_RATE_LIMITER: {
      limit: (options: { key: string }) => {
        restKeys.push(options.key)
        return Promise.resolve({ success: false })
      },
    },
    DAEMON_METRICS_RATE_LIMITER: {
      limit: (options: { key: string }) => {
        metricsKeys.push(options.key)
        return Promise.resolve({ success: true })
      },
    },
  } as unknown as CloudflareBindings

  const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
  assertEquals(await connect.limit({ key: 'connect-a' }), { success: true })
  assertEquals(await rest.limit({ key: 'rest-b' }), { success: false })
  assertEquals(await metrics.limit({ key: 'metrics-c' }), { success: true })
  assertEquals(connectKeys, ['connect-a'])
  assertEquals(restKeys, ['rest-b'])
  assertEquals(metricsKeys, ['metrics-c'])
})

test('resolveWorkersDaemonRateLimiters fails closed for metrics independently', async () => {
  const env = {
    DAEMON_CONNECT_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: true }),
    },
    DAEMON_REST_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: true }),
    },
  } as unknown as CloudflareBindings
  const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
  assertEquals(await connect.limit({ key: 'k' }), { success: true })
  assertEquals(await rest.limit({ key: 'k' }), { success: true })
  assertEquals(await metrics.limit({ key: 'k' }), { success: false })
})

test('resolveWorkersClientAuthRateLimiter wraps the binding into a durable limiter', async () => {
  const keys: string[] = []
  const env = {
    CLIENT_AUTH_RATE_LIMITER: {
      limit: (options: { key: string }) => {
        keys.push(options.key)
        return Promise.resolve({ success: true })
      },
    },
  } as unknown as CloudflareBindings

  const limiter = resolveWorkersClientAuthRateLimiter(env)
  const result = await limiter.check('sign-in', 'user@example.com', '203.0.113.7')
  assertEquals(result.allowed, true)
  // Two independent buckets (identity + IP) keyed against the shared binding.
  assertEquals(keys.length, 2)
  assert(keys.some((k) => k.includes(':id:')))
  assert(keys.some((k) => k.includes(':ip:')))
  // Durable keys must not contain the raw email or IP.
  assert(!keys.some((k) => k.includes('user@example.com')))
  assert(!keys.some((k) => k.includes('203.0.113.7')))
  // Digests are fixed-length hex after the purpose:id: / purpose:ip: segment.
  for (const key of keys) {
    const digest = key.replace(/^auth:[^:]+:(?:id|ip):/, '')
    assertEquals(digest.length, 64)
  }
})

test('resolveWorkersClientAuthRateLimiter fails closed in production when binding missing', async () => {
  // Production-like env (no dev surface flag, no binding).
  const env = {} as CloudflareBindings
  const limiter = resolveWorkersClientAuthRateLimiter(env)
  const result = await limiter.check('sign-in', 'user@example.com', '203.0.113.8')
  assertEquals(result.allowed, false)
  assert(result.retryAfterSeconds > 0)
})

test('resolveWorkersClientAuthRateLimiter allows per-isolate fallback on the dev surface', async () => {
  const env = { TURBOPANEL_DEV_SURFACE: '1' } as CloudflareBindings
  const limiter = resolveWorkersClientAuthRateLimiter(env)
  const result = await limiter.check('sign-in', 'dev@example.com', '203.0.113.9')
  // Dev fallback allows the first attempt (per-isolate limiter, not fail-closed).
  assertEquals(result.allowed, true)
})

test('isPlaceholderHyperdriveCachedId matches only the dev placeholder', () => {
  assertEquals(
    isPlaceholderHyperdriveCachedId('0000000000000000000000000000dev0'),
    true,
  )
  assertEquals(
    isPlaceholderHyperdriveCachedId('d9c42999730048e2842dccb61aa05d67'),
    false,
  )
  assertEquals(isPlaceholderHyperdriveCachedId(undefined), false)
})

test('wrangler exercised envs must not use HYPERDRIVE_CACHED placeholder', async () => {
  const { assertExercisedHyperdriveCachedBindings, readHyperdriveCachedIdsFromWranglerJsonc } =
    await import('./wrangler-hyperdrive-bindings.ts')
  const wranglerText = await Deno.readTextFile(
    new URL('../wrangler.jsonc', import.meta.url),
  )
  const ids = readHyperdriveCachedIdsFromWranglerJsonc(wranglerText)
  assertExercisedHyperdriveCachedBindings({
    testing: ids.testing,
    live: ids.live,
  })
})
