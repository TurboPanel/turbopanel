import { assertEquals, assertRejects } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { createPassthroughQueryCache } from '../passthrough-query-cache.ts'
import {
  cachedServersListReadModel,
  type ServersListRow,
} from './servers-list.ts'

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

/** Thenable drizzle-shaped terminal that also supports `.orderBy` / `.limit`. */
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

/**
 * Host-free Db stub: list-row SELECTs (licenseId field) vs presence SELECTs
 * (daemon/connected fields).
 */
function createStubDb(opts: {
  listRows?: ServersListRow[]
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
  const listRows = opts.listRows ?? []
  const presenceRows = opts.presenceRows ?? []

  return {
    select: (fields: Record<string, unknown>) => {
      const isPresence = 'daemon' in fields || 'connected' in fields
      const rows = isPresence ? presenceRows : listRows
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

test('cachedServersListReadModel rejects when database is missing', async () => {
  await assertRejects(
    () =>
      cachedServersListReadModel(fakeContext({}), {
        userId: 'user-1',
        organizationId: 'org-1',
        visibleIds: ['srv-1'],
      }),
    Error,
    'Database unavailable',
  )
})

test('cachedServersListReadModel returns empty enrichment for empty visible ids', async () => {
  const db = createStubDb({})
  const payload = await cachedServersListReadModel(
    fakeContext({ db }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      visibleIds: [],
    },
  )
  assertEquals(payload, { rows: [], presence: [], colocatedIds: [] })
})

test('cachedServersListReadModel sorts visible ids and enriches from primary db', async () => {
  const listRows: ServersListRow[] = [
    {
      id: 'srv-b',
      displayName: 'B',
      organizationId: 'org-1',
      licenseId: null,
      options: null,
      createdAt: '2024-01-02T00:00:00.000Z',
    },
    {
      id: 'srv-a',
      displayName: 'A',
      organizationId: 'org-1',
      licenseId: 'lic-1',
      options: null,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  ]
  const presenceRows = listRows.map((row) => ({
    id: row.id,
    daemon: null,
    metadata: null,
    hostname: row.displayName,
    machineKey: null,
    connected: row.id === 'srv-a',
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }))
  const db = createStubDb({ listRows, presenceRows })
  const cache = createPassthroughQueryCache(db)

  const payload = await cachedServersListReadModel(
    fakeContext({ db, queryCache: cache }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      // Unsorted on purpose — key + IN query use localeCompare order.
      visibleIds: ['srv-b', 'srv-a'],
    },
  )

  assertEquals(payload.rows, listRows)
  assertEquals(payload.presence.length, 2)
  assertEquals(
    payload.presence.map((p) => p.serverId).sort((a, b) => a.localeCompare(b)),
    ['srv-a', 'srv-b'],
  )
  assertEquals(Array.isArray(payload.colocatedIds), true)
})
