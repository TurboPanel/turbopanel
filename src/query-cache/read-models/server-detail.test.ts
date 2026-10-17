import { assertEquals, assertRejects } from '@std/assert'
import type { Context } from 'hono'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import type { RedisCellClient } from '../../daemon/cell/redis/client.ts'
import { inspectCachedRead, versionStamp } from '../cached-read.ts'
import { createHyperdriveQueryCache } from '../hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from '../passthrough-query-cache.ts'
import { createRedisQueryCache } from '../redis-query-cache.ts'
import {
  cachedServerDetailReadModel,
  serverDetailCachedRead,
  type ServerDetailRow,
} from './server-detail.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function directAttachDaemonState() {
  return {
    key: {
      id: 'key-1',
      algorithm: 'Ed25519' as const,
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-1',
      createdAt: '2020-01-01T00:00:00.000Z',
      machineClass: null,
    },
    projection: {
      remoteAddress: '__direct__',
    },
  }
}

function fakeContext(vars: Record<string, unknown>): Context {
  return {
    get: (key: string) => vars[key],
  } as unknown as Context
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    orderBy: () => promise,
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

/** Documented cached SELECT #1 column set (see `server-detail.ts` module comment). */
const CACHED_DETAIL_SELECT_KEYS = [
  '_v',
  'createdAt',
  'id',
  'licenseId',
  'machineClass',
  'name',
  'options',
  'organizationId',
]

/** The row the primary connection returns for a server (also the source of the version stamp). */
function bareServerRow(id: string, updatedAt = 'u1') {
  return {
    id,
    daemon: null,
    metadata: null,
    hostname: null,
    machineKey: null,
    connected: false,
    statusChangedAt: null,
    updatedAt,
  }
}

function createStubDb(opts: {
  detailRows?: ServerDetailRow[]
  presenceRows?: Array<{
    id: string
    daemon: unknown
    metadata: unknown
    hostname: string | null
    machineKey: string | null
    connected: boolean
    statusChangedAt: string | null
    updatedAt?: string
  }>
  selectKinds?: string[]
  cachedSelectKeys?: string[][]
}): Db {
  const detailRows = opts.detailRows ?? []
  const presenceRows = opts.presenceRows ?? []

  return {
    select: (fields: Record<string, unknown>) => {
      const isPresence = 'daemon' in fields || 'connected' in fields
      opts.selectKinds?.push(isPresence ? 'presence' : 'cached-row')
      if (!isPresence) {
        opts.cachedSelectKeys?.push(Object.keys(fields).sort((a, b) => a.localeCompare(b)))
      }
      const rows = isPresence ? presenceRows : detailRows
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => thenableRows(rows),
          }),
          where: () => thenableRows(rows),
        }),
      }
    },
  } as unknown as Db
}

function cellMustStayAsleep(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error('cached read models must not wake the daemon cell')
    },
    listOnlineServerIds: () =>
      Promise.reject(new Error('cached read models must not list online cells')),
    getSnapshots: () =>
      Promise.reject(new Error('cached read models must not read cell snapshots')),
    purge: () => Promise.reject(new Error('cached read models must not purge cells')),
  }
}

test('cachedServerDetailReadModel rejects when database is missing', async () => {
  await assertRejects(
    () =>
      cachedServerDetailReadModel(fakeContext({}), {
        organizationId: 'org-1',
        serverId: 'srv-1',
      }),
    Error,
    'Database unavailable'
  )
})

test('cachedServerDetailReadModel returns null when the row is missing', async () => {
  const db = createStubDb({ detailRows: [] })
  const result = await cachedServerDetailReadModel(fakeContext({ db }), {
    organizationId: 'org-1',
    serverId: 'srv-missing',
  })
  assertEquals(result, null)
})

test('cachedServerDetailReadModel returns row plus presence enrichment', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: 'lic-1',
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const presenceRows = [
    {
      id: 'srv-1',
      daemon: {
        projection: { remoteAddress: '__direct__' },
      },
      metadata: null,
      hostname: 'primary',
      machineKey: null,
      connected: true,
      statusChangedAt: '2024-01-01T00:00:00.000Z',
    },
  ]
  const db = createStubDb({ detailRows: [row], presenceRows })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(fakeContext({ db, queryCache: cache }), {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })

  assertEquals(result?.row, row)
  assertEquals(result?.presence?.serverId, 'srv-1')
  assertEquals(result?.presence?.connected, true)
  assertEquals(typeof result?.colocatedWithInstance, 'boolean')
})

