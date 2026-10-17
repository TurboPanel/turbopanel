import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { RedisCellClient } from '../../daemon/cell/redis/client.ts'
import { createRedisQueryCache } from '../redis-query-cache.ts'
import { ALL_CACHED_READS } from '../cached-reads.ts'
import { inspectCachedRead } from '../cached-read.ts'
import {
  cachedEnvironmentDetail,
  cachedEnvironmentsList,
  cachedProjectDetail,
  cachedProjectsList,
  cachedWorkspacesList,
} from './hierarchy-reads.ts'

const test = Deno.test.bind(Deno)

type Rows = Array<Record<string, unknown>>

/** Stand-in for the database the cached read runs on: every select answers with `rows()`. */
function stubDb(rows: () => Rows, counter?: { selects: number }): Db {
  const answer = () => {
    const promise = Promise.resolve(rows())
    return {
      orderBy: () => promise,
      limit: () => promise,
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    }
  }
  return {
    select: () => {
      if (counter) counter.selects += 1
      return { from: () => ({ where: answer }) }
    },
  } as unknown as Db
}

function contextFor(db: Db, store: Map<string, string>): Context {
  const queryCache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })
  return {
    get: (key: string) => ({ db, queryCache })[key as 'db' | 'queryCache'],
  } as unknown as Context
}

const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: null,
  workspaceId: 'w-1',
  repositoryId: null,
  metadata: null,
  options: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  _v: 'dropped',
  ...extra,
})
const environmentRow = (id: string, name: string) => ({
  id,
  name,
  description: null,
  projectId: 'p-1',
  serverId: null,
  metadata: null,
  options: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  _v: 'dropped',
})
const workspaceRow = (id: string, name: string, organizationId = 'org-1') => ({
  id,
  name,
  description: null,
  kind: 'user',
  organizationId,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  _v: 'dropped',
})

type ListCase = {
  label: string
  list: (
    c: Context,
    o: { organizationId: string; visible: Array<{ id: string; updatedAt: string }> }
  ) => Promise<Array<{ id: string; name: string | null }>>
  row: (id: string, name: string) => Record<string, unknown>
}

const LIST_CASES: ListCase[] = [
  { label: 'projects', list: cachedProjectsList, row: project },
  { label: 'environments', list: cachedEnvironmentsList, row: environmentRow },
  { label: 'workspaces', list: cachedWorkspacesList, row: (id, name) => workspaceRow(id, name) },
]

for (const { label, list, row } of LIST_CASES) {
  test(`${label} list: a person's own edit shows at once, and an unchanged list is served from the cache`, async () => {
    const rows: Rows = [row('a', 'Before')]
    const counter = { selects: 0 }
    const db = stubDb(() => rows, counter)
    const ctx = contextFor(db, new Map())
    const visible = [{ id: 'a', updatedAt: 't1' }]
    const opts = () => ({ organizationId: 'org-1', visible })

    assertEquals((await list(ctx, opts()))[0]?.name, 'Before')

    // Changed underneath, but the row's last change has not moved: the cached copy answers.
    rows[0] = row('a', 'Hidden')
    assertEquals((await list(ctx, opts()))[0]?.name, 'Before')
    assertEquals(counter.selects, 1)

    // The edit moves the last change (the primary connection reports it), so the key changes.
    visible[0] = { id: 'a', updatedAt: 't2' }
    rows[0] = row('a', 'After')
    assertEquals((await list(ctx, opts()))[0]?.name, 'After')
    assertEquals(counter.selects, 2)
  })

  test(`${label} list: the stamp column never reaches the caller`, async () => {
    const db = stubDb(() => [row('a', 'A')])
    const ctx = contextFor(db, new Map())
    const [first] = await list(ctx, {
      organizationId: 'org-1',
      visible: [{ id: 'a', updatedAt: 't1' }],
    })
    assertEquals('_v' in (first as object), false)
  })

  test(`${label} list: a different person never gets another's cached rows`, async () => {
    const store = new Map<string, string>()
    const dbOne = stubDb(() => [row('a', 'Visible to one')])
    const dbTwo = stubDb(() => [row('b', 'Visible to two')])
    const one = contextFor(dbOne, store)
    const two = contextFor(dbTwo, store)
    const seenByOne = { organizationId: 'org-1', visible: [{ id: 'a', updatedAt: 't1' }] }
    const seenByTwo = { organizationId: 'org-1', visible: [{ id: 'b', updatedAt: 't1' }] }

    assertEquals(
      (await list(one, seenByOne)).map((r) => r.id),
      ['a']
    )
    assertEquals(
      (await list(two, seenByTwo)).map((r) => r.id),
      ['b']
    )
    assertEquals(store.size, 2)
    // Each is served its own copy again, from the cache.
    assertEquals(
      (await list(one, seenByOne)).map((r) => r.id),
      ['a']
    )
    assertEquals(
      (await list(two, seenByTwo)).map((r) => r.id),
      ['b']
    )
    assertEquals(store.size, 2)

    // The same ids in another organization are another key.
    await list(one, { ...seenByOne, organizationId: 'org-2' })
    assertEquals(store.size, 3)
  })

  test(`${label} list: nothing visible means no statement and no cache entry`, async () => {
    const counter = { selects: 0 }
    const store = new Map<string, string>()
    const ctx = contextFor(
      stubDb(() => [], counter),
      store
    )
    assertEquals(await list(ctx, { organizationId: 'org-1', visible: [] }), [])
    assertEquals(counter.selects, 0)
    assertEquals(store.size, 0)
  })
}

