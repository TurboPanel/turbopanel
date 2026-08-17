import type { ServerReportedIp } from '../../server-addresses.ts'
import type { ServerGeo } from '../geo/server-geo.ts'
import type { DatacenterOptions } from '../datacenter-options.ts'
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
  codename?: string
  /** Raw `PRETTY_NAME` from os-release when available. */
  prettyName?: string
  /** e.g. arm64, x86_64, aarch64 */
  architecture?: string
}

export type ServerCpuResources = {
  /** CPU model name from `/proc/cpuinfo` (`model name`). */
  name?: string
  /** e.g. `"x86_64"`, `"aarch64"`. */
  architecture?: string
  /** Distinct physical socket count. */
  socketCount?: number
  /** Physical core count (`/proc/cpuinfo` topology). */
  coreCount?: number
  /**
   * Logical CPU / thread count (`/proc/stat` `cpuN` lines). Distinct from
   * {@link coreCount} when SMT/HT is enabled. Used for load-average bars.
   */
  threadCount?: number
}

/**
 * Static host capacity from daemon hello (`/proc/stat` + `/proc/meminfo`).
 * Used for fleet inventory totals and load-average normalization — not live
 * usage (that lives in the metrics backend).
 */
export type ServerHostResources = {
  cpu?: ServerCpuResources
  memory?: { totalBytes?: number }
  swap?: { totalBytes?: number }
}

/**
 * Cell placement / generation facts nested under `server.metadata.cell`.
 * Operator overrides for location/generation live on `server.options`.
 */
