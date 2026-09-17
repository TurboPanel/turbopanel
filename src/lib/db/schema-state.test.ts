/**
 * Guard: the schema-state comparison the compiled `migrate` verb and the
 * Deno instance boot run (`schema-state.ts`) is the same one `pnpm migrate`
 * runs (`scripts/schema-state.mjs`) — same states, same sentences — and it
 * classifies every history shape a database can be in.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  compareSchemaState,
  describeSchemaState,
  MIGRATIONS_FOLDER,
  readShippedMigrationHashes,
  type SchemaState,
} from './schema-state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ROOT = join(dirname(fromFileUrl(import.meta.url)), '../../..')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const X = 'x'.repeat(64)

test('compareSchemaState classifies every history shape', () => {
  assertEquals(compareSchemaState([], [A, B]), { status: 'unmigrated', applied: 0, shipped: 2 })
  assertEquals(compareSchemaState([A, B], [A, B]), { status: 'current', applied: 2, shipped: 2 })
  assertEquals(compareSchemaState([A], [A, B, C]), {
    status: 'behind',
    applied: 1,
    shipped: 3,
    pending: [B, C],
  })
  // A hash the build does not ship: a newer release migrated it, or it is
  // the pre-freeze baseline. Both refuse.
  assertEquals(compareSchemaState([A, X], [A, B]), {
    status: 'ahead',
    applied: 2,
    shipped: 2,
    unknown: [X],
  })
  // Same set, wrong order: not a prefix of the manifest.
  assertEquals(compareSchemaState([B, A], [A, B]), { status: 'diverged', applied: 2, shipped: 2, at: 0 })
})

test('every state has a sentence, and only ahead/diverged say refusing', () => {
  const states: SchemaState[] = [
    { status: 'current', applied: 1, shipped: 1 },
    { status: 'unmigrated', applied: 0, shipped: 1 },
    { status: 'behind', applied: 1, shipped: 2, pending: [B] },
    { status: 'ahead', applied: 1, shipped: 1, unknown: [X] },
    { status: 'diverged', applied: 2, shipped: 2, at: 0 },
  ]
  for (const state of states) {
    const sentence = describeSchemaState(state)
    assertEquals(sentence.length > 0, true)
    assertEquals(
      sentence.endsWith('refusing'),
      state.status === 'ahead' || state.status === 'diverged',
      `${state.status}: ${sentence}`,
    )
  }
})

test('the Node twin (scripts/schema-state.mjs) carries the same sentences verbatim', async () => {
  const twin = await Deno.readTextFile(join(ROOT, 'scripts', 'schema-state.mjs'))
  const own = await Deno.readTextFile(fromFileUrl(new URL('./schema-state.ts', import.meta.url)))
  // Every template sentence in describeSchemaState, byte for byte.
  const sentences = [...own.matchAll(/return `([^`]+)`/g)].map((m) => m[1])
  assertEquals(sentences.length, 5)
  for (const sentence of sentences) {
    assertEquals(twin.includes(sentence), true, `missing in scripts/schema-state.mjs: ${sentence}`)
  }
  // And the same bookkeeping query.
  assertEquals(
    twin.includes('select hash from public.migration order by created_at, id'),
    true,
  )
})

test('the shipped manifest resolves from MIGRATIONS_FOLDER and has sha256 entries', async () => {
  const hashes = await readShippedMigrationHashes(MIGRATIONS_FOLDER)
  assertEquals(hashes.length >= 1, true)
  for (const hash of hashes) assertEquals(/^[0-9a-f]{64}$/.test(hash), true)
  await assertRejects(() => readShippedMigrationHashes(join(ROOT, 'src')))
})