type DetailCase = {
  label: string
  detail: (
    c: Context,
    o: { organizationId: string; id: string; updatedAt: string }
  ) => Promise<{ id: string; name: string | null } | null>
  row: (id: string, name: string) => Record<string, unknown>
}

const DETAIL_CASES: DetailCase[] = [
  { label: 'project', detail: cachedProjectDetail, row: project },
  { label: 'environment', detail: cachedEnvironmentDetail, row: environmentRow },
]

for (const { label, detail, row } of DETAIL_CASES) {
  test(`${label} detail: a person's own edit shows at once`, async () => {
    const rows: Rows = [row('a', 'Before')]
    const ctx = contextFor(
      stubDb(() => rows),
      new Map()
    )

    assertEquals(
      (await detail(ctx, { organizationId: 'org-1', id: 'a', updatedAt: 't1' }))?.name,
      'Before'
    )
    rows[0] = row('a', 'Hidden')
    assertEquals(
      (await detail(ctx, { organizationId: 'org-1', id: 'a', updatedAt: 't1' }))?.name,
      'Before'
    )
    rows[0] = row('a', 'After')
    assertEquals(
      (await detail(ctx, { organizationId: 'org-1', id: 'a', updatedAt: 't2' }))?.name,
      'After'
    )
  })

  test(`${label} detail: another organization never gets the cached copy`, async () => {
    const store = new Map<string, string>()
    const one = contextFor(
      stubDb(() => [row('a', 'Org one')]),
      store
    )
    const two = contextFor(
      stubDb(() => [row('a', 'Org two')]),
      store
    )
    assertEquals(
      (await detail(one, { organizationId: 'org-1', id: 'a', updatedAt: 't1' }))?.name,
      'Org one'
    )
    assertEquals(
      (await detail(two, { organizationId: 'org-2', id: 'a', updatedAt: 't1' }))?.name,
      'Org two'
    )
    assertEquals(store.size, 2)
  })

  test(`${label} detail: a missing row is null`, async () => {
    const ctx = contextFor(
      stubDb(() => []),
      new Map()
    )
    assertEquals(await detail(ctx, { organizationId: 'org-1', id: 'gone', updatedAt: 't1' }), null)
  })
}

test('the workspace and project filters are not part of any cached statement', () => {
  for (const read of ALL_CACHED_READS) {
    for (const sample of read.definition.samples) {
      const { sql } = inspectCachedRead(read.definition as never, sample as never)
      assertEquals(
        /workspace_id|project_id/.test(sql.slice(sql.indexOf(' where '))),
        false,
        read.definition.id
      )
    }
  }
})
