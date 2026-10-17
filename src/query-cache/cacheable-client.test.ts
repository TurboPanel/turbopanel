import { assertEquals, assertThrows } from '@std/assert'
import { CACHED_READ_REGISTRY } from './approved-read-models.ts'
import { withCacheableUnsafe } from './cacheable-client.ts'
import { inspectCachedRead } from './cached-read.ts'
import { serversListCachedRead } from './read-models/servers-list.ts'
import { createDbUsage } from './db-usage.ts'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema.ts'
import { UncacheableStatementError, findUncacheableStatementError } from './statement-guard.ts'

const test = Deno.test.bind(Deno)

/** The reviewed list statement, built the way the cached read builds it. */
const LIST_SQL = inspectCachedRead(serversListCachedRead.definition, {
  organizationId: 'org-1',
  ids: ['a', 'b'],
  stamp: 's',
}).sql

function fakeClient() {
  const calls: Array<{ query: string; args: unknown; opts: unknown }> = []
  const fn = (() => {
    throw new Error('tagged template reached the client')
  }) as unknown as Record<string, unknown>
  fn.unsafe = (query: string, args: unknown, opts: unknown) => {
    calls.push({ query, args, opts })
    return Promise.resolve([])
  }
  fn.begin = () => {
    throw new Error('begin reached the client')
  }
  fn.options = { parsers: {}, serializers: {} }
  fn.end = () => Promise.resolve()
  return { client: fn as never, calls }
}

test('a registered select goes out as a named prepared statement', async () => {
  const { client, calls } = fakeClient()
  const usage = createDbUsage()
  const guarded = withCacheableUnsafe(client, { usage }) as unknown as {
    unsafe: (q: string, a?: unknown[], o?: Record<string, unknown>) => Promise<unknown>
  }
  // Caller options cannot turn prepared statements off.
  await guarded.unsafe(LIST_SQL, ['s', 'a', 'b'], { prepare: false })
  assertEquals(calls.length, 1)
  assertEquals(calls[0]!.opts, { prepare: true, simple: false })
  assertEquals(calls[0]!.args, ['s', 'a', 'b'])
  assertEquals(usage.cached, 1)
})

test('writes, volatile selects and unregistered selects never reach the client', () => {
  const { client, calls } = fakeClient()
  const guarded = withCacheableUnsafe(client) as unknown as {
    unsafe: (q: string, a?: unknown[]) => unknown
    begin: () => unknown
  }
  for (const text of [
    'insert into "server" ("id") values ($1)',
    'select now()',
    'select "id" from "session" where "id" = $1',
  ]) {
    assertThrows(() => guarded.unsafe(text, []), UncacheableStatementError, undefined, text)
  }
  assertThrows(() => guarded.begin(), UncacheableStatementError)
  assertEquals(calls.length, 0)
})

test('the tagged-template call form is refused', () => {
  const { client } = fakeClient()
  const guarded = withCacheableUnsafe(client) as unknown as (s: TemplateStringsArray) => unknown
  assertThrows(() => guarded`select 1`, UncacheableStatementError)
})

test('members other than the ones drizzle needs are refused', () => {
  const { client } = fakeClient()
  ;(client as unknown as Record<string, unknown>).largeObject = () => 'reached'
  const guarded = withCacheableUnsafe(client) as unknown as { largeObject: () => unknown }
  assertThrows(() => guarded.largeObject(), UncacheableStatementError)
})

test('a refusal under real drizzle is wrapped and still found', async () => {
  const { client } = fakeClient()
  const db = drizzle(withCacheableUnsafe(client), { schema })
  const error = await db
    .select({ id: schema.server.id })
    .from(schema.server)
    .then(
      () => null,
      (err: unknown) => err
    )
  assertEquals(findUncacheableStatementError(error) instanceof UncacheableStatementError, true)
})

test('every registry entry has a fingerprint', () => {
  for (const entry of Object.values(CACHED_READ_REGISTRY)) {
    assertEquals(entry.fingerprint.length, 16)
  }
})
