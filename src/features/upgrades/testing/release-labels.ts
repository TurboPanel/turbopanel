/**
 * Real release labels, the way each side of the upgrade seam spells them.
 *
 * A binary reports its plain base version (`0.1.1`) whichever channel it was
 * published on; the canary / rc manifests carry the label
 * (`0.1.1-canary.<yyyymmdd-hhmmss-sha7>`, `0.1.1-rc.1`), and git tags add a
 * leading `v`. Plain semver ranks every canary of the installed base below
 * the release, which on 2026-09-27 refused every canary rollout as a
 * downgrade. Suites that compare builds take their inputs from here so the
 * next comparison is tested against the shapes production actually sends.
 */

export type ReleaseBuild = {
  version: string
  commit: string
  builtAt: string | null
}

/** One canary build id: `<yyyymmdd>-<hhmmss>-<sha7>`. */
export function canaryBuildId(builtAt: string, commit: string): string {
  const compact = builtAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${compact}-${commit.slice(0, 7)}`
}

/** A canary build of `base` built at `builtAt` from `commit`. */
export function canaryBuild(base: string, builtAt: string, commit: string): ReleaseBuild {
  return { version: `${base}-canary.${canaryBuildId(builtAt, commit)}`, commit, builtAt }
}

/** The installed daemons on testing before the 2026-09-27 rollout. */
export const INSTALLED_EARLY: ReleaseBuild = {
  version: '0.1.1',
  commit: 'ee6236a0000000000000000000000000000000000',
  builtAt: '2026-09-27T00:14:32Z',
}

/** The canary that finally rolled out on 2026-09-27. */
export const CANARY_LATE: ReleaseBuild = canaryBuild(
  '0.1.1',
  '2026-09-27T19:24:10Z',
  '1ade0373e28a5463aeec98db382d4f9ef34d4c67'
)

/** A canary of the installed base built before {@link INSTALLED_EARLY} (a rollback target). */
export const CANARY_EARLIER: ReleaseBuild = canaryBuild(
  '0.1.1',
  '2026-09-26T16:10:20Z',
  'b613d3d0000000000000000000000000000000000'
)

export const RC_ONE: ReleaseBuild = {
  version: '0.1.1-rc.1',
  commit: 'b12db09900000000000000000000000000000000',
  builtAt: null,
}
export const RELEASE: ReleaseBuild = {
  version: '0.1.1',
  commit: 'b12db09900000000000000000000000000000000',
  builtAt: null,
}
export const TAG_FORM = 'v0.1.1'
export const NEXT_BASE_CANARY: ReleaseBuild = canaryBuild(
  '0.1.2',
  '2026-10-01T09:00:00Z',
  'c0ffee0000000000000000000000000000000000'
)
export const OLDER_BASE: ReleaseBuild = {
  version: '0.1.0',
  commit: 'a1b2c3d000000000000000000000000000000000',
  builtAt: '2026-09-19T12:00:00Z',
}

/**
 * The exact-build manifest shape the daemon's `isExactBuildManifestUrl`
 * (turbopaneld `src/update/urls.ts`) accepts: a canary per-build copy or a
 * `v<version>` tag's manifest. A floating pointer (`canary/manifest.json`)
 * must never be sent as a pin — the daemon treats it as "re-resolve".
 */
export const EXACT_BUILD_MANIFEST_URL =
  /^https:\/\/github\.com\/TurboPanel\/(turbopaneld|turbopanel|ui)\/releases\/download\/(canary\/manifest-\d[0-9A-Za-z._+-]*\.json|v\d[0-9A-Za-z._+-]*\/manifest\.json)$/
