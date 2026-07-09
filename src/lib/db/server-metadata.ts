import type { ServerGeo } from '../geo/server-geo.ts'

/** OS families we may report from the daemon; extend the union as support is added. */
export type ServerOsFamily = 'linux' | 'windows' | 'freebsd' | 'darwin'

/** Best-effort OS block; fields may be filled in over time. */
export type ServerOsMetadata = {
  family?: ServerOsFamily
  /** Distro id from os-release `ID=` (e.g. `"debian"`). */
  id?: string
  /** e.g. `VERSION_ID` `"13"` / `"13.1"` */
  version?: string
  /** e.g. `VERSION_CODENAME` `"trixie"` */
  versionCodename?: string
  /** Raw `PRETTY_NAME` from os-release when available. */
  prettyName?: string
  /** e.g. arm64, x86_64 */
  arch?: string
}

/**
 * Hybrid / P+E style core counts (optional; omit on homogeneous or unknown CPUs).
 * `p` = performance cores, `e` = efficiency cores.
 */
export type ServerCpuCores = {
  p?: number
  e?: number
}

export type ServerCpuMetadata = {
  sockets?: number
  cores?: ServerCpuCores
  threads?: number
}

/**
 * JSON stored in `server.metadata`. Nested fields are optional; daemon registration
 * also stores `machineId` and `hostname` here for reconnect deduplication.
 */
export type ServerMetadata = {
  os?: ServerOsMetadata
  cpu?: ServerCpuMetadata
  machineId?: string
  hostname?: string
  /**
   * Cloudflare `locationHint` chosen at enrollment time (e.g. `"wnam"`, `"eeur"`).
   * Enrollment-time decision; region moves require a new generation.
   */
  cellLocationHint?: string
  /** Monotonically increasing; increment when a new DO logical name is issued after a region move. */
  cellGeneration?: number
  /** Last snapshot version written by the cell, for optimistic concurrency checks. */
  cellSnapshotVersion?: number
  /**
   * IP geolocation captured from the connecting request (Cloudflare `request.cf`
   * on Workers; stub/null on self-hosted). Refreshed only when the daemon's
   * connecting IP changes. Stored in jsonb — no migration required.
   */
  geo?: ServerGeo
}

/**
 * JSON stored in `server.options`. Operator-controlled server configuration;
 * cell fields here override the enrollment copies in `server.metadata` when both
 * are present.
 */
export type ServerOptions = {
  /**
   * Cloudflare `locationHint` for the daemon cell (e.g. `"wnam"`, `"eeur"`).
   * Takes precedence over `server.metadata.cellLocationHint` when set.
   */
  cellLocationHint?: string
  /**
   * Monotonically increasing cell generation for logical DO naming.
   * Takes precedence over `server.metadata.cellGeneration` when set.
   */
  cellGeneration?: number
}

const OS_FAMILIES = new Set<ServerOsFamily>([
  'linux',
  'windows',
  'freebsd',
  'darwin',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Parse a best-effort OS block from daemon hello / stored metadata. */
export function parseServerOsMetadata(
  value: unknown,
): ServerOsMetadata | undefined {
  if (!isRecord(value)) return undefined
  const familyRaw = optionalTrimmedString(value.family)?.toLowerCase()
  const family =
    familyRaw && OS_FAMILIES.has(familyRaw as ServerOsFamily)
      ? (familyRaw as ServerOsFamily)
      : undefined

  const os: ServerOsMetadata = {}
  if (family) os.family = family
  const id = optionalTrimmedString(value.id)
  if (id) os.id = id
  const version = optionalTrimmedString(value.version)
  if (version) os.version = version
  const versionCodename = optionalTrimmedString(value.versionCodename)
  if (versionCodename) os.versionCodename = versionCodename
  const prettyName = optionalTrimmedString(value.prettyName)
  if (prettyName) os.prettyName = prettyName
  const arch = optionalTrimmedString(value.arch)
  if (arch) os.arch = arch

  return Object.keys(os).length > 0 ? os : undefined
}

function titleCaseWord(word: string): string {
  if (!word) return word
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function titleCasePhrase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(' ')
}

/**
 * Product label for display: prefer short distro id (`debian` → `Debian`),
 * else first token of `NAME` / `prettyName` that is not a generic "GNU/Linux".
 */
function resolveOsProductName(os: ServerOsMetadata): string | undefined {
  if (os.id) return titleCasePhrase(os.id)
  const fromName = os.prettyName?.trim()
  if (fromName) {
    // "Debian GNU/Linux 13 (trixie)" → "Debian"
    const first = fromName.split(/\s+/)[0]
    if (first && first.toLowerCase() !== 'gnu') return titleCaseWord(first)
  }
  if (os.family === 'linux') return 'Linux'
  if (os.family) return titleCaseWord(os.family)
  return undefined
}

/**
 * UI/API display string, e.g. `"Debian 13 (Trixie)"`.
 * Falls back through available fields when version/codename are missing.
 */
export function formatServerOsDisplay(
  os: ServerOsMetadata | null | undefined,
): string | null {
  if (!os) return null
  const product = resolveOsProductName(os)
  const version = os.version?.trim()
  const codename = os.versionCodename?.trim()
  const codenameLabel = codename ? titleCasePhrase(codename) : undefined

  if (product && version && codenameLabel) {
    return `${product} ${version} (${codenameLabel})`
  }
  if (product && version) return `${product} ${version}`
  if (product && codenameLabel) return `${product} (${codenameLabel})`
  if (product) return product
  if (os.prettyName?.trim()) return os.prettyName.trim()
  return null
}

export function serverOsMetadataEquals(
  a: ServerOsMetadata | null | undefined,
  b: ServerOsMetadata | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.family === b.family &&
    a.id === b.id &&
    a.version === b.version &&
    a.versionCodename === b.versionCodename &&
    a.prettyName === b.prettyName &&
    a.arch === b.arch
  )
}
