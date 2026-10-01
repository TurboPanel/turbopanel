import { assertEquals } from '@std/assert'
import {
  differsFromInstalled,
  EMPTY_UNIT_TARGET,
  isDowngrade,
  isOnTarget,
  uiBehindTarget,
  unitTarget,
  updateAvailableFor,
  type UpgradeTarget,
} from './target.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const target: UpgradeTarget = {
  daemon: {
    version: '0.1.1',
    commit: 'aaa',
    buildId: 'b1',
    builtAt: 't',
    manifestUrl: 'u',
  },
  instance: {
    version: '0.1.1',
    commit: 'bbb',
    buildId: 'b2',
    builtAt: 't',
    manifestUrl: 'u',
  },
  ui: null,
}

test('unitTarget reads the daemon / instance pin and tolerates null', () => {
  assertEquals(unitTarget(target, 'daemon')?.commit, 'aaa')
  assertEquals(unitTarget(target, 'instance')?.commit, 'bbb')
  assertEquals(unitTarget(null, 'daemon'), null)
  assertEquals(unitTarget({ daemon: null, instance: null, ui: null }, 'daemon'), null)
})

test('isOnTarget only when both commits are known and equal', () => {
  assertEquals(isOnTarget({ version: null, commit: 'aaa' }, target.daemon), true)
  assertEquals(isOnTarget({ version: null, commit: 'zzz' }, target.daemon), false)
  assertEquals(isOnTarget({ version: null, commit: null }, target.daemon), false)
  assertEquals(isOnTarget({ version: null, commit: 'aaa' }, EMPTY_UNIT_TARGET), false)
  assertEquals(isOnTarget(null, target.daemon), false)
  assertEquals(isOnTarget(null, null), false)
})

test('differsFromInstalled: unknown target never differs; unknown install does', () => {
  assertEquals(differsFromInstalled({ version: null, commit: 'aaa' }, target.daemon), false)
  assertEquals(differsFromInstalled({ version: null, commit: 'old' }, target.daemon), true)
  // Host with no known commit but a resolved target still needs the install.
  assertEquals(differsFromInstalled({ version: null, commit: null }, target.daemon), true)
  // Unknown target: nothing to roll out.
  assertEquals(differsFromInstalled({ version: null, commit: 'old' }, EMPTY_UNIT_TARGET), false)
  assertEquals(differsFromInstalled(null, null), false)
})

test('isDowngrade: an older base version is a downgrade', () => {
  assertEquals(isDowngrade('0.2.0', '0.1.1'), true)
  assertEquals(isDowngrade('0.1.2', '0.1.1-canary.20260927-182044-86d492d'), true)
  assertEquals(isDowngrade('0.1.1', '0.1.2-canary.20260927-182044-86d492d'), false)
})

test('isDowngrade: a channel label on the same base is not a downgrade', () => {
  // Binaries report their plain base version whichever channel they were
  // published on; only the manifest carries the label. Plain semver would
  // rank every canary build below the installed 0.1.1 and refuse it — which
  // stopped the testing fleet from ever taking a canary daemon.
  assertEquals(isDowngrade('0.1.1', '0.1.1-canary.20260927-182044-86d492d'), false)
  assertEquals(isDowngrade('v0.1.1', '0.1.1-rc.1'), false)
  assertEquals(isDowngrade('0.1.1-canary.9', '0.1.1-canary.10'), false)
})

test('isDowngrade: on the same base, known build times decide', () => {
  const newer = '2026-09-27T18:20:44Z'
  const older = '2026-09-27T00:14:32Z'
  const canary = '0.1.1-canary.20260927-001432-ee6236a'
  assertEquals(
    isDowngrade('0.1.1', canary, { installedBuiltAt: newer, targetBuiltAt: older }),
    true
  )
  assertEquals(
    isDowngrade('0.1.1', canary, { installedBuiltAt: older, targetBuiltAt: newer }),
    false
  )
  // One side unknown or unparsable: not a downgrade.
  assertEquals(isDowngrade('0.1.1', canary, { installedBuiltAt: newer }), false)
  assertEquals(
    isDowngrade('0.1.1', canary, { installedBuiltAt: 'yesterday', targetBuiltAt: older }),
    false
  )
  // Build times never override the base version.
  assertEquals(
    isDowngrade('0.1.2', '0.1.1', { installedBuiltAt: older, targetBuiltAt: newer }),
    true
  )
})

test('isDowngrade: equal, unknown and unparsable versions are not downgrades', () => {
  assertEquals(isDowngrade('0.1.1', '0.1.1'), false)
  assertEquals(isDowngrade('0.1.0', '0.1.1'), false)
  assertEquals(isDowngrade(null, '0.1.1'), false)
  assertEquals(isDowngrade('trunk-build', '0.1.1'), false)
  assertEquals(isDowngrade('0.2.0', null), false)
})

test("updateAvailableFor is the server's one update-available rule", () => {
  const installed = { version: '0.1.1', commit: 'aaa' }
  // A new commit at the same or a higher version is an update.
  assertEquals(updateAvailableFor(installed, { version: '0.1.1', commit: 'bbb' }), true)
  assertEquals(updateAvailableFor(installed, { version: '0.1.2', commit: 'bbb' }), true)
  // The same commit is not, whatever the version label says.
  assertEquals(updateAvailableFor(installed, { version: '0.1.2', commit: 'aaa' }), false)
  // An older version on a different commit would downgrade: not offered.
  assertEquals(updateAvailableFor(installed, { version: '0.1.0', commit: 'bbb' }), false)
  // No target, or a target without a commit, offers nothing.
  assertEquals(updateAvailableFor(installed, null), false)
  assertEquals(updateAvailableFor(installed, { version: '0.1.2', commit: null }), false)
  // A host that reports no commit needs the install.
  assertEquals(updateAvailableFor({ version: null, commit: null }, { commit: 'bbb' }), true)
  // A canary build of the installed base is offered (the testing fleet case).
  assertEquals(
    updateAvailableFor(installed, {
      version: '0.1.1-canary.20260927-182044-86d492d',
      commit: 'bbb',
    }),
    true
  )
  // ...unless the host's own build is known to be newer.
  assertEquals(
    updateAvailableFor(
      { ...installed, builtAt: '2026-09-28T00:00:00Z' },
      {
        version: '0.1.1-canary.20260927-182044-86d492d',
        commit: 'bbb',
        builtAt: '2026-09-27T18:20:44Z',
      }
    ),
    false
  )
})

test('uiBehindTarget: only when both commits are known and differ', () => {
  const ui = { commit: 'abcdef1234567890' }
  assertEquals(uiBehindTarget(ui, '0000000'), true)
  assertEquals(uiBehindTarget(ui, 'abcdef1'), false)
  assertEquals(uiBehindTarget(ui, 'abcdef1234567890'), false)
  assertEquals(uiBehindTarget(ui, null), false)
  assertEquals(uiBehindTarget(ui, 'unknown'), false)
  assertEquals(uiBehindTarget(null, '0000000'), false)
  assertEquals(uiBehindTarget({ commit: null }, '0000000'), false)
  assertEquals(uiBehindTarget({ commit: 'unknown' }, '0000000'), false)
})
