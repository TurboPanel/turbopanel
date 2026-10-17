import { assertEquals, assertThrows } from '@std/assert'
import { CACHED_READ_REGISTRY } from './approved-read-models.ts'
import { withCacheableUnsafe } from './cacheable-client.ts'
import { createDbUsage } from './db-usage.ts'
import { UncacheableStatementError } from './statement-guard.ts'

const test = Deno.test.bind(Deno)

const REGISTERED_SQL: Record<string, string> = {
  'servers-list':
    'select "server"."id", "server"."name", "server"."organization_id", "license"."id", "server"."machine_class", "server"."options", "server"."created_at" from "server" left join "license" on "license"."server_id" = "server"."id" where "server"."id" in ($1, $2) order by "server"."created_at"',
}

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
  await guarded.unsafe(REGISTERED_SQL['servers-list'], ['a', 'b'], { prepare: false })
  assertEquals(calls.length, 1)
  assertEquals(calls[0]!.opts, { prepare: true })
  assertEquals(calls[0]!.args, ['a', 'b'])
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

test('every registry entry has a fingerprint', () => {
  for (const entry of Object.values(CACHED_READ_REGISTRY)) {
    assertEquals(entry.fingerprint.length, 16)
  }
})
