/**
 * Canonical managed-engine release catalog.
 *
 * A managed service's user-facing version is an **engine series** (`18`, `9.7`,
 * `12.3`), not an OCI tag. The resolved image is derived from the series plus a
 * base-OS **variant**, so adding or retiring a version happens here rather than
 * in scattered image-string allowlists. `settings.image` stays the persisted
 * source of truth (a plain string in existing rows); series and variant are
 * recovered from it with {@link describeManagedImage}.
 *
 * Mirrors that must be bumped in the same change when this catalog changes:
 * the daemon payload allowlist
 * (`turbopaneld/src/instance/commands/contracts.ts`) and the UI picker
 * (`ui/src/lib/managed-releases.ts`). Each mirror has a test pinning it to the
 * same literal set.
 */

import type { ManagedEngineCode } from './types.ts'

/**
 * How long the upstream project supports this series.
 *
 * `lts` — vendor-designated long-term series (MySQL 9.7 / 8.4, MariaDB LTS).
 * `supported` — actively supported upstream without an LTS label (PostgreSQL
 * majors). `legacy` — still offered but approaching or past upstream EOL;
 * never a default and surfaced with a warning.
 */
export type ManagedEngineLifecycle = 'lts' | 'supported' | 'legacy'

export type ManagedImageVariant = {
  /** Stable identifier (`alpine`, `debian`, `oraclelinux9`, `ubi`). */
  id: string
  label: string
  /** Fully-qualified image reference for this series + variant. */
  image: string
}

export type ManagedEngineRelease = {
  engine: ManagedEngineCode
  /** Upstream version series — the operator-facing "version". */
  series: string
  lifecycle: ManagedEngineLifecycle
  /** Exactly one release per engine is the default for new clusters. */
  isDefault: boolean
  /**
   * This series has been validated end-to-end (create, replicate, promote,
   * backup/restore) against the daemon's engine handlers.
   *
   * Only a tested series is creatable: {@link managedCreatableReleasesForEngine}
   * and the derived image allowlists filter on it, so an untested series is
   * refused by the settings parser, the `managed.apply` payload parser, the
   * daemon mirror, and the UI picker alike. Untested entries stay in
   * {@link MANAGED_ENGINE_RELEASES} only so {@link describeManagedImage} can
   * still name a row that was written while the series was offered.
   */
  tested: boolean
  /** Display order; the first entry is this series' default variant. */
  variants: readonly ManagedImageVariant[]
}

/**
 * Explicit opt-in to untested series.
 *
 * There is deliberately no ambient/env form: an untested series must be
 * enabled by the caller that knows it is safe (today only the catalog's own
 * test suite), never by a stray environment variable on a production control
 * plane.
 */
export type ManagedReleaseGate = {
  /** Include series whose `tested` flag is false. Defaults to `false`. */
  includeUntested?: boolean
}

function isReleaseCreatable(
  release: ManagedEngineRelease,
  gate: ManagedReleaseGate | undefined,
): boolean {
  return release.tested || gate?.includeUntested === true
}

const DEBIAN = 'Debian'

function postgresRelease(
  series: string,
  isDefault = false,
  tested = false,
): ManagedEngineRelease {
  return {
    engine: 'postgres',
    series,
    lifecycle: 'supported',
    isDefault,
    tested,
    variants: [
      {
        id: 'alpine',
        label: 'Alpine',
        image: `docker.io/library/postgres:${series}-alpine`,
      },
      {
        id: 'debian',
        label: DEBIAN,
        image: `docker.io/library/postgres:${series}`,
      },
    ],
  }
}

/**
 * MySQL dropped its Alpine variant after 8.0, so the Docker Official Image's
 * Debian tag is the default and Oracle's own Oracle Linux 9 build is the
 * alternative.
 */
