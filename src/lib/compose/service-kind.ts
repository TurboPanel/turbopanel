/** Per-service `x-turbopanel` extension (Compose `services.<name>.x-turbopanel`). */

import {
  cronToOnCalendar,
  MAX_CRON_JOBS_PER_SERVICE,
  parseCronCommand,
} from "../cron.ts"
import {
  validatePhpPoolSetting,
  validatePhpSetting,
} from "../php-settings.ts"

export const TURBOPANEL_SERVICE_EXTENSION_KEY = "x-turbopanel"

export type ComposeServiceKind = "container" | "site" | "node"

export type SiteEngine = "caddy" | "apache" | "nginx" | "openlitespeed"

/**
 * Runtime family for a `serviceKind: node` service.
 *
 * `auto` (the default when omitted) lets the daemon decide from the built tree
 * — a Next.js build that emitted `.next/standalone` is served as `next`, and
 * anything else falls back to plain `node`. Pinning `node` / `next` is an
 * operator override for the cases detection cannot see.
 */
export type NativeRuntimeFramework = "auto" | "node" | "next"

/**
 * Package manager used to install dependencies for a `serviceKind: node`
 * build. Omitted means auto-detect from the lockfile at build time
 * (`pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` > bare npm).
 */
export type NodePackageManager = "npm" | "yarn" | "pnpm"

/**
 * `NODE_ENV` for a `serviceKind: node` service — set in both the build
 * environment and the generated unit. Omitted means `production`.
 */
export type NodeAppMode = "production" | "development"

/**
 * Build backend for a `x-turbopanel.source` binding.
 *
 * `native` (the default when omitted) is the checkout → build → promote
 * directory release the daemon has always produced. `railpack` swaps that
 * middle step for Railpack + BuildKit, which emits an OCI image instead of a
 * filesystem tree; the daemon then rewrites the service to carry that image tag
 * so it runs as an ordinary compose service. The wire contract carries a third
 * value (`static`) that compose never mints.
 */
export type ComposeSourceBuildKind = "native" | "railpack"

/** Max length for operator-facing service description metadata. */
export const SERVICE_DESCRIPTION_MAX_LENGTH = 500

/** Max length for a Git ref name pinned on a service source. */
export const SOURCE_BRANCH_MAX_LENGTH = 255
/** Max length for the build / start command overrides. */
export const SOURCE_COMMAND_MAX_LENGTH = 1000

/** `24`, `24.17`, or `24.17.0` — a pinned major/minor/patch, never a range. */
const NODE_VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,2}$/

/**
 * Node series this control plane offers in pickers. Same contract as
 * {@link SUPPORTED_PHP_SERIES}: a static mirror of
 * `turbopaneld/orchestration/runtime-registry.json`, advisory only — the
 * schema keeps accepting any {@link NODE_VERSION_RE} value.
 */
export const SUPPORTED_NODE_SERIES: readonly string[] = ["22", "24"]
export const DEFAULT_NODE_SERIES = "24"

/**
 * Per-service Git source binding (`x-turbopanel.source`).
 *
 * `sourceId` points at a `source` row in the caller's organization. The pure
 * parser cannot reach the database, so it validates **shape only** — the
 * "does this id resolve?" rule lives in the route layer, which passes
 * `knownSourceIds` into `lintComposeYaml` (see `lint.ts`).
 */
export type ComposeServiceSourceExtension = {
  sourceId: string
  /** Git ref to build; falls back to `source.defaultBranch` when omitted. */
  branch?: string
  /** Relative checkout subdirectory (same rule as {@link isSafeRoot}). */
  subdirectory?: string
  buildCommand?: string
  startCommand?: string
  /** Relative build-output directory (same rule as {@link isSafeRoot}). */
  outputDirectory?: string
  /**
   * Which build backend produces the release. Omitted means `native`.
   *
   * `railpack` is only meaningful on a container service — the host-native
   * kinds have their own build/runtime lanes — which
   * {@link validateSourceConsistency} enforces.
   */
  buildKind?: ComposeSourceBuildKind
}

/**
 * Injection point for callers that *can* resolve source ids (route layer /
 * UI with a loaded sources list). The compose modules never resolve ids
 * themselves.
 */
export type SourceIdResolver = (sourceId: string) => boolean

