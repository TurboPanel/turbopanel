/**
 * Shared managed-engine settings parser.
 *
 * Semantics mirror `parseServiceOptions`: `undefined`/`null` → defaults;
 * malformed or **denied** input → `null` (reject the whole document) rather
 * than silently dropping. These values end up in generated compose, so
 * leniency is unsafe.
 */

import { clampServiceResources, type ResourceLimits } from '../resource-limits.ts'
import type { ServiceOptions } from '../service-options.ts'
import {
  isManagedSqlAccessScope,
  type ManagedSqlAccessScope,
} from './access-scope.ts'
import { managedAllowedImagesForEngine } from './releases.ts'
import { type ManagedSslMode, parseManagedSslMode } from './ssl.ts'

/** Compose Spec restart policies. */
const RESTART_POLICIES = new Set([
  'no',
  'always',
  'on-failure',
  'unless-stopped',
])

/**
 * Docker Compose keys that must never appear under managed `dockerOptions`.
 * The daemon-side parser (next phase) asserts the same set.
 */
export const MANAGED_DOCKER_OPTION_DENYLIST = [
  'privileged',
  'network_mode',
  'pid',
  'ipc',
  'userns_mode',
  'cap_add',
  'devices',
  'volumes',
  'ports',
  'user',
  'security_opt',
  'cgroup_parent',
  'sysctls',
] as const

const DOCKER_DENY_SET = new Set<string>(MANAGED_DOCKER_OPTION_DENYLIST)

const ALLOWED_DOCKER_KEYS = new Set([
  'restart',
  'stopGracePeriodSeconds',
  'shmSizeBytes',
  'ulimits',
  'labels',
  'extraEnv',
])

/** Client access scopes — shared ProxySQL listeners use org ingress ports (15432/13306). */

const MAX_IMAGE_REF_LENGTH = 256
/**
 * Strict OCI reference charset (registry/repo/tag/digest). Syntax-only —
 * engines may narrow to an allowed repository set later. Validated in steps
 * (name path, optional tag, optional digest) to keep each pattern simple.
 */
const OCI_NAME_SEGMENT_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/
const OCI_TAG_RE = /^\w[a-zA-Z0-9._-]{0,127}$/
const OCI_DIGEST_RE = /^sha256:[a-f0-9]{64}$/

const MAX_ENGINE_CONFIG_BYTES = 16 * 1024
// deno-lint-ignore no-control-regex -- intentional control-char reject list
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** Bound on `settings.backups.retentionKeep` regardless of engine max. */
const MAX_BACKUP_RETENTION_KEEP = 100

const MAX_LABEL_VALUE_LENGTH = 256
const MAX_LABELS = 32
const DENIED_LABEL_PREFIXES = ['traefik.', 'com.docker.compose.']

export const MANAGED_EXTRA_ENV_KEY_RE = /^[A-Za-z_]\w*$/
const MAX_EXTRA_ENV_ENTRIES = 32
const MAX_EXTRA_ENV_VALUE_LENGTH = 4096

/** Engine-reserved env keys that `extraEnv` must not override. */
export const POSTGRES_RESERVED_ENV_KEYS = new Set([
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_INITDB_ARGS',
  'POSTGRES_HOST_AUTH_METHOD',
  'PGDATA',
])

/** Engine-reserved MySQL image env keys that `extraEnv` must not override. */
export const MYSQL_RESERVED_ENV_KEYS = new Set([
  'MYSQL_ROOT_PASSWORD',
  'MYSQL_ROOT_HOST',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_ALLOW_EMPTY_PASSWORD',
  'MYSQL_RANDOM_ROOT_PASSWORD',
  'MYSQL_INITDB_SKIP_TZINFO',
])

/**
 * Engine-reserved MariaDB image env keys. The official image still honours
 * legacy `MYSQL_*` names, so both the `MARIADB_*` and `MYSQL_*` sets are
 * blocked.
 */
export const MARIADB_RESERVED_ENV_KEYS = new Set([
  'MARIADB_ROOT_PASSWORD',
  'MARIADB_ROOT_HOST',
  'MARIADB_DATABASE',
  'MARIADB_USER',
  'MARIADB_PASSWORD',
  'MARIADB_ALLOW_EMPTY_PASSWORD',
  'MARIADB_RANDOM_ROOT_PASSWORD',
  'MARIADB_INITDB_SKIP_TZINFO',
  ...MYSQL_RESERVED_ENV_KEYS,
])