test('cachedServerDetailReadModel works without query cache in context', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({
    detailRows: [row],
    presenceRows: [
      {
        id: 'srv-1',
        daemon: null,
        metadata: null,
        hostname: 'primary',
        machineKey: null,
        connected: false,
        statusChangedAt: null,
      },
    ],
  })

  const result = await cachedServerDetailReadModel(fakeContext({ db }), {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })

  assertEquals(result?.row, row)
  assertEquals(result?.presence?.serverId, 'srv-1')
})

test('cachedServerDetailReadModel reports colocated when projection is __direct__', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const presenceRows = [
    {
      id: 'srv-1',
      daemon: directAttachDaemonState(),
      metadata: null,
      hostname: 'primary',
      machineKey: null,
      connected: true,
      statusChangedAt: '2024-01-01T00:00:00.000Z',
    },
  ]
  const db = createStubDb({ detailRows: [row], presenceRows })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(fakeContext({ db, queryCache: cache }), {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })

  assertEquals(result?.colocatedWithInstance, true)
  assertEquals(result?.presence?.connected, true)
})

test('cachedServerDetailReadModel derives its redis cache key from the statement', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-203.0.113.2',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [bareServerRow(row.id)] })
  const store = new Map<string, string>()
  const cache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })

  const ctx = fakeContext({ db, queryCache: cache })
  const opts = { organizationId: 'org-203.0.113.2', serverId: 'srv-1' }

  const first = await cachedServerDetailReadModel(ctx, opts)
  assertEquals(first?.row, row)
  assertEquals(
    store.has(
      inspectCachedRead(serverDetailCachedRead.definition, {
        ...opts,
        stamp: versionStamp(['srv-1', 'u1']),
      }).key
    ),
    true
  )

  const second = await cachedServerDetailReadModel(ctx, opts)
  assertEquals(second?.row, row)
})

test('cachedServerDetailReadModel returns null when the server is gone on the primary connection', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const selectKinds: string[] = []
  const db = createStubDb({ detailRows: [row], presenceRows: [], selectKinds })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(fakeContext({ db, queryCache: cache }), {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })

  assertEquals(result, null)
  // The version stamp comes first; with no row there is nothing to cache.
  assertEquals(selectKinds, ['presence'])
})

/**
 * A sealed ProxySQL monitor password used to live on
 * `server.options.managedMonitor`. It now lives on the `monitor` table, but a
 * row written by an older control plane can still carry the key — and this read
 * model both returns `options` to the client and writes it to Redis.
 */
const LEGACY_MONITOR_OPTIONS = {
  timezone: 'UTC',
  managedMonitor: {
    username: 'tp_monitor_0123456789ab',
    passwordSealed: 'tpsecret.v1.deadbeef',
  },
}

test('cachedServerDetailReadModel never returns a managedMonitor secret', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: LEGACY_MONITOR_OPTIONS,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [bareServerRow(row.id)] })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(fakeContext({ db, queryCache: cache }), {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })

  assertEquals(result?.row.options, { timezone: 'UTC' })
  const serialized = JSON.stringify(result)
  assertEquals(serialized.includes('managedMonitor'), false)
  assertEquals(serialized.includes('passwordSealed'), false)
})

test('cachedServerDetailReadModel never caches a managedMonitor secret in redis', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: LEGACY_MONITOR_OPTIONS,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [bareServerRow(row.id)] })
  const store = new Map<string, string>()
  const cache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })

  const ctx = fakeContext({ db, queryCache: cache })
  const opts = { organizationId: 'org-1', serverId: 'srv-1' }

  await cachedServerDetailReadModel(ctx, opts)
  const cached = [...store.values()].join('\n')
  assertEquals(cached.length > 0, true)
  assertEquals(cached.includes('managedMonitor'), false)
  assertEquals(cached.includes('passwordSealed'), false)

  // The second call is served from that cache entry — still no secret.
  const second = await cachedServerDetailReadModel(ctx, opts)
  assertEquals(second?.row.options, { timezone: 'UTC' })
  assertEquals(JSON.stringify(second).includes('passwordSealed'), false)
})

test('cachedServerDetailReadModel cached SELECT includes machineClass', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: 'physical',
  }
  const cachedSelectKeys: string[][] = []
  const db = createStubDb({
    detailRows: [row],
    presenceRows: [bareServerRow(row.id)],
    cachedSelectKeys,
  })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(fakeContext({ db, queryCache: cache }), {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })

  const keys = cachedSelectKeys[0]
  if (!keys) throw new TypeError()
  assertEquals(keys, CACHED_DETAIL_SELECT_KEYS)
  assertEquals(result?.row.machineClass, 'physical')
})