export type ComposeServiceTurbopanelExtension = {
  serviceKind?: ComposeServiceKind
  engine?: SiteEngine
  /**
   * Native runtime family for `serviceKind: node`. Omitted means `auto`.
   * Only valid on a `node` service — a container's runtime comes from its
   * image, and a site is served by an engine, not a process.
   */
  framework?: NativeRuntimeFramework
  /**
   * Pinned Node series for `serviceKind: node` (`24`, `24.17`, `24.17.0`).
   * Advisory today: the daemon vendors one tenant Node release
   * (`vendor/node-app/<version>/current`) and records the request.
   */
  nodeVersion?: string
  /**
   * Package manager for a `serviceKind: node` build. Omitted means
   * auto-detect from the lockfile at build time.
   */
  packageManager?: NodePackageManager
  /**
   * `NODE_ENV` for a `serviceKind: node` service (build + unit). Omitted
   * means `production`.
   */
  appMode?: NodeAppMode
  /**
   * Whether a `serviceKind: node` service's process should run. Omitted means
   * `true`. When `false` the release still builds and promotes and the unit
   * file still installs, but the daemon stops and disables the unit instead
   * of starting it — re-enabling is a restart, not a rebuild.
   */
  enabled?: boolean
  /**
   * Document root for a `serviceKind: node` service (relative only).
   * Informational this pass: recorded and shown, not yet served — node apps
   * are still a pure reverse proxy.
   */
  documentRoot?: string
  /**
   * Script the vendored Node binary runs for a `serviceKind: node` service
   * when `source.startCommand` is absent. Omitted means `server.js`. An
   * explicit `startCommand` always wins.
   */
  startupFile?: string
  /**
   * Document-root segment under the daemon site directory (relative only).
   * Default `public` when omitted for site.
   */
  root?: string
  /**
   * Where a `site` service's content comes from. Omitted means `release`.
   *
   * `release` is a Git-backed immutable tree the daemon publishes and only ever
   * asserts. `managed-directory` is a principal-writable `webroot/` the tenant
   * fills over SFTP — "a directory and a principal", which is what a WordPress
   * or plain-PHP site actually wants.
   *
   * An explicit field rather than an inference from whether `source` is set,
   * because the two differ in a property worth stating out loud: a managed
   * directory gives up the immutable-release guarantee, so the tree the engine
   * executes is writable by the account running it. That is the right trade for
   * an application that writes to itself by design and the wrong one for a
   * built application.
   */
  sourceKind?: SiteSourceKind
  /**
   * Optional human description (TurboPanel-only metadata; not used by Docker).
   */
  description?: string
  /**
   * Optional Git source binding. Deploy prep resolves this into payload
   * `sourceMaterial[]` (`src/client/environments/deploy-sources.ts`) and the
   * daemon builds and promotes a release from it. It does **not** yet decide
   * document roots or process supervision.
   */
  source?: ComposeServiceSourceExtension
  /**
   * PHP configuration for a `site` service.
   *
   * Lives here rather than on the hosting row because a php-fpm pool is keyed
   * by `(environmentId, composeServiceName)` — 1:1 with the *service*. Several
   * hostings can point at one service, so a per-hosting PHP setting was
   * structurally unrepresentable downstream and silently last-wins merged. It
   * also puts PHP's version next to `nodeVersion`, where the sibling runtime's
   * version already lives, and moves validation from a silent drop at deploy
   * time to a real lint issue at save time.
   */
  php?: ComposeServicePhpExtension
  /**
   * Scheduled jobs for a `site` or `node` service.
   *
   * Rendered by the daemon as a systemd timer per entry, with `User=` set to
   * the service's principal. That is what makes this the cleanest proof
   * entitlement had to be an OS grant: `ExecStart` reaches `execve` **after**
   * systemd has dropped privileges, so `/usr/bin/php8.4` succeeds or fails
   * purely on the account's group membership. Nothing in the generated unit
   * grants anything.
   */
  cron?: ComposeServiceCronJob[]
}

/**
 * One scheduled job.
 *
 * `schedule` is a 5-field cron expression (or a `@daily`-style shorthand) as the
 * operator authored it — cron is what operators know, and `OnCalendar` is not
 * something to make anyone learn. It is translated once, control-plane side, by
 * `lib/cron.ts`; see that module for the day-of-month / day-of-week rule it
 * refuses rather than approximates.
 *
 * `command` is argv, not a shell line. systemd runs it directly, so `>>`, `|`,
 * and globs are inert text rather than syntax — the linter rejects them instead
 * of letting a line that looks like it redirects output silently pass `>>` to
 * the script as an argument. Output goes to the log viewer through journald,
 * which is where it was wanted anyway.
 */
export type ComposeServiceCronJob = {
  /** Unit-name segment: lowercase, `[a-z0-9-]`, unique within the service. */
  name: string
  /** Cron expression as authored. */
  schedule: string
  /** Command line, split to argv at deploy. */
  command: string
}

export type ComposeServicePhpExtension = {
  /** Series (`8.4`). Omitted means the host default. */
  version?: string
  /**
   * Opt-in extensions on top of the always-installed baseline.
   *
   * Host-global per series: `extension=` is `PHP_INI_SYSTEM` and there is no
   * per-pool loading, so opting in loads it for every site on that series.
   */
  extensions?: string[]
  /** `php_admin_value` directives — see `../php-settings.ts` for the table. */
  settings?: Record<string, string | number>
  /** php-fpm pool tuning (`pm`, `pm.max_children`, …). */
  pool?: Record<string, string | number>
}