export type ServerCellMetadata = {
  /** Cloudflare `locationHint` chosen at enrollment (e.g. `"wnam"`, `"eeur"`). */
  locationHint?: string
  /** Monotonically increasing; increment when a new DO logical name is issued. */
  generation?: number
  /** Last snapshot version written by the cell, for optimistic concurrency. */
  snapshotVersion?: number
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
 * Host Docker CLI / Compose plugin versions from daemon hello / change-detected
 * heartbeat. Omit the whole object when Docker is not installed — do not store
 * an empty `{ }` placeholder.
 */
export type ServerDockerMetadata = {
  /** Docker CLI version (`docker --version`), e.g. `"28.3.3"`. */
  version?: string
  /** Compose plugin version (`docker compose version`), e.g. `"2.39.1"`. */
  composeVersion?: string
}

/**
 * JSON stored in `server.metadata`. Nested fields are optional.
 * Hostname / machineKey live on dedicated `server` columns (not here).
 */
export type ServerMetadata = {
  os?: ServerOsMetadata
  /**
   * Host capacity (cpu / RAM / swap totals) from daemon hello.
   * Rarely changes; process-cached on the daemon and projected once per connect.
   */
  resources?: ServerHostResources
  /**
   * Host interface addresses from daemon hello / change-detected heartbeat.
   */
  ips?: ServerReportedIp[]
  /**
   * Cell placement / generation nested under `cell` (options overrides apply).
   */
  cell?: ServerCellMetadata
  /**
   * IP geolocation captured from the connecting request (Cloudflare `request.cf`
   * on Workers; stub/null on self-hosted). Refreshed only when the daemon's
   * connecting IP changes. Stored in jsonb — no migration required.
   */
  geo?: ServerGeo
  /**
   * Host timezone + NTP state from daemon hello / change-detected heartbeat
   * (and refreshed on successful timezone/NTP command outcomes).
   */
  timeSync?: ServerTimeSync
  /**
   * Docker CLI / Compose plugin versions. Present only when the daemon
   * reports Docker installed; omitted (not `null`) when it is not.
   */
  docker?: ServerDockerMetadata
}

/**
 * JSON stored in `server.options`. Operator-controlled server configuration;
 * cell fields here override the enrollment copies in `server.metadata.cell`
 * when both are present.
 */
export type ServerOptions = {
  /**
   * Cloudflare `locationHint` for the daemon cell (e.g. `"wnam"`, `"eeur"`).
   * Takes precedence over `server.metadata.cell.locationHint` when set.
   */
  cellLocationHint?: string
  /**
   * Monotonically increasing cell generation for logical DO naming.
   * Takes precedence over `server.metadata.cell.generation` when set.
   */
  cellGeneration?: number
  /**
   * Operator timezone override for this server. Effective timezone is this value
   * unless the org enforces its default (`enforceServerTimezone`).
   */
  timezone?: string
  /**
   * Desired state for Docker-hosting provisioning; consumed by later phases to
   * choose self-heal vs report-only.
   */
  hosting?: { enabled: boolean }
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
  const codename = optionalTrimmedString(value.codename)
  if (codename) os.codename = codename
  const prettyName = optionalTrimmedString(value.prettyName)
  if (prettyName) os.prettyName = prettyName
  const architecture = optionalTrimmedString(value.architecture)
  if (architecture) os.architecture = architecture

  return Object.keys(os).length > 0 ? os : undefined
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (!Number.isInteger(value) || value < 0) return undefined
  return value
}

function parseCpuResources(value: unknown): ServerCpuResources | undefined {
  if (!isRecord(value)) return undefined
  const cpu: ServerCpuResources = {}
  const name = optionalTrimmedString(value.name)
  if (name) cpu.name = name
  const architecture = optionalTrimmedString(value.architecture)
  if (architecture) cpu.architecture = architecture
  const socketCount = optionalNonNegativeInt(value.socketCount)
  if (socketCount !== undefined && socketCount > 0) cpu.socketCount = socketCount
  const coreCount = optionalNonNegativeInt(value.coreCount)
  if (coreCount !== undefined && coreCount > 0) cpu.coreCount = coreCount
  const threadCount = optionalNonNegativeInt(value.threadCount)
  if (threadCount !== undefined && threadCount > 0) cpu.threadCount = threadCount
  return Object.keys(cpu).length > 0 ? cpu : undefined
}

/** Parse host capacity block from daemon hello / stored metadata. */
export function parseServerHostResources(
  value: unknown,
): ServerHostResources | undefined {
  if (!isRecord(value)) return undefined
  const resources: ServerHostResources = {}
  const cpu = parseCpuResources(value.cpu)
  if (cpu) resources.cpu = cpu
  if (isRecord(value.memory)) {
    const totalBytes = optionalNonNegativeInt(value.memory.totalBytes)
    if (totalBytes !== undefined && totalBytes > 0) {
      resources.memory = { totalBytes }
    }
  }
  if (isRecord(value.swap)) {
    const totalBytes = optionalNonNegativeInt(value.swap.totalBytes)
    // 0 is a valid SwapTotal (no swap).
    if (totalBytes !== undefined) {
      resources.swap = { totalBytes }
    }
  }
  return Object.keys(resources).length > 0 ? resources : undefined
}

/**
 * Prefer current `resources`; fall back to the pre-rename `inventory`
 * (`cpuCores` / `cpuThreads` / `memoryTotalBytes` / `swapTotalBytes`).
 */
export function resourcesFromDaemonPresence(
  payload: unknown,
): ServerHostResources | undefined {
  if (!isRecord(payload)) return undefined
  const fromResources = parseServerHostResources(payload.resources)
  if (fromResources) return fromResources
  if (!isRecord(payload.inventory)) return undefined
  return parseServerHostResources({
    cpu: {
      coreCount: payload.inventory.cpuCores,
      threadCount: payload.inventory.cpuThreads,
    },
    memory: { totalBytes: payload.inventory.memoryTotalBytes },
    swap: { totalBytes: payload.inventory.swapTotalBytes },
  })
}

function cpuResourcesEquals(
  a: ServerCpuResources | undefined,
  b: ServerCpuResources | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.name === b.name &&
    a.architecture === b.architecture &&
    a.socketCount === b.socketCount &&
    a.coreCount === b.coreCount &&
    a.threadCount === b.threadCount
  )
}

