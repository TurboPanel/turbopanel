import { assertEquals } from '@std/assert'
import { INSTANCE_VERSION } from './version.ts'
import {
  BUILD_INFO,
  healthPayload,
  INSTANCE_LICENSE,
  resolveBuildLabel,
  resolveDeploymentEnvironment,
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
    'https://github.com/TurboPanel/turbopanel/tree/abcdef012345'
  )
  assertEquals(sourceUrlForCommit('unknown'), 'https://github.com/TurboPanel/turbopanel')
})

test('resolveInstanceRevision prefers TURBOPANEL_REVISION over the stamp', () => {
  assertEquals(resolveInstanceRevision({ TURBOPANEL_REVISION: 'abc1234' }).commit, 'abc1234')
  assertEquals(resolveInstanceRevision({}, { commit: 'stamped', sourceUrl: '' }).commit, 'stamped')
  assertEquals(resolveInstanceRevision({}).commit, 'unknown')
})

test('healthPayload always reports AGPL and a revision', () => {
  const payload = healthPayload({ TURBOPANEL_REVISION: 'deadbeef' })
  assertEquals(payload.ok, true)
  assertEquals(payload.license, INSTANCE_LICENSE)
  assertEquals(payload.version, INSTANCE_VERSION)
  assertEquals(payload.revision.commit, 'deadbeef')
  assertEquals(BUILD_INFO.commit, '')
})

test('healthPayload reports channel, build label and deployment environment', () => {
  const payload = healthPayload({
    TURBOPANEL_UPDATE_CHANNEL: 'canary',
    TURBOPANEL_BUILD_LABEL: '0.1.1-canary.20260926-192741-3754712',
    TURBOPANEL_ENVIRONMENT: 'testing',
  })
  assertEquals(payload.channel, 'canary')
  assertEquals(payload.build, '0.1.1-canary.20260926-192741-3754712')
  assertEquals(payload.environment, 'testing')

  const bare = healthPayload({})
  assertEquals(bare.channel, 'trunk')
  assertEquals(bare.build, null)
  assertEquals(bare.environment, null)
})

test('resolveBuildLabel accepts semver labels only', () => {
  assertEquals(resolveBuildLabel({ TURBOPANEL_BUILD_LABEL: ' 0.1.1-rc.1 ' }), '0.1.1-rc.1')
  assertEquals(resolveBuildLabel({ TURBOPANEL_BUILD_LABEL: '0.1.1' }), '0.1.1')
  assertEquals(resolveBuildLabel({ TURBOPANEL_BUILD_LABEL: 'canary' }), null)
  assertEquals(resolveBuildLabel({ TURBOPANEL_BUILD_LABEL: '<script>' }), null)
  assertEquals(resolveBuildLabel({ TURBOPANEL_BUILD_LABEL: `0.1.1-${'x'.repeat(200)}` }), null)
  assertEquals(resolveBuildLabel(undefined), null)
})

test('resolveDeploymentEnvironment names only the known deployments', () => {
  assertEquals(resolveDeploymentEnvironment({ TURBOPANEL_ENVIRONMENT: 'Live' }), 'live')
  assertEquals(resolveDeploymentEnvironment({ TURBOPANEL_ENVIRONMENT: 'staging' }), 'staging')
  assertEquals(resolveDeploymentEnvironment({ TURBOPANEL_ENVIRONMENT: 'production' }), null)
  assertEquals(resolveDeploymentEnvironment({}), null)
})
