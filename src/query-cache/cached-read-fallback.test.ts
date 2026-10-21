import { assert, assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Context } from 'hono'
import type { Db } from '../db/connection.ts'
import * as schema from '../db/schema.ts'
import { withCacheableUnsafe } from './cacheable-client.ts'
import { defineCachedRead, type CachedReadDb } from './cached-read.ts'
import { createDbUsage } from './db-usage.ts'
import { createHyperdriveQueryCache, isCachedConnectionFailure } from './hyperdrive-query-cache.ts'
import { serversListCachedRead } from './read-models/servers-list.ts'

const test = Deno.test.bind(Deno)

type Behaviour = 'rows' | { fail: Record<string, unknown> & { message?: string } }

/** A postgres.js stand-in that records statements and either answers or fails like a dead connection. */
function fakeClient(behaviour: Behaviour) {
  const sent: string[] = []
  const fn = (() => undefined) as unknown as Record<string, unknown>
  fn.options = { parsers: {}, serializers: {} }
  fn.end = () => Promise.resolve()
  fn.unsafe = (query: string) => {
    sent.push(query)
    const run = () =>
      behaviour === 'rows'
        ? Promise.resolve([])
        : Promise.reject(
            Object.assign(new Error(behaviour.fail.message ?? 'failed'), behaviour.fail)
          )
    return { values: run, then: (a: never, b: never) => run().then(a, b) }
  }
  return { client: fn as never, sent }
}

function setup(cached: Behaviour, primary: Behaviour) {
  const cachedClient = fakeClient(cached)
  const primaryClient = fakeClient(primary)
  const usage = createDbUsage()
  const cachedDb = drizzle(withCacheableUnsafe(cachedClient.client, { usage }), { schema })
  const db = drizzle(primaryClient.client, { schema })
  const queryCache = createHyperdriveQueryCache(cachedDb as unknown as Db, { usage })
  const ctx = {
    get: (key: string) => ({ db, queryCache })[key as 'db' | 'queryCache'],
  } as unknown as Context
  return { ctx, cachedClient, primaryClient, usage }
}

const INPUT = { organizationId: 'org-1', ids: ['srv-1'], stamp: 's' }

test('a healthy cached connection answers and the primary is not used', async () => {
  const { ctx, cachedClient, primaryClient, usage } = setup('rows', 'rows')
  assertEquals(await serversListCachedRead(ctx, INPUT), [])
  assertEquals(cachedClient.sent.length, 1)
  assertEquals(primaryClient.sent.length, 0)
  assertEquals(usage.readModels, [{ id: 'servers-list', outcome: 'cached' }])
})

test('a closed cached connection falls back to the primary once', async () => {
  const { ctx, cachedClient, primaryClient, usage } = setup(
    { fail: { code: 'CONNECTION_CLOSED' } },
    'rows'
  )
  assertEquals(await serversListCachedRead(ctx, INPUT), [])
  assertEquals(cachedClient.sent.length, 1)
  assertEquals(primaryClient.sent.length, 1)
  assertEquals(usage.fallback, 1)
  assertEquals(usage.readModels, [{ id: 'servers-list', outcome: 'fallback' }])
})

test('an unreachable or timed-out cached connection falls back too', async () => {
  for (const fail of [
    { code: 'CONNECT_TIMEOUT' },
    { code: 'ECONNREFUSED' },
    { message: 'Failed to acquire a connection from the pool' },
    { message: 'Network connection lost' },
  ]) {
    const { ctx, primaryClient } = setup({ fail }, 'rows')
    assertEquals(await serversListCachedRead(ctx, INPUT), [])
    assertEquals(primaryClient.sent.length, 1, JSON.stringify(fail))
  }
})

test('a query that ran and failed is not retried on the primary', async () => {
  const { ctx, primaryClient } = setup({ fail: { code: '42601', message: 'syntax error' } }, 'rows')
  await assertRejects(() => serversListCachedRead(ctx, INPUT))
  assertEquals(primaryClient.sent.length, 0)
  const timeout = setup({ fail: { code: '57014', message: 'statement timeout' } }, 'rows')
  await assertRejects(() => serversListCachedRead(timeout.ctx, INPUT))
  assertEquals(timeout.primaryClient.sent.length, 0)
})

test('with both connections down the closed connection error reaches the request retry', async () => {
  const { ctx, primaryClient } = setup(
    { fail: { code: 'CONNECTION_CLOSED' } },
    { fail: { code: 'CONNECTION_CLOSED' } }
  )
  const error = await assertRejects(() => serversListCachedRead(ctx, INPUT))
  assert(isCachedConnectionFailure(error))
  assertEquals(primaryClient.sent.length, 1)
})

test('a statement that differs from the registered one never touches the cached connection', async () => {
  const { ctx, cachedClient, primaryClient } = setup('rows', 'rows')
  const changed = defineCachedRead({
    id: 'servers-list',
    build: (db: CachedReadDb, input: typeof INPUT) =>
      db
        .select({ id: schema.server.id })
        .from(schema.server)
        .where(eq(schema.server.id, input.ids[0]!)),
    transform: (rows: unknown[]) => rows,
    samples: [INPUT],
  })
  await changed(ctx, INPUT)
  assertEquals(cachedClient.sent.length, 0)
  assertEquals(primaryClient.sent.length, 1)
})

test('only connection failures count as a cached connection failure', () => {
  assertEquals(isCachedConnectionFailure(new Error('syntax error')), false)
  assertEquals(
    isCachedConnectionFailure(
      new Error('Failed query', { cause: Object.assign(new Error('x'), { code: 'x' }) })
    ),
    false
  )
  assertEquals(
    isCachedConnectionFailure(
      new Error('Failed query', {
        cause: Object.assign(new Error('t'), { code: 'CONNECT_TIMEOUT' }),
      })
    ),
    true
  )
})
