import { assertEquals, assertMatch, assertNotMatch } from '@std/assert'
import type { ReleaseArtifactKind, UpdateChannel } from '../../contracts/update-channel.ts'
import { isDowngrade, updateAvailableFor } from './target.ts'
import { unitTargetFromManifest } from './target-resolve.ts'
import {
  CANARY_EARLIER,
  CANARY_LATE,
  canaryBuildId,
  EXACT_BUILD_MANIFEST_URL,
  INSTALLED_EARLY,
  NEXT_BASE_CANARY,
  OLDER_BASE,
  RC_ONE,
  RELEASE,
  type ReleaseBuild,
  TAG_FORM,
} from './testing/release-labels.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function downgrade(installed: ReleaseBuild, target: ReleaseBuild): boolean {
  return isDowngrade(installed.version, target.version, {
    installedBuiltAt: installed.builtAt,
    targetBuiltAt: target.builtAt,
  })
}

test('fixture: canary build ids match the published shape', () => {
  assertEquals(canaryBuildId('2026-09-27T19:24:10Z', CANARY_LATE.commit), '20260927-192410-1ade037')
  assertEquals(CANARY_LATE.version, '0.1.1-canary.20260927-192410-1ade037')
})

test('isDowngrade over the labels production actually compares', () => {
  const cases: Array<[string, ReleaseBuild, ReleaseBuild, boolean]> = [
    ['later canary of the installed base', INSTALLED_EARLY, CANARY_LATE, false],
    ['earlier canary of the installed base', INSTALLED_EARLY, CANARY_EARLIER, true],
    ['rc of the installed base, no build times', INSTALLED_EARLY, RC_ONE, false],
    ['release of the installed base, no build times', INSTALLED_EARLY, RELEASE, false],
    ['canary of the next base', INSTALLED_EARLY, NEXT_BASE_CANARY, false],
    ['older base', INSTALLED_EARLY, OLDER_BASE, true],
    ['canary of an older base than installed', NEXT_BASE_CANARY, CANARY_LATE, true],
    ['from an older base to a canary', OLDER_BASE, CANARY_LATE, false],
  ]
  for (const [label, installed, target, expected] of cases) {
    assertEquals(downgrade(installed, target), expected, label)
  }
})

test('a v-prefixed tag spells the same version as the plain base', () => {
  assertEquals(isDowngrade(TAG_FORM, RELEASE.version), false)
  assertEquals(isDowngrade(RELEASE.version, TAG_FORM), false)
  assertEquals(isDowngrade(TAG_FORM, OLDER_BASE.version), true)
})

test('updateAvailableFor across a mixed fleet and one canary target', () => {
  const fleet: Array<[string, ReleaseBuild, boolean]> = [
    ['behind on the same base', INSTALLED_EARLY, true],
    ['already on the target commit', CANARY_LATE, false],
    [
      'newer build of the same base',
      {
        version: '0.1.1',
        commit: 'f00d000000000000000000000000000000000000',
        builtAt: '2026-09-28T00:00:00Z',
      },
      false,
    ],
    ['older base', OLDER_BASE, true],
    ['ahead on the next base', NEXT_BASE_CANARY, false],
    ['unknown build time on the same base', { ...INSTALLED_EARLY, builtAt: null }, true],
  ]
  for (const [label, installed, expected] of fleet) {
    assertEquals(
      updateAvailableFor(
        { version: installed.version, commit: installed.commit, builtAt: installed.builtAt },
        CANARY_LATE
      ),
      expected,
      label
    )
  }
})

test('every pinned unit target names one exact build the daemon accepts as a pin', () => {
  const kinds: ReleaseArtifactKind[] = ['daemon', 'instance', 'ui']
  const byChannel: Array<[UpdateChannel, ReleaseBuild]> = [
    ['canary', CANARY_LATE],
    ['rc', RC_ONE],
    ['release', RELEASE],
  ]
  for (const kind of kinds) {
    for (const [channel, build] of byChannel) {
      const target = unitTargetFromManifest(kind, channel, {
        version: build.version,
        commit: build.commit,
        buildId: 'build',
        builtAt: build.builtAt ?? '2026-09-27T00:00:00Z',
        channel,
        manifestUrl: `https://github.com/TurboPanel/x/releases/download/${channel}/manifest.json`,
      })
      assertMatch(target?.manifestUrl ?? '', EXACT_BUILD_MANIFEST_URL, `${kind} ${channel}`)
    }
  }
})

test('the rolling canary pointer is not an exact build', () => {
  assertNotMatch(
    'https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest.json',
    EXACT_BUILD_MANIFEST_URL
  )
})