/**
 * Series and extensions this control plane knows about.
 *
 * A small static mirror of `turbopaneld/orchestration/runtime-registry.json`,
 * which the daemon imports directly. The control plane cannot import across
 * repos, so this exists for save-time linting; the authoritative answer for a
 * specific host is its reported inventory. Divergence degrades to "offered a
 * series the server has not reported" — visible, never exploitable.
 */
export const SUPPORTED_PHP_SERIES: readonly string[] = ['8.3', '8.4']
export const ALLOWED_PHP_EXTENSIONS: readonly string[] = [
  'apcu', 'bcmath', 'bz2', 'curl', 'gd', 'gmp', 'igbinary', 'imagick', 'intl',
  'ldap', 'mbstring', 'memcached', 'msgpack', 'mysql', 'opcache', 'pgsql',
  'redis', 'snmp', 'soap', 'sqlite3', 'tidy', 'xml', 'yaml', 'zip', 'zstd',
]

/** Series shape (`8.4`) — the exec boundary, never a patch pin. */
const PHP_VERSION_RE = /^\d{1,2}\.\d{1,2}$/
/** Extension name shape; membership is checked separately against the registry. */
const PHP_EXTENSION_RE = /^[a-z][a-z0-9_-]{0,31}$/

const SERVICE_KINDS = new Set<ComposeServiceKind>([
  "container",
  "site",
  "node",
])
const NATIVE_RUNTIME_FRAMEWORKS = new Set<NativeRuntimeFramework>([
  "auto",
  "node",
  "next",
])
const SITE_ENGINES = new Set<SiteEngine>([
  "caddy",
  "apache",
  "nginx",
  "openlitespeed",
])
const SOURCE_BUILD_KINDS = new Set<ComposeSourceBuildKind>([
  "native",
  "railpack",
])
const NODE_PACKAGE_MANAGERS = new Set<NodePackageManager>([
  "npm",
  "yarn",
  "pnpm",
])
const NODE_APP_MODES = new Set<NodeAppMode>([
  "production",
  "development",
])

/** Where a site's content comes from. Omitted means `release`. */
export type SiteSourceKind = "release" | "managed-directory"

export const SITE_SOURCE_KINDS = new Set<SiteSourceKind>([
  "release",
  "managed-directory",
])

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readServiceKind(value: unknown): ComposeServiceKind | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!SERVICE_KINDS.has(trimmed as ComposeServiceKind)) return undefined
  return trimmed as ComposeServiceKind
}

function readSiteEngine(
  value: unknown,
): SiteEngine | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!SITE_ENGINES.has(trimmed as SiteEngine)) {
    return undefined
  }
  return trimmed as SiteEngine
}

/** Unit-name segment: lowercase, `[a-z0-9-]`, so it is safe as a filename. */
const CRON_JOB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * Shape-only read; `lib/cron.ts` is what validates the schedule and the command,
 * and its messages are what tell the operator why one was refused.
 *
 * A malformed entry is **dropped** rather than failing the whole parse, matching
 * every other block here — the validator is where a bad job becomes a visible
 * issue, and a parse that threw would make the compose editor unopenable.
 */
function parseServiceCronJobs(
  value: unknown,
): ComposeServiceCronJob[] | undefined {
  if (!Array.isArray(value)) return undefined
  const jobs: ComposeServiceCronJob[] = []
  for (const raw of value) {
    if (!isPlainMapping(raw)) continue
    const name = readTrimmedString(raw.name)
    const schedule = readTrimmedString(raw.schedule)
    const command = readTrimmedString(raw.command)
    if (!name || !schedule || !command) continue
    jobs.push({ name, schedule, command })
  }
  return jobs.length > 0 ? jobs : undefined
}

function readSiteSourceKind(value: unknown): SiteSourceKind | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!SITE_SOURCE_KINDS.has(trimmed as SiteSourceKind)) return undefined
  return trimmed as SiteSourceKind
}

function readNativeRuntimeFramework(
  value: unknown,
): NativeRuntimeFramework | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!NATIVE_RUNTIME_FRAMEWORKS.has(trimmed as NativeRuntimeFramework)) {
    return undefined
  }
  return trimmed as NativeRuntimeFramework
}

function readSourceBuildKind(
  value: unknown,
): ComposeSourceBuildKind | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!SOURCE_BUILD_KINDS.has(trimmed as ComposeSourceBuildKind)) {
    return undefined
  }
  return trimmed as ComposeSourceBuildKind
}

function readNodeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return NODE_VERSION_RE.test(trimmed) ? trimmed : undefined
}

