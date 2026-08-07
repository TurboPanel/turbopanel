import { assertEquals, assertRejects } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { createPassthroughQueryCache } from '../passthrough-query-cache.ts'
import {
  cachedServerDetailReadModel,
  type ServerDetailRow,
} from './server-detail.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

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
  }>
}): Db {
  const detailRows = opts.detailRows ?? []
  const presenceRows = opts.presenceRows ?? []

  return {
    select: (fields: Record<string, unknown>) => {
      const isPresence = 'daemon' in fields || 'connected' in fields
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

test('cachedServerDetailReadModel rejects when database is missing', async () => {
  await assertRejects(
    () =>
      cachedServerDetailReadModel(fakeContext({}), {
        organizationId: 'org-1',
        serverId: 'srv-1',
      }),
    Error,
    'Database unavailable',
  )
})

test('cachedServerDetailReadModel returns null when the row is missing', async () => {
  const db = createStubDb({ detailRows: [] })
  const result = await cachedServerDetailReadModel(
    fakeContext({ db }),
    { organizationId: 'org-1', serverId: 'srv-missing' },
  )
  assertEquals(result, null)
})

test('cachedServerDetailReadModel returns row plus presence enrichment', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    displayName: 'Primary',
    organizationId: 'org-1',
    licenseId: 'lic-1',
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
  const presenceRows = [{
    id: 'srv-1',
    daemon: {
      projection: { remoteAddress: '__direct__' },
    },
    metadata: null,
    hostname: 'primary',
    machineKey: null,
    connected: true,
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }]
  const db = createStubDb({ detailRows: [row], presenceRows })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row, row)
  assertEquals(result?.presence?.serverId, 'srv-1')
  assertEquals(result?.presence?.connected, true)
  assertEquals(typeof result?.colocatedWithInstance, 'boolean')
})

test('cachedServerDetailReadModel returns null presence when preload is empty', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    displayName: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [] })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row, row)
  assertEquals(result?.presence, null)
  assertEquals(result?.colocatedWithInstance, false)
})
