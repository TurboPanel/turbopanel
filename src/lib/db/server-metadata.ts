import type { ServerAddresses } from '../../server-addresses.ts'
import type { ServerGeo } from '../geo/server-geo.ts'
import type { OrganizationOptions } from '../organization-options.ts'

/** OS families we may report from the daemon; extend the union as support is added. */
export type ServerOsFamily = 'linux' | 'windows' | 'freebsd' | 'darwin'

/**
 * Distro variant beyond raw `ID=` — Raspberry Pi OS 64-bit still reports
 * `ID=debian` but the daemon sets this when `/etc/rpi-issue` is present.
 */
export type ServerOsVariant = 'raspberry-pi-os'

/** Best-effort OS block; fields may be filled in over time. */
export type ServerOsMetadata = {
  family?: ServerOsFamily
  /** Distro id from os-release `ID=` (e.g. `"debian"`, `"raspbian"`). */
  id?: string
  /**
   * Product variant when `ID` alone is misleading (e.g. Raspberry Pi OS 64-bit).
   */
  variant?: ServerOsVariant
  /** Prefer dotted point-release (`"13.5"`) over bare major (`"13"`). */
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
 * Host time-sync facts mirrored from the daemon `HostTimeSync` shape, plus an
 * optional `capturedAt` stamp when persisted on `server.metadata`.
 */
export type ServerTimeSync = {
  timezone?: string
  ntpEnabled?: boolean
  ntpSynced?: boolean
  ntpServers?: string[]
  fallbackNtpServers?: string[]
  capturedAt?: string
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
  /**
   * Host interface addresses reported on daemon hello / change-detected heartbeat.
   */
  addresses?: ServerAddresses
  /**
   * Host timezone + NTP state from daemon hello / change-detected heartbeat
   * (and refreshed on successful timezone/NTP command outcomes).
   */
  timeSync?: ServerTimeSync
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
  /**
   * Operator timezone override for this server. Effective timezone is this value
   * unless the org enforces its default (`enforceServerTimezone`).
   */
  timezone?: string
}

const OS_FAMILIES = new Set<ServerOsFamily>([
  'linux',
  'windows',
  'freebsd',
  'darwin',
])

const OS_VARIANTS = new Set<ServerOsVariant>(['raspberry-pi-os'])

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
  const variantRaw = optionalTrimmedString(value.variant)?.toLowerCase()
  if (variantRaw && OS_VARIANTS.has(variantRaw as ServerOsVariant)) {
    os.variant = variantRaw as ServerOsVariant
  }
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

function isRaspberryPiOs(os: ServerOsMetadata): boolean {
  if (os.variant === 'raspberry-pi-os') return true
  const id = os.id?.toLowerCase()
  return id === 'raspbian' || id === 'raspberrypi' || id === 'raspios'
}

/**
 * Product label for display.
 * Raspberry Pi OS / Raspbian → "Raspberry Pi OS"; debian → "Debian"; etc.
 */
function resolveOsProductName(os: ServerOsMetadata): string | undefined {
  if (isRaspberryPiOs(os)) return 'Raspberry Pi OS'
  const id = os.id?.toLowerCase()
  if (id === 'debian') return 'Debian'
  if (id === 'ubuntu') return 'Ubuntu'
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

/** Logo key for UI (`debian` | `raspberry-pi-os` | null). */
export function resolveServerOsLogoKey(
  os: ServerOsMetadata | null | undefined,
): 'debian' | 'raspberry-pi-os' | null {
  if (!os) return null
  if (isRaspberryPiOs(os)) return 'raspberry-pi-os'
  if (os.id?.toLowerCase() === 'debian') return 'debian'
  return null
}

/**
 * UI/API display string, e.g. `"Debian 13.5 (Trixie)"` or
 * `"Raspberry Pi OS 12.11 (Bookworm)"`.
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
    a.variant === b.variant &&
    a.version === b.version &&
    a.versionCodename === b.versionCodename &&
    a.prettyName === b.prettyName &&
    a.arch === b.arch
  )
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

function stringArraysEqual(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Parse a best-effort time-sync block from daemon hello / stored metadata. */
export function parseServerTimeSync(
  value: unknown,
): ServerTimeSync | undefined {
  if (!isRecord(value)) return undefined
  const timeSync: ServerTimeSync = {}
  const timezone = optionalTrimmedString(value.timezone)
  if (timezone) timeSync.timezone = timezone
  if (typeof value.ntpEnabled === 'boolean') timeSync.ntpEnabled = value.ntpEnabled
  if (typeof value.ntpSynced === 'boolean') timeSync.ntpSynced = value.ntpSynced
  const ntpServers = optionalStringArray(value.ntpServers)
  if (ntpServers !== undefined) timeSync.ntpServers = ntpServers
  const fallbackNtpServers = optionalStringArray(value.fallbackNtpServers)
  if (fallbackNtpServers !== undefined) {
    timeSync.fallbackNtpServers = fallbackNtpServers
  }
  const capturedAt = optionalTrimmedString(value.capturedAt)
  if (capturedAt) timeSync.capturedAt = capturedAt
  return Object.keys(timeSync).length > 0 ? timeSync : undefined
}

/** Compare time-sync facts, ignoring `capturedAt`. */
export function serverTimeSyncEquals(
  a: ServerTimeSync | null | undefined,
  b: ServerTimeSync | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.timezone === b.timezone &&
    a.ntpEnabled === b.ntpEnabled &&
    a.ntpSynced === b.ntpSynced &&
    stringArraysEqual(a.ntpServers, b.ntpServers) &&
    stringArraysEqual(a.fallbackNtpServers, b.fallbackNtpServers)
  )
}

/** Parse operator-controlled `server.options` jsonb. */
export function parseServerOptions(value: unknown): ServerOptions | null {
  if (!isRecord(value)) return null
  const options: ServerOptions = {}
  const timezone = optionalTrimmedString(value.timezone)
  if (timezone) options.timezone = timezone
  const cellLocationHint = optionalTrimmedString(value.cellLocationHint)
  if (cellLocationHint) options.cellLocationHint = cellLocationHint
  if (
    typeof value.cellGeneration === 'number' &&
    Number.isInteger(value.cellGeneration)
  ) {
    options.cellGeneration = value.cellGeneration
  }
  return Object.keys(options).length > 0 ? options : {}
}

export type EffectiveServerTimezone = {
  timezone: string | null
  source: 'server' | 'organization' | null
}

/**
 * Resolve the effective server timezone.
 *
 * When the org enforces its default (`enforceServerTimezone`), the org default
 * wins. Otherwise the per-server override wins over the org default.
 */
export function resolveEffectiveServerTimezone(
  serverOptions: ServerOptions | null | undefined,
  orgOptions: OrganizationOptions | null | undefined,
): EffectiveServerTimezone {
  const orgDefault = orgOptions?.defaultServerTimezone?.trim() || null
  if (orgOptions?.enforceServerTimezone) {
    return {
      timezone: orgDefault,
      source: orgDefault ? 'organization' : null,
    }
  }
  const serverTz = serverOptions?.timezone?.trim() || null
  if (serverTz) {
    return { timezone: serverTz, source: 'server' }
  }
  if (orgDefault) {
    return { timezone: orgDefault, source: 'organization' }
  }
  return { timezone: null, source: null }
}
