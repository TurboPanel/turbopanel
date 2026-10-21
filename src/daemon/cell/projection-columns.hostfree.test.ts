import { assertEquals } from '@std/assert'
import { projectionColumnValues } from './postgres-projection.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

test('the filtered projection keys are mirrored to server columns', () => {
  assertEquals(
    projectionColumnValues({
      offlineReason: 'sweep_stale',
      daemonBuild: { commit: 'abc', builtAt: '2026-09-27T18:20:44Z' },
      update: { status: 'updating' },
    }),
    {
      offlineReason: 'sweep_stale',
      daemonCommit: 'abc',
      daemonBuiltAt: '2026-09-27T18:20:44.000Z',
      daemonUpdateStatus: 'updating',
    }
  )
})

test('absent or malformed projection keys read as null columns', () => {
  const empty = {
    offlineReason: null,
    daemonCommit: null,
    daemonBuiltAt: null,
    daemonUpdateStatus: null,
  }
  assertEquals(projectionColumnValues(undefined), empty)
  assertEquals(projectionColumnValues({}), empty)
  assertEquals(projectionColumnValues({ daemonBuild: { commit: 'abc', builtAt: 'not a date' } }), {
    ...empty,
    daemonCommit: 'abc',
  })
})