function readNodePackageManager(value: unknown): NodePackageManager | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!NODE_PACKAGE_MANAGERS.has(trimmed as NodePackageManager)) {
    return undefined
  }
  return trimmed as NodePackageManager
}

function readNodeAppMode(value: unknown): NodeAppMode | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!NODE_APP_MODES.has(trimmed as NodeAppMode)) return undefined
  return trimmed as NodeAppMode
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SOURCE_STRING_FIELDS = [
  "branch",
  "subdirectory",
  "buildCommand",
  "startCommand",
  "outputDirectory",
] as const

type SourceStringField = (typeof SOURCE_STRING_FIELDS)[number]

function sourceFieldMaxLength(field: SourceStringField): number {
  if (field === "branch") return SOURCE_BRANCH_MAX_LENGTH
  if (field === "buildCommand" || field === "startCommand") {
    return SOURCE_COMMAND_MAX_LENGTH
  }
  return 200
}

function readSourceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed : undefined
}

/**
 * Parse `x-turbopanel.source`. Returns `null` when the value is present but
 * unusable (not a mapping, or no valid `sourceId`), so the caller can drop the
 * block while validation reports why.
 */
export function parseServiceSourceExtension(
  value: unknown,
): ComposeServiceSourceExtension | null {
  if (!isPlainMapping(value)) return null

  const sourceId = readSourceId(value.sourceId)
  if (!sourceId) return null

  const source: ComposeServiceSourceExtension = { sourceId }
  for (const field of SOURCE_STRING_FIELDS) {
    const raw = value[field]
    if (typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.length > sourceFieldMaxLength(field)) {
      continue
    }
    source[field] = trimmed
  }

  const buildKind = readSourceBuildKind(value.buildKind)
  if (buildKind) source.buildKind = buildKind

  return source
}

/** Read the parsed source binding off a raw compose service, if any. */
export function readServiceSourceExtension(
  service: Record<string, unknown>,
): ComposeServiceSourceExtension | undefined {
  const extension = readServiceTurbopanelExtension(service)
  return extension?.source
}

/**
 * A trimmed, non-empty string, or undefined — an over-long value is dropped
 * rather than truncated so the validator can report it as authored.
 */
function readTrimmedString(
  value: unknown,
  maxLength?: number,
): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (maxLength !== undefined && trimmed.length > maxLength) return undefined
  return trimmed
}

/** Runtime-selection fields — each reader yields a canonical value or nothing. */
function applyRuntimeExtensionFields(
  value: Record<string, unknown>,
  extension: ComposeServiceTurbopanelExtension,
): void {
  const serviceKind = readServiceKind(value.serviceKind)
  if (serviceKind) extension.serviceKind = serviceKind
  const engine = readSiteEngine(value.engine)
  if (engine) extension.engine = engine
  const framework = readNativeRuntimeFramework(value.framework)
  if (framework) extension.framework = framework
  const nodeVersion = readNodeVersion(value.nodeVersion)
  if (nodeVersion) extension.nodeVersion = nodeVersion
  const packageManager = readNodePackageManager(value.packageManager)
  if (packageManager) extension.packageManager = packageManager
  const appMode = readNodeAppMode(value.appMode)
  if (appMode) extension.appMode = appMode
  // `false` must survive the round-trip — never a truthiness guard here.
  if (typeof value.enabled === "boolean") extension.enabled = value.enabled
}

/** Content, source, and nested-block fields. */
function applyContentExtensionFields(
  value: Record<string, unknown>,
  extension: ComposeServiceTurbopanelExtension,
): void {
  const documentRoot = readTrimmedString(value.documentRoot)
  if (documentRoot) extension.documentRoot = documentRoot
  const startupFile = readTrimmedString(value.startupFile)
  if (startupFile) extension.startupFile = startupFile
  const root = readTrimmedString(value.root)
  if (root) extension.root = root
  const sourceKind = readSiteSourceKind(value.sourceKind)
  if (sourceKind) extension.sourceKind = sourceKind
  const cron = parseServiceCronJobs(value.cron)
  if (cron) extension.cron = cron
  const description = readTrimmedString(
    value.description,
    SERVICE_DESCRIPTION_MAX_LENGTH,
  )
  if (description) extension.description = description
  if (value.source !== undefined && value.source !== null) {
    const source = parseServiceSourceExtension(value.source)
    if (source) extension.source = source
  }
  const php = parseServicePhpExtension(value.php)
  if (php) extension.php = php
}

export function parseServiceTurbopanelExtension(
  value: unknown,
): ComposeServiceTurbopanelExtension | null {
  if (value === null || value === undefined) return {}
  if (!isPlainMapping(value)) return null

  const extension: ComposeServiceTurbopanelExtension = {}
  applyRuntimeExtensionFields(value, extension)
  applyContentExtensionFields(value, extension)
  return extension
}

