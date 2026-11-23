/**
 * Guard: an error answered from a route goes through `apiError`
 * (`src/lib/http/api-error.ts`), not a hand-built `c.json({ error` or
 * `c.json({ ok: false`. The files that still do are listed in
 * `api-error-baseline.ts`; the count per file can only go down.
 */

import { assertEquals } from '@std/assert'
import { HAND_BUILT_ERROR_BASELINE } from './api-error-baseline.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PATTERN =
  /\b(?:c\.json\(|new Response\(\s*JSON\.stringify\()\s*\{[^{}]*?\b(?:ok\s*:\s*false|error\s*[:,}])/g

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory) {
      yield* sourceFiles(path)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield path
    }
  }
}

async function countHandBuilt(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for await (const file of sourceFiles('src')) {
    const n = (await Deno.readTextFile(file)).match(PATTERN)?.length ?? 0
    if (n > 0) counts[file] = n
  }
  return counts
}

test('no new hand-built error bodies, and the baseline only shrinks', async () => {
  const actual = await countHandBuilt()
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort())
  assertEquals(
    sorted(actual),
    sorted(HAND_BUILT_ERROR_BASELINE),
    'Use apiError(c, status, code, message) from src/lib/http/api-error.ts. ' +
      'If you moved a route onto it, run: node scripts/gen-api-error-baseline.mjs'
  )
})

test('the guard pattern sees the shapes it bans', () => {
  assertEquals("c.json({ error: 'x' }, 400)".match(PATTERN)?.length, 1)
  assertEquals("c.json({ ok: false, error: 'x' }, 400)".match(PATTERN)?.length, 1)
  assertEquals("c.json(\n  { error: 'x' }, 400)".match(PATTERN)?.length, 1)
  assertEquals("c.json({ code: 'x', error: 'x' }, 400)".match(PATTERN)?.length, 1)
  assertEquals("c.json({ message: 'x', ok: false }, 400)".match(PATTERN)?.length, 1)
  assertEquals('c.json({ error }, 400)'.match(PATTERN)?.length, 1)
  assertEquals(
    "new Response(JSON.stringify({ error: 'x' }), { status: 400 })".match(PATTERN)?.length,
    1
  )
  assertEquals('c.json({ ok: true })'.match(PATTERN), null)
  assertEquals('c.json({ ok: true, data: { error: 1 } })'.match(PATTERN), null)
})