export function serverHostResourcesEquals(
  a: ServerHostResources | null | undefined,
  b: ServerHostResources | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    cpuResourcesEquals(a.cpu, b.cpu) &&
    a.memory?.totalBytes === b.memory?.totalBytes &&
    a.swap?.totalBytes === b.swap?.totalBytes
  )
}

/** Parse nested `server.metadata.cell` block. */
export function parseServerCellMetadata(
  value: unknown,
): ServerCellMetadata | undefined {
  if (!isRecord(value)) return undefined
  const cell: ServerCellMetadata = {}
  const locationHint = optionalTrimmedString(value.locationHint)
  if (locationHint) cell.locationHint = locationHint
  if (
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation)
  ) {
    cell.generation = value.generation
  }
  if (
    typeof value.snapshotVersion === 'number' &&
    Number.isInteger(value.snapshotVersion)
  ) {
    cell.snapshotVersion = value.snapshotVersion
  }
  return Object.keys(cell).length > 0 ? cell : undefined
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
  const codename = os.codename?.trim()
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
    a.codename === b.codename &&
    a.prettyName === b.prettyName &&
    a.architecture === b.architecture
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

const DOCKER_VERSION_MAX_CHARS = 64
const DOCKER_VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

function parseDockerVersionToken(value: unknown): string | undefined {
  const trimmed = optionalTrimmedString(value)
  if (!trimmed || trimmed.length > DOCKER_VERSION_MAX_CHARS) return undefined
  let token = trimmed
  if (token.startsWith('v') || token.startsWith('V')) {
    token = token.slice(1)
  }
  if (!DOCKER_VERSION_TOKEN.test(token)) return undefined
  return token
}

/** Parse a best-effort docker block from daemon hello / stored metadata. */
export function parseServerDockerMetadata(
  value: unknown,
): ServerDockerMetadata | undefined {
  if (!isRecord(value)) return undefined
  const docker: ServerDockerMetadata = {}
  const version = parseDockerVersionToken(value.version)
  if (version) docker.version = version
  const composeVersion = parseDockerVersionToken(value.composeVersion)
  if (composeVersion) docker.composeVersion = composeVersion
  return Object.keys(docker).length > 0 ? docker : undefined
}

export function serverDockerMetadataEquals(
  a: ServerDockerMetadata | null | undefined,
  b: ServerDockerMetadata | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.version === b.version && a.composeVersion === b.composeVersion
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
  if (isRecord(value.hosting) && typeof value.hosting.enabled === 'boolean') {
    options.hosting = { enabled: value.hosting.enabled }
  }
  return Object.keys(options).length > 0 ? options : {}
}

export type EffectiveServerTimezone = {
  timezone: string | null
  source: 'server' | 'organization' | 'datacenter' | null
}

/**
 * Resolve configured server timezone (enforced defaults and explicit overrides).
 *
 * Precedence: datacenter enforce, org enforce, `server.options.timezone`.
 * Non-enforcing org/datacenter defaults and daemon-reported zones are applied
 * in API routes via {@link resolveServerResponseTimezone}.
 */
export function resolveEffectiveServerTimezone(
  serverOptions: ServerOptions | null | undefined,
  orgOptions: OrganizationOptions | null | undefined,
  datacenterOptions?: DatacenterOptions | null,
): EffectiveServerTimezone {
  const dcDefault = datacenterOptions?.defaultServerTimezone?.trim() || null
  const orgDefault = orgOptions?.defaultServerTimezone?.trim() || null

  if (datacenterOptions?.enforceServerTimezone && dcDefault) {
    return { timezone: dcDefault, source: 'datacenter' }
  }
  if (datacenterOptions?.enforceServerTimezone) {
    return { timezone: null, source: null }
  }
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
  return { timezone: null, source: null }
}

/** Apply daemon-reported timezone when no configured override was resolved. */
export function resolveServerResponseTimezone(
  effective: EffectiveServerTimezone,
  daemonReportedTimezone: string | null | undefined,
): EffectiveServerTimezone {
  if (effective.timezone !== null) {
    return effective
  }
  const timezone = daemonReportedTimezone?.trim() || null
  return { timezone, source: null }
}
