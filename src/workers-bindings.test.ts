import { afterEach, describe, expect, it } from 'vitest'
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
// Vite inlines these as strings so source-scan guards work inside workerd
// (host `node:fs` paths are not on the Workers VFS).
import workersSource from './workers.ts?raw'
import offlineSweepSource from './daemon/cell/offline-sweep.ts?raw'

/** Stub wrangler.jsonc fragment — real-looking ids (not the committed testing placeholder). */
const STUB_EXERCISED_WRANGLER_JSONC = `
{
  "env": {
    "testing": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "a1b2c3d4e5f6478901234567890abcde" }
      ]
    },
    "live": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "d9c42999730048e2842dccb61aa05d67" }
      ]
    }
  }
}
`

const STUB_PLACEHOLDER_WRANGLER_JSONC = `
{
  "env": {
    "testing": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "0000000000000000000000000000dev0" }
      ]
    },
    "live": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "d9c42999730048e2842dccb61aa05d67" }
      ]
    }
  }
}
`

function mockHyperdrive(connectionString: string) {
  return { connectionString } as Hyperdrive
}

function mockDb(label: string): Db {
  return { label } as unknown as Db
}

afterEach(() => {
  setWorkersDbFactoryForTests(null)
})

describe('workers-bindings Hyperdrive resolve / close guards', () => {
  // Workers cannot reuse a DB client/socket across requests ("Cannot perform I/O
  // on behalf of a different request"), so each resolve must mint a fresh client.
  // Hyperdrive pools connections server-side, so this has no startup cost.
  it('resolveWorkersDb creates a fresh client per resolve (no cross-request reuse)', () => {
    let createCount = 0
    setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
      createCount += 1
      return mockDb(`primary:${binding.connectionString}:${createCount}`)
    })

    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
    } as CloudflareBindings

    const first = resolveWorkersDb(env)
    const second = resolveWorkersDb(env)
    expect(first).toBeDefined()
    expect(first).not.toBe(second)
    expect(createCount).toBe(2)
  })

  it('resolveWorkersCachedDb creates a fresh client per resolve', () => {
    let createCount = 0
    setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
      createCount += 1
      return mockDb(`cached:${binding.connectionString}:${createCount}`)
    })

    const env = {
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    const first = resolveWorkersCachedDb(env)
    const second = resolveWorkersCachedDb(env)
    expect(first).not.toBe(second)
    expect(createCount).toBe(2)
  })

  it('resolveWorkersQueryCache wraps a fresh Hyperdrive client per resolve', () => {
    setWorkersDbFactoryForTests((binding: HyperdriveBinding) =>
      mockDb(binding.connectionString)
    )

    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings
    const primary = resolveWorkersDb(env)
    const first = resolveWorkersQueryCache(env, primary)
    const second = resolveWorkersQueryCache(env, primary)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })

  it('resolveWorkersCachedDb returns undefined when HYPERDRIVE_CACHED is absent', () => {
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      TURBOPANEL_DATABASE_URL: 'postgres://fallback',
    } as CloudflareBindings

    expect(resolveWorkersCachedDb(env)).toBeUndefined()
  })

  it('resolveWorkersCachedDb returns a database when HYPERDRIVE_CACHED is present', () => {
    const cachedDb = mockDb('cached')
    setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
      expect(binding.connectionString).toBe('postgres://cached')
      return cachedDb
    })

    const env = {
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    expect(resolveWorkersCachedDb(env)).toBe(cachedDb)
  })

  it('resolveWorkersQueryCache uses passthrough when HYPERDRIVE_CACHED is absent', async () => {
    const db = mockDb('primary')
    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
    } as CloudflareBindings

    const cache = resolveWorkersQueryCache(env, db)
    expect(cache).toBeDefined()

    let loadedWith: Db | undefined
    await cache!.getReadModel({
      readModel: 'servers-list',
      key: 'tp:qcache:servers-list:test',
      load: async (readDb) => {
        loadedWith = readDb
        return { ok: true }
      },
    })

    expect(loadedWith).toBe(db)
  })

  it('resolveWorkersQueryCache uses cached Hyperdrive db when HYPERDRIVE_CACHED is present', async () => {
    const primaryDb = mockDb('primary')
    const cachedDb = mockDb('cached')
    setWorkersDbFactoryForTests((binding: HyperdriveBinding) =>
      binding.connectionString.includes('cached') ? cachedDb : primaryDb
    )

    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    const cache = resolveWorkersQueryCache(env, primaryDb)
    expect(cache).toBeDefined()

    let loadedWith: Db | undefined
    await cache!.getReadModel({
      readModel: 'servers-list',
      key: 'tp:qcache:servers-list:test',
      load: async (readDb) => {
        loadedWith = readDb
        return { ok: true }
      },
    })

    expect(loadedWith).toBe(cachedDb)
    expect(loadedWith).not.toBe(primaryDb)
  })

  it('openWorkersRequestDb mints primary + cached once; closeWorkersRequestDb ends both', async () => {
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

    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings

    const handles = openWorkersRequestDb(env)
    expect(createCount).toBe(2)
    expect(handles.db).toBeDefined()
    expect(handles.cachedDb).toBeDefined()
    expect(handles.db).not.toBe(handles.cachedDb)
    expect(handles.queryCache).toBeDefined()

    await closeWorkersRequestDb(handles)
    expect(ended.sort((a, b) => a.localeCompare(b))).toEqual([
      'postgres://cached',
      'postgres://primary',
    ])
  })

  it('resolveWorkersQueryCache reuses a caller-supplied cachedDb (no second mint)', () => {
    let createCount = 0
    setWorkersDbFactoryForTests((binding: HyperdriveBinding) => {
      createCount += 1
      return mockDb(binding.connectionString)
    })

    const env = {
      HYPERDRIVE: mockHyperdrive('postgres://primary'),
      HYPERDRIVE_CACHED: mockHyperdrive('postgres://cached'),
    } as CloudflareBindings
    const primary = resolveWorkersDb(env)
    const cached = resolveWorkersCachedDb(env)
    expect(createCount).toBe(2)
    resolveWorkersQueryCache(env, primary, cached ?? null)
    expect(createCount).toBe(2)
  })

  it('workers.ts and offline-sweep.ts always close per-invocation DB clients', () => {
    expect(/closeWorkersRequestDb\s*\(/.test(workersSource)).toBe(true)
    expect(/endDbConnection\s*\(/.test(workersSource)).toBe(true)
    expect(/endDbConnection\s*\(/.test(offlineSweepSource)).toBe(true)
    expect(/finally\s*\{[\s\S]*endDbConnection/.test(offlineSweepSource)).toBe(
      true,
    )
  })

  it('resolveWorkersDaemonRateLimiters returns noop adapters on dev surface when bindings absent', async () => {
    const env = { TURBOPANEL_DEV_SURFACE: '1' } as CloudflareBindings
    const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
    expect(await connect.limit({ key: 'k' })).toEqual({ success: true })
    expect(await rest.limit({ key: 'k' })).toEqual({ success: true })
    expect(await metrics.limit({ key: 'k' })).toEqual({ success: true })
  })

  it('resolveWorkersDaemonRateLimiters fails closed in production when bindings absent', async () => {
    const env = {} as CloudflareBindings
    const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
    expect(await connect.limit({ key: 'k' })).toEqual({ success: false })
    expect(await rest.limit({ key: 'k' })).toEqual({ success: false })
    expect(await metrics.limit({ key: 'k' })).toEqual({ success: false })
  })

  it('resolveWorkersDaemonRateLimiters wraps present RateLimit bindings', async () => {
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
    expect(await connect.limit({ key: 'connect-a' })).toEqual({ success: true })
    expect(await rest.limit({ key: 'rest-b' })).toEqual({ success: false })
    expect(await metrics.limit({ key: 'metrics-c' })).toEqual({ success: true })
    expect(connectKeys).toEqual(['connect-a'])
    expect(restKeys).toEqual(['rest-b'])
    expect(metricsKeys).toEqual(['metrics-c'])
  })

  it('resolveWorkersDaemonRateLimiters fails closed for metrics independently', async () => {
    const env = {
      DAEMON_CONNECT_RATE_LIMITER: {
        limit: () => Promise.resolve({ success: true }),
      },
      DAEMON_REST_RATE_LIMITER: {
        limit: () => Promise.resolve({ success: true }),
      },
    } as unknown as CloudflareBindings
    const { connect, rest, metrics } = resolveWorkersDaemonRateLimiters(env)
    expect(await connect.limit({ key: 'k' })).toEqual({ success: true })
    expect(await rest.limit({ key: 'k' })).toEqual({ success: true })
    expect(await metrics.limit({ key: 'k' })).toEqual({ success: false })
  })

  it('resolveWorkersClientAuthRateLimiter wraps the binding into a durable limiter', async () => {
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
    expect(result.allowed).toBe(true)
    // Two independent buckets (identity + IP) keyed against the shared binding.
    expect(keys).toHaveLength(2)
    expect(keys.some((k) => k.includes(':id:'))).toBe(true)
    expect(keys.some((k) => k.includes(':ip:'))).toBe(true)
    // Durable keys must not contain the raw email or IP.
    expect(keys.some((k) => k.includes('user@example.com'))).toBe(false)
    expect(keys.some((k) => k.includes('203.0.113.7'))).toBe(false)
    // Digests are fixed-length hex after the purpose:id: / purpose:ip: segment.
    for (const key of keys) {
      const digest = key.replace(/^auth:[^:]+:(?:id|ip):/, '')
      expect(digest).toHaveLength(64)
    }
  })

  it('resolveWorkersClientAuthRateLimiter fails closed in production when binding missing', async () => {
    // Production-like env (no dev surface flag, no binding).
    const env = {} as CloudflareBindings
    const limiter = resolveWorkersClientAuthRateLimiter(env)
    const result = await limiter.check('sign-in', 'user@example.com', '203.0.113.8')
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('resolveWorkersClientAuthRateLimiter allows per-isolate fallback on the dev surface', async () => {
    const env = { TURBOPANEL_DEV_SURFACE: '1' } as CloudflareBindings
    const limiter = resolveWorkersClientAuthRateLimiter(env)
    const result = await limiter.check('sign-in', 'dev@example.com', '203.0.113.9')
    // Dev fallback allows the first attempt (per-isolate limiter, not fail-closed).
    expect(result.allowed).toBe(true)
  })

  it('isPlaceholderHyperdriveCachedId matches only the dev placeholder', () => {
    expect(
      isPlaceholderHyperdriveCachedId('0000000000000000000000000000dev0'),
    ).toBe(true)
    expect(
      isPlaceholderHyperdriveCachedId('d9c42999730048e2842dccb61aa05d67'),
    ).toBe(false)
    expect(isPlaceholderHyperdriveCachedId(undefined)).toBe(false)
  })

  it('wrangler exercised envs must not use HYPERDRIVE_CACHED placeholder', async () => {
    const { assertExercisedHyperdriveCachedBindings, readHyperdriveCachedIdsFromWranglerJsonc } =
      await import('./wrangler-hyperdrive-bindings.ts')

    // Stubbed wrangler text (committed testing still uses the ensure-script
    // placeholder until testing-cached is provisioned). Assert the parse +
    // guard pipeline: real ids pass; placeholder testing id is rejected.
    const okIds = readHyperdriveCachedIdsFromWranglerJsonc(STUB_EXERCISED_WRANGLER_JSONC)
    assertExercisedHyperdriveCachedBindings({
      testing: okIds.testing,
      live: okIds.live,
    })

    const badIds = readHyperdriveCachedIdsFromWranglerJsonc(STUB_PLACEHOLDER_WRANGLER_JSONC)
    expect(() =>
      assertExercisedHyperdriveCachedBindings({
        testing: badIds.testing,
        live: badIds.live,
      }),
    ).toThrow(/testing HYPERDRIVE_CACHED/)
  })
})