/**
 * Permissive read, matching every other reader here: anything malformed is
 * dropped. The strict pass that produces operator-facing messages is
 * {@link validatePhpConsistency}, which runs at save time.
 */
/** The deduped, canonical extension list, or nothing when none survive. */
function parsePhpExtensionList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => PHP_EXTENSION_RE.test(name))
  if (names.length === 0) return undefined
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

/** Scalar directives only — a nested mapping is not a php.ini value. */
function parsePhpDirectiveMap(
  value: unknown,
): Record<string, string | number> | undefined {
  if (!isPlainMapping(value)) return undefined
  const kept: Record<string, string | number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      kept[key] = entry
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function parseServicePhpExtension(
  value: unknown,
): ComposeServicePhpExtension | null {
  if (!isPlainMapping(value)) return null
  const php: ComposeServicePhpExtension = {}
  const version = readTrimmedString(value.version)
  if (version && PHP_VERSION_RE.test(version)) php.version = version

  const extensions = parsePhpExtensionList(value.extensions)
  if (extensions) php.extensions = extensions

  for (const field of ['settings', 'pool'] as const) {
    const directives = parsePhpDirectiveMap(value[field])
    if (directives) php[field] = directives
  }

  return Object.keys(php).length > 0 ? php : null
}

export function readServiceTurbopanelExtension(
  service: Record<string, unknown>,
): ComposeServiceTurbopanelExtension | null {
  if (!(TURBOPANEL_SERVICE_EXTENSION_KEY in service)) return {}
  return parseServiceTurbopanelExtension(service[TURBOPANEL_SERVICE_EXTENSION_KEY])
}

export function isSiteComposeService(
  service: Record<string, unknown>,
): boolean {
  const extension = readServiceTurbopanelExtension(service)
  if (extension === null) return false
  return extension.serviceKind === "site"
}

/**
 * True for `serviceKind: node` — a Git-backed process supervised by a generated
 * systemd unit on the host, never a Docker container and never a document root.
 */
export function isNodeComposeService(
  service: Record<string, unknown>,
): boolean {
  const extension = readServiceTurbopanelExtension(service)
  if (extension === null) return false
  return extension.serviceKind === "node"
}

/**
 * Kinds that are **not** Docker services and therefore never need
 * `image` / `build`: sites are served by a host engine, and
 * `node` apps are supervised from a Git release.
 */
export function isHostNativeServiceKind(
  kind: ComposeServiceKind | undefined,
): boolean {
  return kind === "site" || kind === "node"
}

export type ServiceTurbopanelValidationIssue = {
  path: string
  message: string
}

/** Per-field type rules — checked only when the field is authored at all. */
const RAW_EXTENSION_FIELD_RULES: ReadonlyArray<{
  field: string
  isValid: (value: unknown) => boolean
  message: string
}> = [
  {
    field: "serviceKind",
    isValid: (value) => Boolean(readServiceKind(value)),
    message: 'serviceKind must be "container", "site", or "node"',
  },
  {
    field: "framework",
    isValid: (value) => Boolean(readNativeRuntimeFramework(value)),
    message: 'framework must be "auto", "node", or "next"',
  },
  {
    field: "nodeVersion",
    isValid: (value) => Boolean(readNodeVersion(value)),
    message: 'nodeVersion must be a pinned version like "24" or "24.17.0"',
  },
  {
    field: "packageManager",
    isValid: (value) => Boolean(readNodePackageManager(value)),
    message: 'packageManager must be "npm", "yarn", or "pnpm"',
  },
  {
    field: "appMode",
    isValid: (value) => Boolean(readNodeAppMode(value)),
    message: 'appMode must be "production" or "development"',
  },
  {
    field: "enabled",
    isValid: (value) => typeof value === "boolean",
    message: "enabled must be true or false",
  },
  {
    field: "engine",
    isValid: (value) => Boolean(readSiteEngine(value)),
    message: 'engine must be "caddy", "apache", "nginx", or "openlitespeed"',
  },
]

function validateRawExtensionFieldTypes(
  basePath: string,
  rawExtension: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(rawExtension)) return []
  const issues: ServiceTurbopanelValidationIssue[] = []

  for (const rule of RAW_EXTENSION_FIELD_RULES) {
    if (rule.field in rawExtension && !rule.isValid(rawExtension[rule.field])) {
      issues.push({
        path: `${basePath}.${rule.field}`,
        message: rule.message,
      })
    }
  }

  if ("description" in rawExtension) {
    const description = rawExtension.description
    if (typeof description !== "string") {
      issues.push({
        path: `${basePath}.description`,
        message: "description must be a string",
      })
    } else if (description.trim().length > SERVICE_DESCRIPTION_MAX_LENGTH) {
      issues.push({
        path: `${basePath}.description`,
        message:
          `description must be at most ${SERVICE_DESCRIPTION_MAX_LENGTH} characters`,
      })
    }
  }

  if ("source" in rawExtension) {
    issues.push(...validateRawSourceFieldTypes(basePath, rawExtension.source))
  }

  return issues
}

