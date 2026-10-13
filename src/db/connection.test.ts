import { assertEquals } from '@std/assert'
import { withPreparedUnsafe } from './connection.ts'

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
 * `withPreparedUnsafe` (tested below) for Hyperdrive to see named statements.
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

test('withPreparedUnsafe forces prepare: true on unsafe() and forwards the rest', () => {
  const calls: unknown[][] = []
  const fake = {
    unsafe: (...args: unknown[]) => {
      calls.push(args)
      return 'pending'
    },
    end: () => 'ended',
  }
  const wrapped = withPreparedUnsafe(fake as never) as unknown as typeof fake
  assertEquals(wrapped.unsafe('select $1', [1] as never), 'pending')
  assertEquals(wrapped.unsafe('select 1', undefined as never, { simple: true } as never), 'pending')
  assertEquals(calls[0], ['select $1', [1], { prepare: true }])
  assertEquals(calls[1], ['select 1', [], { prepare: true, simple: true }])
  assertEquals(wrapped.end(), 'ended')
})

test('resolveWorkersCachedDb asks for prepared statements; the primary does not', async () => {
  const source = await Deno.readTextFile(
    new URL('../platform/workers/workers-bindings.ts', import.meta.url)
  )
  assertEquals(/HYPERDRIVE_CACHED, \{ preparedStatements: true \}/.test(source), true)
  assertEquals(/workersDbFactory\(env\.HYPERDRIVE\)/.test(source), true)
})
