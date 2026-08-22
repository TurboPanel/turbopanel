import { assertEquals } from '@std/assert'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Regression guard: Hyperdrive caches parameterized SELECTs on HYPERDRIVE_CACHED
 * only when postgres.js uses prepare: true (see Workers Hyperdrive notes in
 * AGENTS.md and PG_OPTS_WORKERS in db.ts).
 */
test('PG_OPTS_WORKERS keeps prepare: true for Hyperdrive cacheability', async () => {
  const source = await Deno.readTextFile(new URL('./db.ts', import.meta.url))
  const workersOptsMatch = /const PG_OPTS_WORKERS\s*=\s*\{([^}]*)\}/.exec(source)
  assertEquals(workersOptsMatch !== null, true)
  assertEquals(/\bprepare:\s*true\b/.test(workersOptsMatch![1]), true)
})