function validateRawSourceFieldTypes(
  basePath: string,
  rawSource: unknown,
): ServiceTurbopanelValidationIssue[] {
  const sourcePath = `${basePath}.source`
  if (!isPlainMapping(rawSource)) {
    return [{ path: sourcePath, message: "source must be a mapping" }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  if (!readSourceId(rawSource.sourceId)) {
    issues.push({
      path: `${sourcePath}.sourceId`,
      message:
        "source.sourceId must be the UUID of a source in this organization",
    })
  }

  for (const field of SOURCE_STRING_FIELDS) {
    if (!(field in rawSource)) continue
    const raw = rawSource[field]
    if (typeof raw !== "string") {
      issues.push({
        path: `${sourcePath}.${field}`,
        message: `${field} must be a string`,
      })
      continue
    }
    const max = sourceFieldMaxLength(field)
    if (raw.trim().length > max) {
      issues.push({
        path: `${sourcePath}.${field}`,
        message: `${field} must be at most ${max} characters`,
      })
    }
  }

  if ("buildKind" in rawSource && !readSourceBuildKind(rawSource.buildKind)) {
    issues.push({
      path: `${sourcePath}.buildKind`,
      message: 'source.buildKind must be "native" or "railpack"',
    })
  }

  return issues
}

/**
 * PHP block rules, reported at **save** time.
 *
 * This is the whole reason the block moved off the hosting row: an operator who
 * types `8.1` or `memory_limit: 256 MB` now gets a message in the editor
 * instead of a successful save followed by a deploy-time surprise.
 */
/** A series like `8.4`, and one this platform actually installs. */
function validatePhpVersion(
  basePath: string,
  rawVersion: unknown,
): ServiceTurbopanelValidationIssue[] {
  const version = typeof rawVersion === 'string' ? rawVersion.trim() : ''
  if (!PHP_VERSION_RE.test(version)) {
    return [{
      path: `${basePath}.php.version`,
      message: 'php.version must be a series like "8.4", not a patch version',
    }]
  }
  if (!SUPPORTED_PHP_SERIES.includes(version)) {
    return [{
      path: `${basePath}.php.version`,
      message: `PHP ${version} is not supported; supported: ${
        SUPPORTED_PHP_SERIES.join(', ')
      }`,
    }]
  }
  return []
}

/** Every name is reported, not just the first: operators paste whole lists. */
function validatePhpExtensions(
  basePath: string,
  rawExtensions: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!Array.isArray(rawExtensions)) {
    return [{
      path: `${basePath}.php.extensions`,
      message: 'php.extensions must be a list of extension names',
    }]
  }
  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const name of rawExtensions) {
    const trimmed = typeof name === 'string' ? name.trim().toLowerCase() : ''
    if (!ALLOWED_PHP_EXTENSIONS.includes(trimmed)) {
      issues.push({
        path: `${basePath}.php.extensions`,
        message: `Unknown or disallowed PHP extension "${name}". Allowed: ${
          ALLOWED_PHP_EXTENSIONS.join(', ')
        }`,
      })
    }
  }
  return issues
}

/**
 * One `php.settings` / `php.pool` mapping, checked key by key against the
 * validator that owns that table — the same one the deploy path re-runs.
 */
function validatePhpDirectiveBlock(
  basePath: string,
  field: 'settings' | 'pool',
  block: unknown,
  validate: (key: string, value: unknown) => string | undefined,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(block)) {
    return [{
      path: `${basePath}.php.${field}`,
      message: `php.${field} must be a mapping`,
    }]
  }
  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const [key, value] of Object.entries(block)) {
    if (validate(key, value) === undefined) {
      issues.push({
        path: `${basePath}.php.${field}.${key}`,
        message:
          `"${key}" is not a settable php ${field} value, or "${value}" is out of range`,
      })
    }
  }
  return issues
}