/**
 * Engine-reserved env keys keyed by managed engine code. Shared by two
 * validation boundaries: client settings save (`parseManagedSettingsBase` via
 * each engine spec's `parseSettings`) and the `managed.apply` command payload
 * parser (`parseManagedApplyPayload` in `../commands/schemas.ts`). Both must
 * reject a hostile `dockerOptions.extraEnv` override of engine-owned vars
 * (credentials, data-dir roots, …) — a payload that bypassed the settings
 * save path (e.g. a stale/replayed command, or a future direct-apply caller)
 * must not be able to smuggle one past the daemon just because it skipped
 * the engine `parseSettings`. Engines without a concrete spec yet
 * (redis/clickhouse) have no entry — `dockerOptions` for those is
 * unreachable until they ship a spec.
 */
const MANAGED_RESERVED_ENV_KEYS_BY_ENGINE: Record<string, ReadonlySet<string>> = {
  postgres: POSTGRES_RESERVED_ENV_KEYS,
  mysql: MYSQL_RESERVED_ENV_KEYS,
  mariadb: MARIADB_RESERVED_ENV_KEYS,
}

/** Reserved env keys for `engine`, or an empty set when the engine has none declared. */
export function getManagedReservedEnvKeys(engine: string): ReadonlySet<string> {
  return MANAGED_RESERVED_ENV_KEYS_BY_ENGINE[engine] ?? new Set()
}

/**
 * Approved managed-engine image references, **derived** from the release
 * catalog (`./releases.ts`) so a version series is added or retired in one
 * place. Every surface that can ultimately produce a `settings.image` value —
 * this settings parser, the `managed.apply` command payload parser
 * (`parseManagedApplyPayload` in `../commands/schemas.ts`), the daemon mirror
 * (`turbopaneld/src/instance/commands/contracts.ts`), and the UI version
 * picker (`ui/src/lib/managed-releases.ts`) — must reject anything outside
 * these lists. An operator (or a replayed/forged command payload that skipped
 * the settings save path) must never be able to run an unsupported or EOL
 * major version.
 *
 * These are the **tested** series only (`ManagedEngineRelease.tested`):
 * PostgreSQL 18, MySQL 9.7, MariaDB 12.3, each with both of its base-OS
 * variants. A series the catalog merely knows about — so an already-persisted
 * image can still be named — is not accepted here.
 *
 * Ordering is catalog order (default series first, default variant first), so
 * the head of each list is that engine's default image.
 */
export const POSTGRES_ALLOWED_IMAGES: readonly string[] =
  managedAllowedImagesForEngine('postgres') ?? []

export const MYSQL_ALLOWED_IMAGES: readonly string[] = managedAllowedImagesForEngine('mysql') ?? []

export const MARIADB_ALLOWED_IMAGES: readonly string[] = managedAllowedImagesForEngine('mariadb') ??
  []

const MANAGED_ALLOWED_IMAGES_BY_ENGINE: Record<string, readonly string[]> = {
  postgres: POSTGRES_ALLOWED_IMAGES,
  mysql: MYSQL_ALLOWED_IMAGES,
  mariadb: MARIADB_ALLOWED_IMAGES,
}

/** Approved image references for `engine`, or `undefined` when the engine has no curated allowlist yet. */
export function getManagedAllowedImages(
  engine: string,
): readonly string[] | undefined {
  return MANAGED_ALLOWED_IMAGES_BY_ENGINE[engine]
}

/** `true` when `engine` has no curated allowlist (unrestricted) or `image` is a member of it. */
export function isManagedImageAllowed(engine: string, image: string): boolean {
  const allowed = MANAGED_ALLOWED_IMAGES_BY_ENGINE[engine]
  if (allowed === undefined) return true
  return allowed.includes(image)
}

export type ManagedDockerOptions = {
  restart?: string
  stopGracePeriodSeconds?: number
  shmSizeBytes?: number
  ulimits?: {
    nofile?: { soft: number; hard: number }
  }
  labels?: Record<string, string>
  extraEnv?: Record<string, string>
}

export type ManagedBackupSettings = {
  retentionKeep?: number
}

/**
 * ProxySQL routing policy for this cluster.
 *
 * `autoReadSplit` is off unless the operator turns it on: a blanket `^SELECT`
 * query rule silently changes read-after-write and locking-read semantics for
 * an application that never asked for it. The safe path is a dedicated
 * `read-only` login (`ManagedConnectionRole`), which lands on the reader
 * hostgroup by default hostgroup rather than by regex.
 */
