import { assertEquals, assertThrows } from '@std/assert'

import { HYPERDRIVE_CACHED_PLACEHOLDER_ID } from './workers-bindings.ts'
import {
  assertExercisedHyperdriveCachedBindings,
  readHyperdriveCachedIdsFromWranglerJsonc,
  stripJsoncLineComments,
} from './wrangler-hyperdrive-bindings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('stripJsoncLineComments removes // comments but keeps strings intact', () => {
  const input = [
    '{',
    '  "name": "instance", // top-level worker',
    '  "id": "abc",',
    '}',
  ].join('\n')
  const stripped = stripJsoncLineComments(input)
  assertEquals(stripped.includes('//'), false)
  assertEquals(stripped.includes('"name": "instance"'), true)
})

test('readHyperdriveCachedIdsFromWranglerJsonc extracts top-level and env ids', () => {
  const wrangler = `
{
  "hyperdrive": [
    { "binding": "HYPERDRIVE_CACHED", "id": "top-level-id" }
  ],
  "env": {
    "testing": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "testing-id" }
      ]
    },
    "live": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "live-id" }
      ]
    }
  }
}
`
  assertEquals(readHyperdriveCachedIdsFromWranglerJsonc(wrangler), {
    topLevel: 'top-level-id',
    testing: 'testing-id',
    live: 'live-id',
  })
})

test('readHyperdriveCachedIdsFromWranglerJsonc returns empty when binding missing', () => {
  assertEquals(readHyperdriveCachedIdsFromWranglerJsonc('{ "name": "x" }'), {
    topLevel: undefined,
    testing: undefined,
    live: undefined,
  })
})

test('assertExercisedHyperdriveCachedBindings rejects missing or placeholder ids', () => {
  assertThrows(
    () => assertExercisedHyperdriveCachedBindings({ testing: undefined }),
    Error,
    'testing HYPERDRIVE_CACHED',
  )
  assertThrows(
    () =>
      assertExercisedHyperdriveCachedBindings({
        testing: HYPERDRIVE_CACHED_PLACEHOLDER_ID,
        live: 'real-live-id',
      }),
    Error,
    'testing HYPERDRIVE_CACHED',
  )
  assertThrows(
    () =>
      assertExercisedHyperdriveCachedBindings({
        testing: 'real-testing-id',
        live: HYPERDRIVE_CACHED_PLACEHOLDER_ID,
      }),
    Error,
    'live HYPERDRIVE_CACHED',
  )
})

test('assertExercisedHyperdriveCachedBindings accepts real ids', () => {
  assertExercisedHyperdriveCachedBindings({
    testing: 'real-testing-id',
    live: 'real-live-id',
  })
})
