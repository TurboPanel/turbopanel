import { describe, expect, it } from 'vitest'
import {
  assertExercisedHyperdriveCachedBindings,
  readHyperdriveCachedIdsFromWranglerJsonc,
  stripJsoncLineComments,
} from './wrangler-hyperdrive-bindings.ts'
import { HYPERDRIVE_CACHED_PLACEHOLDER_ID } from './workers-bindings.ts'

describe('stripJsoncLineComments', () => {
  it('removes trailing // comments from each line', () => {
    const input = [
      '{',
      '  "id": "abc", // line comment',
      '  "next": 1',
    ].join('\n')
    expect(stripJsoncLineComments(input)).toBe(
      ['{', '  "id": "abc", ', '  "next": 1'].join('\n'),
    )
  })
})

describe('readHyperdriveCachedIdsFromWranglerJsonc', () => {
  it('parses top-level and env-scoped HYPERDRIVE_CACHED ids', () => {
    const text = `
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
    expect(readHyperdriveCachedIdsFromWranglerJsonc(text)).toEqual({
      topLevel: 'top-level-id',
      testing: 'testing-id',
      live: 'live-id',
    })
  })

  it('parses testing env when live block is absent', () => {
    const text = `
{
  "env": {
    "testing": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE_CACHED", "id": "testing-only-id" }
      ]
    }
  }
}
`
    expect(readHyperdriveCachedIdsFromWranglerJsonc(text)).toEqual({
      topLevel: undefined,
      testing: 'testing-only-id',
      live: undefined,
    })
  })
})

describe('assertExercisedHyperdriveCachedBindings', () => {
  it('throws when an exercised env id is missing or the dev placeholder', () => {
    expect(() =>
      assertExercisedHyperdriveCachedBindings({ testing: undefined, live: 'real-id' }),
    ).toThrow(/testing HYPERDRIVE_CACHED/)
    expect(() =>
      assertExercisedHyperdriveCachedBindings({
        testing: 'real-id',
        live: HYPERDRIVE_CACHED_PLACEHOLDER_ID,
      }),
    ).toThrow(/live HYPERDRIVE_CACHED/)
  })

  it('accepts real ids for both exercised envs', () => {
    expect(() =>
      assertExercisedHyperdriveCachedBindings({
        testing: 'a1b2c3d4e5f6478901234567890abcde',
        live: 'd9c42999730048e2842dccb61aa05d67',
      }),
    ).not.toThrow()
  })
})
