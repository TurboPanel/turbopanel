import { assertEquals } from 'jsr:@std/assert'

/**
 * Regression guard: Hyperdrive caches parameterized SELECTs on HYPERDRIVE_CACHED
 * only when postgres.js uses prepare: true (see Workers Hyperdrive notes in
 * AGENTS.md and PG_OPTS_WORKERS in db.ts).
 */
Deno.test('PG_OPTS_WORKERS keeps prepare: true for Hyperdrive cacheability', async () => {
  const source = await Deno.readTextFile(new URL('./db.ts', import.meta.url))
  const workersOptsMatch = /const PG_OPTS_WORKERS\s*=\s*\{([^}]*)\}/.exec(source)
  assertEquals(workersOptsMatch !== null, true)
  assertEquals(/\bprepare:\s*true\b/.test(workersOptsMatch![1]), true)
})