function validatePhpConsistency(
  basePath: string,
  raw: Record<string, unknown>,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const rawPhp = raw.php
  if (rawPhp === undefined) return []

  if (parsed.serviceKind !== 'site') {
    return [{
      path: `${basePath}.php`,
      message: 'php is only valid when serviceKind is site',
    }]
  }
  if (!isPlainMapping(rawPhp)) {
    return [{ path: `${basePath}.php`, message: 'php must be a mapping' }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  if (rawPhp.version !== undefined) {
    issues.push(...validatePhpVersion(basePath, rawPhp.version))
  }
  if (rawPhp.extensions !== undefined) {
    issues.push(...validatePhpExtensions(basePath, rawPhp.extensions))
  }

  for (
    const [field, validate] of [
      ['settings', validatePhpSetting],
      ['pool', validatePhpPoolSetting],
    ] as const
  ) {
    const block = rawPhp[field]
    if (block !== undefined) {
      issues.push(...validatePhpDirectiveBlock(basePath, field, block, validate))
    }
  }

  return issues
}

/**
 * Cron jobs, checked at save rather than at deploy.
 *
 * The schedule and command translators live in `../cron.ts` and return the
 * sentence that explains the refusal — a day-of-week rule the operator has to
 * understand, or a `>>` that would silently become an argument. Repeating those
 * messages here would let the two drift; passing them through keeps one
 * explanation per failure.
 */
function validateCronConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const jobs = parsed.cron
  if (!jobs || jobs.length === 0) return []

  const issues: ServiceTurbopanelValidationIssue[] = []
  // A container has no principal to run as and no tree to run in; both
  // host-native kinds have exactly one of each.
  if (!isHostNativeServiceKind(parsed.serviceKind)) {
    issues.push({
      path: `${basePath}.cron`,
      message: "cron is only valid when serviceKind is site or node",
    })
    return issues
  }
  if (jobs.length > MAX_CRON_JOBS_PER_SERVICE) {
    issues.push({
      path: `${basePath}.cron`,
      message:
        `a service may define at most ${MAX_CRON_JOBS_PER_SERVICE} scheduled jobs`,
    })
  }

  const seen = new Set<string>()
  jobs.forEach((job, index) => {
    const path = `${basePath}.cron[${index}]`
    if (!CRON_JOB_NAME_RE.test(job.name)) {
      issues.push({
        path: `${path}.name`,
        // It becomes a unit filename, so the charset is not cosmetic.
        message:
          'name must be lowercase letters, digits, and dashes (it becomes the timer\'s name)',
      })
    } else if (seen.has(job.name)) {
      // Two jobs with one name would render one unit and silently lose a job.
      issues.push({
        path: `${path}.name`,
        message: `duplicate job name "${job.name}"`,
      })
    } else {
      seen.add(job.name)
    }

    const schedule = cronToOnCalendar(job.schedule)
    if (!schedule.ok) {
      issues.push({ path: `${path}.schedule`, message: schedule.error })
    }
    const command = parseCronCommand(job.command)
    if (!command.ok) {
      issues.push({ path: `${path}.command`, message: command.error })
    }
  })
  return issues
}

function validateEngineConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  // `engine` is optional on a site and defaults to `caddy` (resolved at the
  // control-plane split, so the daemon never sees it absent). That makes the
  // minimum static site four lines of compose, which is the whole point.
  if (parsed.engine && parsed.serviceKind !== "site") {
    issues.push({
      path: `${basePath}.engine`,
      message: "engine is only valid when serviceKind is site",
    })
  }

  if (parsed.sourceKind && parsed.serviceKind !== "site") {
    issues.push({
      path: `${basePath}.sourceKind`,
      message: "sourceKind is only valid when serviceKind is site",
    })
  }

  // A repository-backed site serves the tree the release engine published, so
  // the daemon takes the release branch and the flag would be a lie. Rejected
  // at save rather than silently ignored at deploy: an operator who sets both
  // has a belief about where their content comes from, and one of the two is
  // wrong.
  if (parsed.sourceKind === "managed-directory" && parsed.source) {
    issues.push({
      path: `${basePath}.sourceKind`,
      message:
        "a site with a repository serves its published release; remove the source to serve an uploaded directory instead",
    })
  }

  return issues
}

/**
 * `node` services are Git-backed by definition: without a `source` there is
 * nothing to check out, build, or supervise. The framework / version hints only
 * mean anything on that kind, so they are rejected elsewhere rather than
 * silently ignored.
 */
function validateNodeConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  if (parsed.serviceKind === "node" && !parsed.source) {
    issues.push({
      path: `${basePath}.source`,
      message: "node services require source",
    })
  }

  if (parsed.framework && parsed.serviceKind !== "node") {
    issues.push({
      path: `${basePath}.framework`,
      message: "framework is only valid when serviceKind is node",
    })
  }

  if (parsed.nodeVersion && parsed.serviceKind !== "node") {
    issues.push({
      path: `${basePath}.nodeVersion`,
      message: "nodeVersion is only valid when serviceKind is node",
    })
  }

  if (parsed.serviceKind !== "node") {
    // Presence checks, not truthiness — `enabled: false` is still present.
    const nodeOnlyFields = [
      "packageManager",
      "appMode",
      "enabled",
      "documentRoot",
      "startupFile",
    ] as const
    for (const field of nodeOnlyFields) {
      if (parsed[field] === undefined) continue
      issues.push({
        path: `${basePath}.${field}`,
        message: `${field} is only valid when serviceKind is node`,
      })
    }
    return issues
  }

  // Both land in daemon-side paths (and startupFile in an ExecStart line), so
  // they share the same relative-path rule as `root`.
  for (const field of ["documentRoot", "startupFile"] as const) {
    const value = parsed[field]
    if (value === undefined || isSafeRoot(value)) continue
    issues.push({
      path: `${basePath}.${field}`,
      message:
        `${field} must be a relative path without ".." (e.g. "server.js" or "public")`,
    })
  }

  return issues
}