export type ManagedRoutingSettings = {
  autoReadSplit?: boolean
}

export type ManagedSettings = {
  image?: string
  /**
   * Client-facing TLS policy at the ProxySQL boundary. `mode` omitted means
   * **inherit the organization default** (then the platform `require`);
   * resolve with `resolveManagedSslMode` rather than reading it directly.
   * Engine-side TLS is unconditional — see `ssl.ts`.
   */
  ssl: { mode?: ManagedSslMode }
  routing?: ManagedRoutingSettings
  resources?: NonNullable<ServiceOptions['resources']>
  dockerOptions?: ManagedDockerOptions
  /** Free-form engine-native config text (e.g. postgresql.conf snippet). */
  engineConfig?: string
  /**
   * Where clients may reach this cluster through the shared ProxySQL frontend.
   * `scope` omitted while enabled means {@link DEFAULT_MANAGED_SQL_ACCESS_SCOPE}.
   * Never a per-member engine publish — see `access-scope.ts`.
   */
  exposure: {
    enabled: boolean
    scope?: ManagedSqlAccessScope
  }
  /** Only meaningful for engines with a `backup` descriptor. */
  backups?: ManagedBackupSettings
}

export const DEFAULT_MANAGED_SETTINGS: ManagedSettings = {
  /** No override — inherit the org default, then `require`. */
  ssl: {},
  /**
   * Exposed by default: the shared ProxySQL publishes its listener ports
   * regardless, so recording exposure on matches reality. Narrowing access is
   * a host-firewall / database-user-rule concern, not a create-time choice.
   */
  exposure: { enabled: true },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidOciNamePath(value: string): boolean {
  if (value.length === 0) return false
  return value.split('/').every((segment) => OCI_NAME_SEGMENT_RE.test(segment))
}

function isValidOciImageRef(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IMAGE_REF_LENGTH) return false
  if (/\s/.test(value)) return false
  if (/[;&|`$<>(){}!]/.test(value)) return false

  let rest = value
  const digestAt = rest.lastIndexOf('@')
  if (digestAt !== -1) {
    if (!OCI_DIGEST_RE.test(rest.slice(digestAt + 1))) return false
    rest = rest.slice(0, digestAt)
  }

  const tagColon = rest.indexOf(':')
  if (tagColon !== -1) {
    if (!OCI_TAG_RE.test(rest.slice(tagColon + 1))) return false
    rest = rest.slice(0, tagColon)
  }

  return isValidOciNamePath(rest)
}

function parseImage(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!isValidOciImageRef(trimmed)) return null
  return trimmed
}

function parseSsl(value: unknown): ManagedSettings['ssl'] | null {
  if (value === undefined) return { ...DEFAULT_MANAGED_SETTINGS.ssl }
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (key !== 'mode') return null
  }
  const mode = parseManagedSslMode(value.mode)
  if (mode === null) return null
  if (mode !== undefined) {
    return { mode }
  }
  return {}
}

function parseRouting(
  value: unknown,
): ManagedRoutingSettings | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (key !== 'autoReadSplit') return null
  }
  if (value.autoReadSplit === undefined) return undefined
  if (typeof value.autoReadSplit !== 'boolean') return null
  return { autoReadSplit: value.autoReadSplit }
}

function readOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value >= 0 ? value : undefined
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  return rounded > 0 ? rounded : undefined
}

function parseResources(
  value: unknown,
): ServiceOptions['resources'] | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const resources: NonNullable<ServiceOptions['resources']> = {}
  if (value.cpus !== undefined) {
    const cpus = readOptionalNonNegativeNumber(value.cpus)
    if (cpus === undefined) return null
    resources.cpus = cpus
  }
  if (value.memoryBytes !== undefined) {
    const memoryBytes = readOptionalPositiveInt(value.memoryBytes)
    if (memoryBytes === undefined) return null
    resources.memoryBytes = memoryBytes
  }
  if (value.memoryReservationBytes !== undefined) {
    const memoryReservationBytes = readOptionalPositiveInt(
      value.memoryReservationBytes,
    )
    if (memoryReservationBytes === undefined) return null
    resources.memoryReservationBytes = memoryReservationBytes
  }
  return Object.keys(resources).length > 0 ? resources : undefined
}

function isDeniedLabelKey(key: string): boolean {
  const lower = key.toLowerCase()
  return DENIED_LABEL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function parseLabels(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_LABELS) return null
  const labels: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!isValidOciNamePath(key) || isDeniedLabelKey(key)) return null
    if (typeof raw !== 'string' || raw.length > MAX_LABEL_VALUE_LENGTH) {
      return null
    }
    labels[key] = raw
  }
  return labels
}

function parseExtraEnv(
  value: unknown,
  reservedKeys: ReadonlySet<string>,
): Record<string, string> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_EXTRA_ENV_ENTRIES) return null
  const env: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!MANAGED_EXTRA_ENV_KEY_RE.test(key)) return null
    if (reservedKeys.has(key)) return null
    if (typeof raw !== 'string' || raw.length > MAX_EXTRA_ENV_VALUE_LENGTH) {
      return null
    }
    if (CONTROL_CHAR_RE.test(raw)) return null
    env[key] = raw
  }
  return env
}

function parseNofileUlimit(
  value: unknown,
): { soft: number; hard: number } | null {
  if (!isRecord(value)) return null
  const soft = readOptionalPositiveInt(value.soft)
  const hard = readOptionalPositiveInt(value.hard)
  if (soft === undefined || hard === undefined) return null
  if (soft > hard) return null
  return { soft, hard }
}

function parseUlimits(
  value: unknown,
): ManagedDockerOptions['ulimits'] | null {
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (key !== 'nofile') return null
  }
  if (value.nofile === undefined) return {}
  const nofile = parseNofileUlimit(value.nofile)
  if (nofile === null) return null
  return { nofile }
}

function parseDockerOptionsField(
  key: string,
  value: unknown,
  reservedEnvKeys: ReadonlySet<string>,
  out: ManagedDockerOptions,
): boolean {
  switch (key) {
    case 'restart': {
      if (typeof value !== 'string' || !RESTART_POLICIES.has(value)) {
        return false
      }
      out.restart = value
      return true
    }
    case 'stopGracePeriodSeconds': {
      const seconds = readOptionalPositiveInt(value)
      if (seconds === undefined) return false
      out.stopGracePeriodSeconds = seconds
      return true
    }
    case 'shmSizeBytes': {
      const bytes = readOptionalPositiveInt(value)
      if (bytes === undefined) return false
      out.shmSizeBytes = bytes
      return true
    }
    case 'ulimits': {
      const ulimits = parseUlimits(value)
      if (ulimits === null) return false
      out.ulimits = ulimits
      return true
    }
    case 'labels': {
      const labels = parseLabels(value)
      if (labels === null) return false
      out.labels = labels
      return true
    }
    case 'extraEnv': {
      const extraEnv = parseExtraEnv(value, reservedEnvKeys)
      if (extraEnv === null) return false
      out.extraEnv = extraEnv
      return true
    }
    default:
      return false
  }
}

/**
 * Parse `dockerOptions`. Denied keys, unknown keys, or malformed values →
 * `null` (reject). Empty / absent → `undefined`.
 */
export function parseManagedDockerOptions(
  value: unknown,
  reservedEnvKeys: ReadonlySet<string> = new Set(),
): ManagedDockerOptions | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null

  const out: ManagedDockerOptions = {}
  for (const [key, raw] of Object.entries(value)) {
    if (DOCKER_DENY_SET.has(key) || !ALLOWED_DOCKER_KEYS.has(key)) return null
    if (!parseDockerOptionsField(key, raw, reservedEnvKeys, out)) return null
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeEngineConfig(value: string): string | null {
  if (value.length > MAX_ENGINE_CONFIG_BYTES) return null
  if (value.includes('\0')) return null
  if (CONTROL_CHAR_RE.test(value)) return null
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function parseEngineConfig(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  return normalizeEngineConfig(value)
}

function parseExposure(value: unknown): ManagedSettings['exposure'] | null {
  if (value === undefined) return { ...DEFAULT_MANAGED_SETTINGS.exposure }
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'scope') return null
  }
  if (typeof value.enabled !== 'boolean') return null

  const exposure: ManagedSettings['exposure'] = { enabled: value.enabled }

  if (value.scope !== undefined) {
    if (!isManagedSqlAccessScope(value.scope)) return null
    exposure.scope = value.scope
  }

  return exposure
}

/**
 * Parse `settings.backups`. Absent → `undefined` (engine defaults apply);
 * malformed or out-of-range → `null` (reject). `retentionKeep` is clamped to
 * an integer within `1..MAX_BACKUP_RETENTION_KEEP` — callers additionally
 * clamp against the engine's `maxRetentionKeep`.
 */
export function parseBackupSettings(
  value: unknown,
): ManagedBackupSettings | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null

  const backups: ManagedBackupSettings = {}
  if (value.retentionKeep !== undefined) {
    const retentionKeep = readOptionalPositiveInt(value.retentionKeep)
    if (
      retentionKeep === undefined || retentionKeep > MAX_BACKUP_RETENTION_KEEP
    ) {
      return null
    }
    backups.retentionKeep = retentionKeep
  }
  return Object.keys(backups).length > 0 ? backups : undefined
}

/**
 * Shared base settings every engine reuses. Engine specs compose this with
 * their own extras (e.g. Postgres `initialDatabase`).
 *
 * `engine` (when passed) narrows `image` against
 * {@link MANAGED_ALLOWED_IMAGES_BY_ENGINE} via {@link isManagedImageAllowed} —
 * engines without a curated allowlist are unrestricted. Callers that already
 * enforce the allowlist themselves (or intentionally validate a
 * pre-allowlisted default) may omit `engine`.
 */
export function parseManagedSettingsBase(
  value: unknown,
  reservedEnvKeys: ReadonlySet<string> = new Set(),
  engine?: string,
): ManagedSettings | null {
  if (value === null || value === undefined) {
    return {
      ssl: { ...DEFAULT_MANAGED_SETTINGS.ssl },
      exposure: { ...DEFAULT_MANAGED_SETTINGS.exposure },
    }
  }
  if (!isRecord(value)) return null
  return parseManagedSettingsRecord(value, reservedEnvKeys, engine)
}

/** Parse a non-null object body into shared managed settings fields. */
function parseManagedSettingsRecord(
  value: Record<string, unknown>,
  reservedEnvKeys: ReadonlySet<string>,
  engine?: string,
): ManagedSettings | null {
  const image = parseImage(value.image)
  if (image === null) return null
  if (
    image !== undefined &&
    engine !== undefined &&
    !isManagedImageAllowed(engine, image)
  ) {
    return null
  }

  const ssl = parseSsl(value.ssl)
  if (ssl === null) return null

  const routing = parseRouting(value.routing)
  if (routing === null) return null

  const resources = parseResources(value.resources)
  if (resources === null) return null

  const dockerOptions = parseManagedDockerOptions(
    value.dockerOptions,
    reservedEnvKeys,
  )
  if (dockerOptions === null) return null

  const engineConfig = parseEngineConfig(value.engineConfig)
  if (engineConfig === null) return null

  const exposure = parseExposure(value.exposure)
  if (exposure === null) return null

  const backups = parseBackupSettings(value.backups)
  if (backups === null) return null

  return assembleManagedSettings({
    ssl,
    exposure,
    image,
    routing,
    resources,
    dockerOptions,
    engineConfig,
    backups,
  })
}

function assembleManagedSettings(parts: {
  ssl: ManagedSettings['ssl']
  exposure: ManagedSettings['exposure']
  image: string | undefined
  routing: ManagedRoutingSettings | undefined
  resources: ManagedSettings['resources'] | undefined
  dockerOptions: ManagedSettings['dockerOptions'] | undefined
  engineConfig: string | undefined
  backups: ManagedBackupSettings | undefined
}): ManagedSettings {
  const settings: ManagedSettings = {
    ssl: parts.ssl,
    exposure: parts.exposure,
  }
  if (parts.routing !== undefined) settings.routing = parts.routing
  if (parts.image !== undefined) settings.image = parts.image
  if (parts.resources !== undefined) settings.resources = parts.resources
  if (parts.dockerOptions !== undefined) {
    settings.dockerOptions = parts.dockerOptions
  }
  if (parts.engineConfig !== undefined) {
    settings.engineConfig = parts.engineConfig
  }
  if (parts.backups !== undefined) settings.backups = parts.backups
  return settings
}

/** Clamp managed resource requests against org + server limits. */
export function clampManagedResources(
  settings: ManagedSettings,
  orgLimits: ResourceLimits,
  serverLimits: ResourceLimits,
): ManagedSettings {
  const clamped = clampServiceResources(
    { resources: settings.resources },
    orgLimits,
    serverLimits,
  )
  return {
    ...settings,
    resources: clamped.resources,
  }
}
