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
import { compareSemver, parseSemver } from "../../lib/version-wire.ts";
import type { UpgradeStepUnit } from "./vocabulary.ts";

/** One resolved build for one unit, mirroring an `UpdateManifestTarget`. */
export type UpgradeUnitTarget = {
  version: string | null;
  commit: string | null;
  buildId: string | null;
  builtAt: string | null;
  /** `pinnedChannelManifestUrl`, or the channel's built-in URL for trunk. */
  manifestUrl: string | null;
};

/** Pins for every unit an upgrade run may install. */
export type UpgradeTarget = {
  daemon: UpgradeUnitTarget | null;
  instance: UpgradeUnitTarget | null;
  ui: UpgradeUnitTarget | null;
};

/** What a host currently runs for one unit. */
export type InstalledBuild = {
  version: string | null;
  commit: string | null;
};

export const EMPTY_UNIT_TARGET: UpgradeUnitTarget = {
  version: null,
  commit: null,
  buildId: null,
  builtAt: null,
  manifestUrl: null,
};

/** The pin for a step's unit (`daemon` / `instance`); `ui` is not a step. */
export function unitTarget(
  target: UpgradeTarget | null | undefined,
  unit: UpgradeStepUnit,
): UpgradeUnitTarget | null {
  return target?.[unit] ?? null;
}

/**
 * True only when both commits are known and equal. An unknown target commit
 * is never "on target" — the fleet gate must not open on a target it could
 * not resolve.
 */
export function isOnTarget(
  installed: InstalledBuild | null | undefined,
  target: UpgradeUnitTarget | null | undefined,
): boolean {
  const want = target?.commit;
  const have = installed?.commit;
  return typeof want === "string" && want.length > 0 && have === want;
}

/**
 * True when the target names a commit the host is not already running. A host
 * with no known commit but a resolved target differs (it needs the install);
 * an unknown target never differs (nothing to roll out).
 */
/** A unit pin the installer can fetch: a commit and a manifest URL. */
export function isPinnedManifest(
  target: UpgradeUnitTarget | null | undefined,
): boolean {
  const commit = target?.commit?.trim() ?? "";
  const url = target?.manifestUrl?.trim() ?? "";
  return commit.length > 0 && url.length > 0;
}

export function differsFromInstalled(
  installed: InstalledBuild | null | undefined,
  target: UpgradeUnitTarget | null | undefined,
): boolean {
  const want = target?.commit;
  if (typeof want !== "string" || want.length === 0) return false;
  return installed?.commit !== want;
}

/**
 * True when installing `target` would move a host to an older version. Equal
 * versions (a trunk rebuild on a new commit) and unparsable ones are not
 * downgrades. A managed run never downgrades; going back is the explicit,
 * logged rollback path (`controlPlaneRollbackCommand`).
 */
export function isDowngrade(
  installedVersion: string | null | undefined,
  targetVersion: string | null | undefined,
): boolean {
  const have = parseSemver(installedVersion);
  const want = parseSemver(targetVersion);
  if (!have || !want) return false;
  return compareSemver(want, have) < 0;
}
