import { assertEquals } from '@std/assert'
import type { UpdateManifestTarget } from '../features/update/manifest.ts'
import { INSTANCE_VERSION } from './version.ts'
import { buildLabelFromManifest, resolveHealthPayload } from './running-build.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DEPLOYED = '11cf52d24fbcad8c6972ed43fbdfc8ea5b32b6b3'
const OTHER = 'f0eefd4ba6aa05d5d56264749e37c999c2e9eb37'

function manifest(commit: string, version: string | undefined): UpdateManifestTarget {
  return {
    commit,
    version,
    buildId: '20261027-153053-11cf52d',
    builtAt: '2026-10-27T15:30:53Z',
    channel: 'canary',
    manifestUrl: 'https://example.test/manifest.json',
  }
}

function hostedEnv(environment: string, channel: string, commit = DEPLOYED) {
  return {
    TURBOPANEL_ENVIRONMENT: environment,
    TURBOPANEL_UPDATE_CHANNEL: channel,
    TURBOPANEL_REVISION: commit,
  }
}

test('buildLabelFromManifest names the build only when its commit is the deployed one', () => {
  assertEquals(
    buildLabelFromManifest(manifest(DEPLOYED, '0.1.21-canary.3'), DEPLOYED),
    '0.1.21-canary.3'
  )
  assertEquals(
    buildLabelFromManifest(manifest(DEPLOYED.toUpperCase(), '0.1.21-rc.2'), DEPLOYED),
    '0.1.21-rc.2'
  )
  assertEquals(buildLabelFromManifest(manifest(OTHER, '0.1.21-canary.3'), DEPLOYED), null)
  assertEquals(buildLabelFromManifest(manifest(DEPLOYED, undefined), DEPLOYED), null)
  assertEquals(buildLabelFromManifest(manifest(DEPLOYED, 'not a version'), DEPLOYED), null)
  assertEquals(buildLabelFromManifest(manifest(DEPLOYED, '0.1.21'), 'unknown'), null)
  assertEquals(buildLabelFromManifest(null, DEPLOYED), null)
})

test('resolveHealthPayload labels a hosted build from the channel manifest of its commit', async () => {
  const asked: string[] = []
  const payload = await resolveHealthPayload(hostedEnv('testing', 'canary'), (channel, kind) => {
    asked.push(`${channel}/${kind}`)
    return Promise.resolve(manifest(DEPLOYED, '0.1.21-canary.3'))
  })
  assertEquals(payload.build, '0.1.21-canary.3')
  assertEquals(payload.version, INSTANCE_VERSION)
  assertEquals(asked, ['canary/instance'])
})

test('resolveHealthPayload keeps the plain version when the channel build is another commit', async () => {
  const payload = await resolveHealthPayload(hostedEnv('testing', 'canary'), () =>
    Promise.resolve(manifest(OTHER, '0.1.21-canary.3'))
  )
  assertEquals(payload.build, null)
})

test('resolveHealthPayload never fetches off a hosted environment or with an installed label', async () => {
  const lookup = () => Promise.reject(new Error('must not fetch'))
  const selfHosted = await resolveHealthPayload(
    { TURBOPANEL_UPDATE_CHANNEL: 'canary', TURBOPANEL_REVISION: DEPLOYED },
    lookup
  )
  assertEquals(selfHosted.build, null)
  const installed = await resolveHealthPayload(
    { ...hostedEnv('testing', 'canary'), TURBOPANEL_BUILD_LABEL: '0.1.21-canary.2' },
    lookup
  )
  assertEquals(installed.build, '0.1.21-canary.2')
  const trunk = await resolveHealthPayload(hostedEnv('testing', 'trunk'), lookup)
  assertEquals(trunk.build, null)
  const noCommit = await resolveHealthPayload(hostedEnv('live', 'release', 'unknown'), lookup)
  assertEquals(noCommit.build, null)
})

test('resolveHealthPayload answers without a label when the manifest read fails or is slow', async () => {
  const failed = await resolveHealthPayload(hostedEnv('staging', 'rc'), () =>
    Promise.reject(new Error('offline'))
  )
  assertEquals(failed.build, null)
  const slow = await resolveHealthPayload(
    hostedEnv('live', 'release'),
    () => new Promise(() => {}),
    5
  )
  assertEquals(slow.build, null)
})
