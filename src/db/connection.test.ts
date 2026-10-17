import { assertEquals } from '@std/assert'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Regression guard: `prepare: true` covers postgres.js tagged templates only. Drizzle
 * runs everything through `unsafe()`, so the cached binding also needs
 * `withCacheableUnsafe` (tested in `query-cache/cacheable-client.test.ts`) for Hyperdrive to see named statements.
 */
test('PG_OPTS_WORKERS keeps prepare: true for tagged-template queries', async () => {
  const source = await Deno.readTextFile(new URL('./connection.ts', import.meta.url))
  const workersOptsMatch = /const PG_OPTS_WORKERS\s*=\s*\{([^}]*)\}/.exec(source)
  assertEquals(workersOptsMatch !== null, true)
  assertEquals(/\bprepare:\s*true\b/.test(workersOptsMatch![1]), true)
})

test('PG_OPTS_WORKERS turns fetch_types off (no pg_type lookup per request)', async () => {
  const source = await Deno.readTextFile(new URL('./connection.ts', import.meta.url))
  const match = /const PG_OPTS_WORKERS\s*=\s*\{([^}]*)\}/.exec(source)
  assertEquals(/\bfetch_types:\s*false\b/.test(match![1]), true)
})

test('createWorkersDb wraps the cached client with the statement guard', async () => {
  const source = await Deno.readTextFile(new URL('./connection.ts', import.meta.url))
  assertEquals(/options\.preparedStatements\s*\?\s*withCacheableUnsafe\(/.test(source), true)
})

test('resolveWorkersCachedDb asks for prepared statements; the primary does not', async () => {
  const source = await Deno.readTextFile(
    new URL('../platform/workers/workers-bindings.ts', import.meta.url)
  )
  assertEquals(
    /workersDbFactory\(env\.HYPERDRIVE_CACHED, \{\s*preparedStatements: true/.test(source),
    true
  )
  assertEquals(/workersDbFactory\(env\.HYPERDRIVE, options\)/.test(source), true)
})
