import { assert, assertEquals } from 'jsr:@std/assert'
import {
  resolveWorkersCachedDb,
  resolveWorkersQueryCache,
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