test('cachedServerDetailReadModel runs cached SELECT on Hyperdrive db only', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: 'virtual',
  }
  const cachedKinds: string[] = []
  const primaryKinds: string[] = []
  const cachedDb = createStubDb({ detailRows: [row], selectKinds: cachedKinds })
  const primaryDb = createStubDb({
    presenceRows: [
      {
        id: 'srv-1',
        daemon: null,
        metadata: null,
        hostname: 'primary',
        machineKey: null,
        connected: false,
        statusChangedAt: null,
      },
    ],
    selectKinds: primaryKinds,
  })
  const cache = createHyperdriveQueryCache(cachedDb)

  const result = await cachedServerDetailReadModel(
    fakeContext({
      db: primaryDb,
      queryCache: cache,
      daemonCellRegistry: cellMustStayAsleep(),
    }),
    { organizationId: 'org-1', serverId: 'srv-1' }
  )

  assertEquals(result?.row, row)
  assertEquals(cachedKinds, ['cached-row'])
  assertEquals(primaryKinds, ['presence'])
})

test('cachedServerDetailReadModel redis hit serves JSON null without reloading', async () => {
  const selectKinds: string[] = []
  const db = createStubDb({
    detailRows: [],
    presenceRows: [bareServerRow('srv-missing')],
    selectKinds,
  })
  const store = new Map<string, string>([
    [
      inspectCachedRead(serverDetailCachedRead.definition, {
        organizationId: 'org-1',
        serverId: 'srv-missing',
        stamp: versionStamp(['srv-missing', 'u1']),
      }).key,
      'null',
    ],
  ])
  const cache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })

  const result = await cachedServerDetailReadModel(fakeContext({ db, queryCache: cache }), {
    organizationId: 'org-1',
    serverId: 'srv-missing',
  })

  assertEquals(result, null)
  // Only the primary row (the version stamp) is read; the cached copy answers.
  assertEquals(selectKinds, ['presence'])
})

function memoryRedis(store: Map<string, string>, db: Db) {
  return createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })
}

function detailRow(overrides: Partial<ServerDetailRow> = {}): ServerDetailRow {
  return {
    id: 'srv-1',
    name: 'Before',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
    ...overrides,
  }
}

test('cachedServerDetailReadModel shows a person their own edit at once, and caches until then', async () => {
  const detailRows = [detailRow()]
  const presenceRows = [bareServerRow('srv-1', 'u1')]
  const db = createStubDb({ detailRows, presenceRows })
  const cache = memoryRedis(new Map(), db)
  const ctx = fakeContext({ db, queryCache: cache })
  const opts = { organizationId: 'org-1', serverId: 'srv-1' }

  assertEquals((await cachedServerDetailReadModel(ctx, opts))?.row.name, 'Before')

  // The row changes underneath but its last-change time has not moved: the cached copy answers.
  detailRows[0] = detailRow({ name: 'Hidden' })
  assertEquals((await cachedServerDetailReadModel(ctx, opts))?.row.name, 'Before')

  // An edit moves the last-change time, which changes the key: the new row shows at once.
  presenceRows[0] = bareServerRow('srv-1', 'u2')
  detailRows[0] = detailRow({ name: 'After' })
  assertEquals((await cachedServerDetailReadModel(ctx, opts))?.row.name, 'After')
})

test('cachedServerDetailReadModel never serves one organization the copy of another', async () => {
  const store = new Map<string, string>()
  const dbOne = createStubDb({
    detailRows: [detailRow({ name: 'Org one server' })],
    presenceRows: [bareServerRow('srv-1', 'u1')],
  })
  const dbTwo = createStubDb({
    detailRows: [detailRow({ name: 'Org two server', organizationId: 'org-2' })],
    presenceRows: [bareServerRow('srv-1', 'u1')],
  })
  const one = fakeContext({ db: dbOne, queryCache: memoryRedis(store, dbOne) })
  const two = fakeContext({ db: dbTwo, queryCache: memoryRedis(store, dbTwo) })

  const first = await cachedServerDetailReadModel(one, {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })
  const second = await cachedServerDetailReadModel(two, {
    organizationId: 'org-2',
    serverId: 'srv-1',
  })
  assertEquals(first?.row.name, 'Org one server')
  assertEquals(second?.row.name, 'Org two server')
  assertEquals(store.size, 2)
  const again = await cachedServerDetailReadModel(one, {
    organizationId: 'org-1',
    serverId: 'srv-1',
  })
  assertEquals(again?.row.name, 'Org one server')
})
