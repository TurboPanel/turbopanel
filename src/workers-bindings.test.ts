import { assert, assertEquals } from 'jsr:@std/assert'
import {
  resolveWorkersCachedDb,
  resolveWorkersDaemonRateLimiters,
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

Deno.test('resolveWorkersCachedDb returns undefined when HYPERDRIVE_CACHED is absent', () => {
  const env = {
    HYPERDRIVE: mockHyperdrive('postgres://primary'),
    TURBOPANEL_DATABASE_URL: 'postgres://fallback',
  } as CloudflareBindings

  assertEquals(resolveWorkersCachedDb(env), undefined)
})

Deno.test('resolveWorkersCachedDb returns a database when HYPERDRIVE_CACHED is present', () => {
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

Deno.test('resolveWorkersQueryCache uses passthrough when HYPERDRIVE_CACHED is absent', async () => {
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

Deno.test('resolveWorkersQueryCache uses cached Hyperdrive db when HYPERDRIVE_CACHED is present', async () => {
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

Deno.test('resolveWorkersDaemonRateLimiters returns noop adapters when bindings absent', async () => {
  const env = {} as CloudflareBindings
  const { connect, rest } = resolveWorkersDaemonRateLimiters(env)
  assertEquals(await connect.limit({ key: 'k' }), { success: true })
  assertEquals(await rest.limit({ key: 'k' }), { success: true })
})

Deno.test('resolveWorkersDaemonRateLimiters wraps present RateLimit bindings', async () => {
  const connectKeys: string[] = []
  const restKeys: string[] = []
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
  } as unknown as CloudflareBindings

  const { connect, rest } = resolveWorkersDaemonRateLimiters(env)
  assertEquals(await connect.limit({ key: 'connect-a' }), { success: true })
  assertEquals(await rest.limit({ key: 'rest-b' }), { success: false })
  assertEquals(connectKeys, ['connect-a'])
  assertEquals(restKeys, ['rest-b'])
})

Deno.test('isPlaceholderHyperdriveCachedId matches only the dev placeholder', () => {
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

Deno.test('wrangler exercised envs must not use HYPERDRIVE_CACHED placeholder', async () => {
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
