import { assertEquals } from '@std/assert'
import {
  BUILD_INFO,
  healthPayload,
  INSTANCE_LICENSE,
  resolveInstanceRevision,
  sourceUrlForCommit,
} from './build-info.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('sourceUrlForCommit points at the exact git tree', () => {
  assertEquals(
    sourceUrlForCommit('abcdef012345'),
    'https://github.com/TurboPanel/turbopanel/tree/abcdef012345',
  )
  assertEquals(sourceUrlForCommit('unknown'), 'https://github.com/TurboPanel/turbopanel')
})

test('resolveInstanceRevision prefers TURBOPANEL_REVISION over the stamp', () => {
  assertEquals(resolveInstanceRevision({ TURBOPANEL_REVISION: 'abc1234' }).commit, 'abc1234')
  assertEquals(
    resolveInstanceRevision({}, { commit: 'stamped', sourceUrl: '' }).commit,
    'stamped',
  )
  assertEquals(resolveInstanceRevision({}).commit, 'unknown')
})

test('healthPayload always reports AGPL and a revision', () => {
  const payload = healthPayload({ TURBOPANEL_REVISION: 'deadbeef' })
  assertEquals(payload.ok, true)
  assertEquals(payload.license, INSTANCE_LICENSE)
  assertEquals(payload.revision.commit, 'deadbeef')
  assertEquals(BUILD_INFO.commit, '')
})
