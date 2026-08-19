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
  /** Display order; the first entry is this series' default variant. */
  variants: readonly ManagedImageVariant[]
}

const DEBIAN = 'Debian'

function postgresRelease(
  series: string,
  isDefault = false,
): ManagedEngineRelease {
  return {
    engine: 'postgres',
    series,
    lifecycle: 'supported',
    isDefault,
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
function mysqlRelease(series: string, isDefault = false): ManagedEngineRelease {
  return {
    engine: 'mysql',
    series,
    lifecycle: 'lts',
    isDefault,
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
): ManagedEngineRelease {
  return {
    engine: 'mariadb',
    series,
    lifecycle: 'lts',
    isDefault,
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
 * Supported series for new clusters, newest first per engine.
 *
 * PostgreSQL stops at 15 rather than upstream's oldest supported major (14) to
 * keep the replication/promotion test matrix bounded. MySQL 8.0 is absent
 * because it reached EOL in April 2026 — an EOL series must never be
 * creatable.
 */
export const MANAGED_ENGINE_RELEASES: readonly ManagedEngineRelease[] = [
  postgresRelease('18', true),
  postgresRelease('17'),
  postgresRelease('16'),
  postgresRelease('15'),
  mysqlRelease('9.7', true),
  mysqlRelease('8.4'),
  mariadbRelease('12.3', true),
  mariadbRelease('11.8'),
  mariadbRelease('11.4'),
  mariadbRelease('10.11'),
]

/** Releases for `engine` in display order; empty when the engine has no catalog yet. */
export function managedReleasesForEngine(
  engine: string,
): readonly ManagedEngineRelease[] {
  return MANAGED_ENGINE_RELEASES.filter((release) => release.engine === engine)
}

/** The default series for `engine`, or `undefined` when the engine has no catalog. */
export function defaultManagedRelease(
  engine: string,
): ManagedEngineRelease | undefined {
  const releases = managedReleasesForEngine(engine)
  return releases.find((release) => release.isDefault) ?? releases[0]
}

/** Default image (default series, default variant) for `engine`. */
export function defaultManagedImage(engine: string): string | undefined {
  return defaultManagedRelease(engine)?.variants[0]?.image
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
 * first). This is the derived form of the old hand-written allowlists.
 */
export function managedAllowedImagesForEngine(
  engine: string,
): readonly string[] | undefined {
  const releases = managedReleasesForEngine(engine)
  if (releases.length === 0) return undefined
  return releases.flatMap((release) => release.variants.map((variant) => variant.image))
}

/** Resolve `series` + optional `variantId` (default variant when omitted) to an image. */
export function resolveManagedImage(
  engine: string,
  series: string,
  variantId?: string,
): string | undefined {
  const release = managedReleasesForEngine(engine).find(
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
  variantId: string
}

/**
 * Reverse-lookup an allowlisted image to its catalog identity, so responses can
 * report `engineSeries` / `imageVariant` without persisting a second copy.
 * Returns `undefined` for an image outside the catalog (an engine with no
 * catalog, or a row written before a series was retired).
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