function mysqlRelease(
  series: string,
  isDefault = false,
  tested = false,
): ManagedEngineRelease {
  return {
    engine: 'mysql',
    series,
    lifecycle: 'lts',
    isDefault,
    tested,
    variants: [
      {
        id: 'debian',
        label: DEBIAN,
        image: `docker.io/library/mysql:${series}`,
      },
      {
        id: 'oraclelinux9',
        label: 'Oracle Linux 9',
        image: `docker.io/library/mysql:${series}-oraclelinux9`,
      },
    ],
  }
}

/** MariaDB has never shipped Alpine; UBI is the vendor-published alternative. */
function mariadbRelease(
  series: string,
  isDefault = false,
  tested = false,
): ManagedEngineRelease {
  return {
    engine: 'mariadb',
    series,
    lifecycle: 'lts',
    isDefault,
    tested,
    variants: [
      {
        id: 'debian',
        label: DEBIAN,
        image: `docker.io/library/mariadb:${series}`,
      },
      {
        id: 'ubi',
        label: 'UBI',
        image: `docker.io/library/mariadb:${series}-ubi`,
      },
    ],
  }
}

/**
 * Every series the catalog knows about, newest first per engine.
 *
 * PostgreSQL stops at 15 rather than upstream's oldest supported major (14) to
 * keep the replication/promotion test matrix bounded. MySQL 8.0 is absent
 * because it reached EOL in April 2026 — an EOL series must never be
 * creatable.
 *
 * **Knowing about a series is not offering it.** Only PostgreSQL 18, MySQL 9.7
 * and MariaDB 12.3 carry `tested: true`; every other entry exists so
 * {@link describeManagedImage} can still name an already-persisted image, and
 * is refused everywhere a new image can be chosen. Promote a series by
 * flipping its `tested` argument here **and** in the two mirrors
 * (`turbopaneld/src/instance/commands/contracts.ts`,
 * `ui/src/lib/managed-releases.ts`), never in one place alone.
 */
export const MANAGED_ENGINE_RELEASES: readonly ManagedEngineRelease[] = [
  postgresRelease('18', true, true),
  postgresRelease('17'),
  postgresRelease('16'),
  postgresRelease('15'),
  mysqlRelease('9.7', true, true),
  mysqlRelease('8.4'),
  mariadbRelease('12.3', true, true),
  mariadbRelease('11.8'),
  mariadbRelease('11.4'),
  mariadbRelease('10.11'),
]

/**
 * Every catalogued release for `engine` in display order — **including
 * untested series**. Use it to describe or label an image that already exists;
 * use {@link managedCreatableReleasesForEngine} for anything that can produce a
 * new `settings.image`. Empty when the engine has no catalog yet.
 */
export function managedReleasesForEngine(
  engine: string,
): readonly ManagedEngineRelease[] {
  return MANAGED_ENGINE_RELEASES.filter((release) => release.engine === engine)
}

/**
 * Releases `engine` may be created on, in display order.
 *
 * Tested series only unless `gate.includeUntested` is set. This is the single
 * filter behind the derived image allowlists, the create-time series
 * resolution, and the UI picker — an untested series is never creatable by
 * default.
 */
export function managedCreatableReleasesForEngine(
  engine: string,
  gate?: ManagedReleaseGate,
): readonly ManagedEngineRelease[] {
  return managedReleasesForEngine(engine).filter((release) =>
    isReleaseCreatable(release, gate)
  )
}

/**
 * The default series for `engine`, or `undefined` when the engine has no
 * creatable release. Never returns an untested series without the gate.
 */
export function defaultManagedRelease(
  engine: string,
  gate?: ManagedReleaseGate,
): ManagedEngineRelease | undefined {
  const releases = managedCreatableReleasesForEngine(engine, gate)
  return releases.find((release) => release.isDefault) ?? releases[0]
}

/** Default image (default series, default variant) for `engine`. */
export function defaultManagedImage(
  engine: string,
  gate?: ManagedReleaseGate,
): string | undefined {
  return defaultManagedRelease(engine, gate)?.variants[0]?.image
}