/**
 * A `node` service is not a Docker service, so `image` / `build` on it is a
 * contradiction rather than harmless extra: deploy strips the service out of
 * runtime compose entirely, and the image would never be pulled.
 */
function validateNodeComposeFields(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
  rawService: Record<string, unknown>,
): ServiceTurbopanelValidationIssue[] {
  if (parsed.serviceKind !== "node") return []

  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const field of ["image", "build"] as const) {
    if (!(field in rawService)) continue
    issues.push({
      path: `${basePath.slice(0, basePath.lastIndexOf("."))}.${field}`,
      message: `${field} is not valid on a node service`,
    })
  }
  return issues
}

function validateRootConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  if (parsed.root === undefined) return []

  if (parsed.serviceKind !== "site") {
    return [
      {
        path: `${basePath}.root`,
        message: "root is only valid when serviceKind is site",
      },
    ]
  }

  if (isSafeRoot(parsed.root)) return []
  return [
    {
      path: `${basePath}.root`,
      message: 'root must be a relative path without ".." (e.g. "public" or "www")',
    },
  ]
}

/**
 * Path-shaped source fields reuse the same relative-path rule as `root`.
 *
 * There is intentionally **no** `serviceKind` consistency rule for *having* a
 * source: a source builds a release for any kind, and nothing about the release
 * yet depends on how the service is served, so an author may wire one anywhere.
 * The linter emits a non-blocking advisory saying exactly that instead.
 *
 * `buildKind: railpack` is the one exception. It produces an OCI image that
 * only a container service can run — `site` and `node` already have
 * their own dedicated build and runtime lanes (host engine document roots,
 * supervised host processes), so asking for an image there is a contradiction
 * rather than an unused hint.
 */
function validateSourceConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const source = parsed.source
  if (!source) return []

  const issues: ServiceTurbopanelValidationIssue[] = []
  const pathFields = ["subdirectory", "outputDirectory"] as const
  for (const field of pathFields) {
    const value = source[field]
    if (value === undefined) continue
    if (isSafeRoot(value)) continue
    issues.push({
      path: `${basePath}.source.${field}`,
      message:
        `${field} must be a relative path without ".." (e.g. "apps/web")`,
    })
  }

  if (
    source.buildKind === "railpack" &&
    isHostNativeServiceKind(parsed.serviceKind)
  ) {
    issues.push({
      path: `${basePath}.source.buildKind`,
      message:
        "source.buildKind railpack is only valid when serviceKind is container",
    })
  }

  return issues
}

function collectServiceExtensionValidationIssues(
  basePath: string,
  rawService: Record<string, unknown>,
): ServiceTurbopanelValidationIssue[] {
  if (!(TURBOPANEL_SERVICE_EXTENSION_KEY in rawService)) return []

  const rawExtension = rawService[TURBOPANEL_SERVICE_EXTENSION_KEY]
  const parsed = parseServiceTurbopanelExtension(rawExtension)
  if (parsed === null) {
    return [{ path: basePath, message: "x-turbopanel must be a mapping" }]
  }

  return [
    ...validateRawExtensionFieldTypes(basePath, rawExtension),
    ...validateEngineConsistency(basePath, parsed),
    ...(isPlainMapping(rawExtension)
      ? validatePhpConsistency(basePath, rawExtension, parsed)
      : []),
    ...validateNodeConsistency(basePath, parsed),
    ...validateNodeComposeFields(basePath, parsed, rawService),
    ...validateRootConsistency(basePath, parsed),
    ...validateSourceConsistency(basePath, parsed),
    ...validateCronConsistency(basePath, parsed),
  ]
}

export function collectServiceTurbopanelValidationIssues(
  services: Record<string, unknown>,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  for (const [name, rawService] of Object.entries(services)) {
    if (!isPlainMapping(rawService)) continue
    const basePath = `services.${name}.x-turbopanel`
    issues.push(...collectServiceExtensionValidationIssues(basePath, rawService))
  }

  return issues
}

/**
 * Relative path without `..`, absolute prefix, or NUL. Shared by
 * `x-turbopanel.root` and the `x-turbopanel.source` path fields, and reused by
 * the `source` API routes for `subdirectory`.
 */
export function isSafeRoot(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return false
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return false
  if (trimmed.includes("..")) return false
  if (trimmed.includes("\0")) return false
  return /^[A-Za-z0-9._/-]+$/.test(trimmed)
}
