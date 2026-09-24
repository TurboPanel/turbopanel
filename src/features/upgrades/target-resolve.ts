/**
 * Resolve the channel's daemon / instance / UI manifests into an
 * {@link UpgradeTarget}, pin each unit with `pinnedChannelManifestUrl`, and
 * cache the latest available build in a setting row.
 *
 * Runs on both runtimes (no Deno-only API). Manifest resolution is injectable
 * so the composition is host-free-testable; the default reads through the
 * shared `resolveUpdateManifest` cache (daemons never poll GitHub — the dev
 * overlay provider still wins for the daemon kind).
 */
import { eq } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { setting } from "../../db/schema.ts";
import {
  builtinChannelManifestUrl,
  pinnedChannelManifestUrl,
  type ReleaseArtifactKind,
  type UpdateChannel,
} from "../../contracts/update-channel.ts";
import {
  resolveUpdateManifest,
  type UpdateManifestTarget,
} from "../update/manifest.ts";
import {
  isPinnedManifest,
  type UpgradeTarget,
  type UpgradeUnitTarget,
} from "./target.ts";
import { unitsForPlannedRun, type UpgradeRuntime } from "./planner.ts";

export const LATEST_BUILD_SETTINGS_KEY = "UPGRADE_LATEST_BUILD";

export type ManifestResolver = (
  kind: ReleaseArtifactKind,
) => Promise<UpdateManifestTarget | null>;

/**
 * True when the channel publishes a control-plane (instance) package. `trunk`
 * and the reserved `edge` do not, so a self-hosted trunk run skips the
 * `control_plane` phase (`planner.ts`).
 */
export function channelHasInstancePackage(channel: UpdateChannel): boolean {
  return builtinChannelManifestUrl(channel, "instance") !== null;
}

/**
 * One unit's pin. `manifestUrl` is the version-pinned manifest when the channel
 * pins (`canary` / `rc` / `release`), else the channel's built-in URL (the
 * trunk CDN drop) — so an install always fetches the exact build the run
 * recorded, or the floating channel head when there is no pin.
 */
export function unitTargetFromManifest(
  kind: ReleaseArtifactKind,
  channel: UpdateChannel,
  manifest: UpdateManifestTarget | null,
): UpgradeUnitTarget | null {
  if (!manifest) return null;
  const pinned = manifest.version
    ? pinnedChannelManifestUrl(kind, channel, manifest.version)
    : null;
  return {
    version: manifest.version ?? null,
    commit: manifest.commit,
    buildId: manifest.buildId,
    builtAt: manifest.builtAt,
    manifestUrl: pinned ?? manifest.manifestUrl,
  };
}

const PIN_LABEL: Record<"daemon" | "instance" | "ui", string> = {
  daemon: "daemon",
  instance: "instance",
  ui: "UI",
};

/**
 * Blockers for units this run would install without a commit and a manifest
 * URL. An unpinned target is refused before any step is created.
 */
export function pinnedManifestBlockers(
  channel: UpdateChannel,
  target: UpgradeTarget,
  scope: {
    runtime: UpgradeRuntime;
    hasColocated: boolean;
    fleetCount: number;
  },
): string[] {
  const units = unitsForPlannedRun({
    runtime: scope.runtime,
    channelHasInstancePackage: channelHasInstancePackage(channel),
    hasColocated: scope.hasColocated,
    fleetCount: scope.fleetCount,
  });
  const missing: string[] = [];
  for (const unit of units) {
    if (isPinnedManifest(target[unit])) continue;
    missing.push(
      `The ${PIN_LABEL[unit]} manifest is missing or not pinned.`,
    );
  }
  return missing;
}

/** Resolve every unit's pin for `channel`. */
export async function resolveUpgradeTarget(
  channel: UpdateChannel,
  resolve: ManifestResolver = (kind) => resolveUpdateManifest(channel, kind),
): Promise<UpgradeTarget> {
  const [daemon, instance, ui] = await Promise.all([
    resolve("daemon"),
    resolve("instance"),
    resolve("ui"),
  ]);
  return {
    daemon: unitTargetFromManifest("daemon", channel, daemon),
    instance: unitTargetFromManifest("instance", channel, instance),
    ui: unitTargetFromManifest("ui", channel, ui),
  };
}

function isUnitTarget(value: unknown): value is UpgradeUnitTarget | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const optionalString = (key: string): boolean =>
    record[key] === null || typeof record[key] === "string";
  return (
    optionalString("version") &&
    optionalString("commit") &&
    optionalString("buildId") &&
    optionalString("builtAt") &&
    optionalString("manifestUrl")
  );
}

/** True when `value` is a complete {@link UpgradeTarget}. */
export function isUpgradeTarget(value: unknown): value is UpgradeTarget {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isUnitTarget(record.daemon) &&
    isUnitTarget(record.instance) &&
    isUnitTarget(record.ui)
  );
}

/** The latest available build recorded by the tick; null when unset/invalid. */
export async function getLatestAvailableBuild(
  db: Db,
): Promise<UpgradeTarget | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, LATEST_BUILD_SETTINGS_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return isUpgradeTarget(value) ? value : null;
}

/** Persist the latest available build for the status view and auto-start check. */
export async function setLatestAvailableBuild(
  db: Db,
  target: UpgradeTarget,
): Promise<void> {
  await db
    .insert(setting)
    .values({ key: LATEST_BUILD_SETTINGS_KEY, value: target })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value: target, updatedAt: new Date().toISOString() },
    });
}