/**
 * Default image for an engine that is required to have a catalog entry — used
 * by the engine specs so `defaultImage` cannot drift from the catalog. Throws
 * on a catalog/spec mismatch, which `releases.test.ts` pins for every engine
 * with a spec.
 */
export function requireDefaultManagedImage(engine: ManagedEngineCode): string {
  const image = defaultManagedImage(engine)
  if (image === undefined) {
    throw new Error(`no managed release catalog entry for engine: ${engine}`)
  }
  return image
}

/**
 * Every image reference `engine` accepts, in display order (default series
 * first). This is the derived form of the old hand-written allowlists, and it
 * covers **tested series only** — an untested series' images are not accepted
 * by the settings parser, the `managed.apply` payload parser, or the daemon.
 *
 * `undefined` (not `[]`) still means "this engine has no curated allowlist";
 * an engine that has a catalog but no tested series returns an empty list,
 * which correctly refuses every image.
 */
export function managedAllowedImagesForEngine(
  engine: string,
  gate?: ManagedReleaseGate,
): readonly string[] | undefined {
  if (managedReleasesForEngine(engine).length === 0) return undefined
  return managedCreatableReleasesForEngine(engine, gate).flatMap((release) =>
    release.variants.map((variant) => variant.image)
  )
}

/**
 * Resolve `series` + optional `variantId` (default variant when omitted) to an
 * image. Untested series resolve to `undefined` without the gate, so create
 * returns `managed_version_unsupported` rather than silently starting one.
 */
export function resolveManagedImage(
  engine: string,
  series: string,
  variantId?: string,
  gate?: ManagedReleaseGate,
): string | undefined {
  const release = managedCreatableReleasesForEngine(engine, gate).find(
    (row) => row.series === series,
  )
  if (!release) return undefined
  if (variantId === undefined) return release.variants[0]?.image
  return release.variants.find((variant) => variant.id === variantId)?.image
}

export type ManagedImageDescriptor = {
  engine: ManagedEngineCode
  series: string
  lifecycle: ManagedEngineLifecycle
  /** False for a series that is catalogued but not creatable — surface a warning. */
  tested: boolean
  variantId: string
}

/**
 * Reverse-lookup an allowlisted image to its catalog identity, so responses can
 * report `engineSeries` / `imageVariant` without persisting a second copy.
 * Returns `undefined` for an image outside the catalog (an engine with no
 * catalog, or a row written before a series was retired). Untested series are
 * described here on purpose — an existing row must still render its version
 * even though the series can no longer be chosen (`tested: false`).
 */
export function describeManagedImage(
  image: string,
): ManagedImageDescriptor | undefined {
  for (const release of MANAGED_ENGINE_RELEASES) {
    for (const variant of release.variants) {
      if (variant.image === image) {
        return {
          engine: release.engine,
          series: release.series,
          lifecycle: release.lifecycle,
          tested: release.tested,
          variantId: variant.id,
        }
      }
    }
  }
  return undefined
}

/**
 * The series two images belong to are the same.
 *
 * Cross-major replication is not a supported topology and an engine will not
 * start on a data directory from another major, so a settings change that moves
 * an existing cluster to a different series must be refused (see
 * `managed_series_immutable`). Variant changes (same series, different base OS)
 * are allowed.
 */
export function isSameManagedSeries(
  previousImage: string | undefined,
  nextImage: string | undefined,
): boolean {
  if (previousImage === undefined || nextImage === undefined) return true
  if (previousImage === nextImage) return true
  const previous = describeManagedImage(previousImage)
  const next = describeManagedImage(nextImage)
  // An uncatalogued image has no comparable series; treat a change as a series
  // change rather than silently allowing it.
  if (!previous || !next) return false
  return previous.engine === next.engine && previous.series === next.series
}
