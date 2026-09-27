/**
 * The `upgrade.target` jsonb shape and the pure "on target?" predicates the
 * planner and the state machine share.
 *
 * One pin per releasable unit. `daemon` and `instance` become `upgradestep`
 * rows; `ui` rides the same control-plane install as `instance` (there is no
 * separate UI step, so it is a pin only). Every field is nullable — the tick
 * writes it once it has resolved the channel manifests (`resolveUpdateManifest`
 * + `pinnedChannelManifestUrl`).
 *
 * Pure and host-free: no DB, no clock, no manifest fetch. The orchestrator
 * resolves manifests and hands the resolved pins in here.
 */
import { compareSemver, parseSemver } from '../../lib/version-wire.ts'
import type { UpgradeStepUnit } from './vocabulary.ts'

/** One resolved build for one unit, mirroring an `UpdateManifestTarget`. */
export type UpgradeUnitTarget = {
  version: string | null
  commit: string | null
  buildId: string | null
  builtAt: string | null
  /** `pinnedChannelManifestUrl`, or the channel's built-in URL for trunk. */
  manifestUrl: string | null
}

/** Pins for every unit an upgrade run may install. */
export type UpgradeTarget = {
  daemon: UpgradeUnitTarget | null
  instance: UpgradeUnitTarget | null
  ui: UpgradeUnitTarget | null
}

/** What a host currently runs for one unit. */
export type InstalledBuild = {
  version: string | null
  commit: string | null
  /** When the installed build was made, if the host reports it. */
  builtAt?: string | null
}

export const EMPTY_UNIT_TARGET: UpgradeUnitTarget = {
  version: null,
  commit: null,
  buildId: null,
  builtAt: null,
  manifestUrl: null,
}

/** The pin for a step's unit (`daemon` / `instance`); `ui` is not a step. */
export function unitTarget(
  target: UpgradeTarget | null | undefined,
  unit: UpgradeStepUnit
): UpgradeUnitTarget | null {
  return target?.[unit] ?? null
}

/**
 * True only when both commits are known and equal. An unknown target commit
 * is never "on target" — the fleet gate must not open on a target it could
 * not resolve.
 */
export function isOnTarget(
  installed: InstalledBuild | null | undefined,
  target: UpgradeUnitTarget | null | undefined
): boolean {
  const want = target?.commit
  const have = installed?.commit
  return typeof want === 'string' && want.length > 0 && have === want
}

/**
 * True when the target names a commit the host is not already running. A host
 * with no known commit but a resolved target differs (it needs the install);
 * an unknown target never differs (nothing to roll out).
 */
/** A unit pin the installer can fetch: a commit and a manifest URL. */
export function isPinnedManifest(target: UpgradeUnitTarget | null | undefined): boolean {
  const commit = target?.commit?.trim() ?? ''
  const url = target?.manifestUrl?.trim() ?? ''
  return commit.length > 0 && url.length > 0
}

export function differsFromInstalled(
  installed: InstalledBuild | null | undefined,
  target: UpgradeUnitTarget | null | undefined
): boolean {
  const want = target?.commit
  if (typeof want !== 'string' || want.length === 0) return false
  return installed?.commit !== want
}

/**
 * The server's one rule for "an update is available": the target names a
 * commit the host is not running and installing it would not downgrade. Every
 * client reads this answer; none compares versions or commits itself.
 */
export function updateAvailableFor(
  installed: InstalledBuild | null | undefined,
  target:
    { commit?: string | null; version?: string | null; builtAt?: string | null } | null | undefined
): boolean {
  if (!target) return false
  const pin = { commit: target.commit ?? null, version: target.version ?? null }
  if (!differsFromInstalled(installed, { ...EMPTY_UNIT_TARGET, ...pin })) {
    return false
  }
  return !isDowngrade(installed?.version, pin.version, {
    installedBuiltAt: installed?.builtAt,
    targetBuiltAt: target.builtAt,
  })
}

/**
 * True when installing `target` would move a host to an older version. A
 * managed run never downgrades; going back is the explicit, logged rollback
 * path (`controlPlaneRollbackCommand`).
 *
 * Only the base version (`major.minor.patch`) orders builds across releases.
 * Within one base the pre-release label says nothing about age: a binary
 * reports its plain base version (`0.1.1`) whichever channel it was published
 * on, while the canary / rc manifest carries the label (`0.1.1-canary.<id>`,
 * `0.1.1-rc.1`) — so plain semver would rank every canary build of the
 * installed base as older and refuse it. Same base: the build times decide
 * when both are known; otherwise it is not a downgrade (like equal versions,
 * a rebuild on a new commit). Unparsable versions are not downgrades.
 */
export function isDowngrade(
  installedVersion: string | null | undefined,
  targetVersion: string | null | undefined,
  builds: {
    installedBuiltAt?: string | null
    targetBuiltAt?: string | null
  } = {}
): boolean {
  const have = parseSemver(installedVersion)
  const want = parseSemver(targetVersion)
  if (!have || !want) return false
  const base = compareSemver({ ...want, prerelease: [] }, { ...have, prerelease: [] })
  if (base !== 0) return base < 0
  const installedAt = Date.parse(builds.installedBuiltAt ?? '')
  const targetAt = Date.parse(builds.targetBuiltAt ?? '')
  if (Number.isFinite(installedAt) && Number.isFinite(targetAt)) {
    return targetAt < installedAt
  }
  return false
}
