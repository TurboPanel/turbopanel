/** Per-service `x-turbopanel` extension (Compose `services.<name>.x-turbopanel`). */

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
   * Document-root segment under the daemon site directory (relative only).
   * Default `public` when omitted for site.
   */
  root?: string
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

export function parseServiceTurbopanelExtension(
  value: unknown,
): ComposeServiceTurbopanelExtension | null {
  if (value === null || value === undefined) return {}
  if (!isPlainMapping(value)) return null

  const extension: ComposeServiceTurbopanelExtension = {}
  const serviceKind = readServiceKind(value.serviceKind)
  if (serviceKind) extension.serviceKind = serviceKind
  const engine = readSiteEngine(value.engine)
  if (engine) extension.engine = engine
  const framework = readNativeRuntimeFramework(value.framework)
  if (framework) extension.framework = framework
  const nodeVersion = readNodeVersion(value.nodeVersion)
  if (nodeVersion) extension.nodeVersion = nodeVersion
  const root = readTrimmedString(value.root)
  if (root) extension.root = root
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

  return extension
}

/**
 * Permissive read, matching every other reader here: anything malformed is
 * dropped. The strict pass that produces operator-facing messages is
 * {@link validatePhpConsistency}, which runs at save time.
 */
function parseServicePhpExtension(
  value: unknown,
): ComposeServicePhpExtension | null {
  if (!isPlainMapping(value)) return null
  const php: ComposeServicePhpExtension = {}
  const version = readTrimmedString(value.version)
  if (version && PHP_VERSION_RE.test(version)) php.version = version

  if (Array.isArray(value.extensions)) {
    const names = value.extensions
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => PHP_EXTENSION_RE.test(name))
    if (names.length > 0) php.extensions = [...new Set(names)].sort()
  }

  for (const field of ['settings', 'pool'] as const) {
    const raw = value[field]
    if (!isPlainMapping(raw)) continue
    const kept: Record<string, string | number> = {}
    for (const [key, entry] of Object.entries(raw)) {
      if (typeof entry === 'string' || typeof entry === 'number') {
        kept[key] = entry
      }
    }
    if (Object.keys(kept).length > 0) php[field] = kept
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

function validateRawExtensionFieldTypes(
  basePath: string,
  rawExtension: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(rawExtension)) return []
  const issues: ServiceTurbopanelValidationIssue[] = []

  if (
    "serviceKind" in rawExtension && !readServiceKind(rawExtension.serviceKind)
  ) {
    issues.push({
      path: `${basePath}.serviceKind`,
      message: 'serviceKind must be "container", "site", or "node"',
    })
  }

  if (
    "framework" in rawExtension &&
    !readNativeRuntimeFramework(rawExtension.framework)
  ) {
    issues.push({
      path: `${basePath}.framework`,
      message: 'framework must be "auto", "node", or "next"',
    })
  }

  if (
    "nodeVersion" in rawExtension && !readNodeVersion(rawExtension.nodeVersion)
  ) {
    issues.push({
      path: `${basePath}.nodeVersion`,
      message: 'nodeVersion must be a pinned version like "24" or "24.17.0"',
    })
  }

  if (
    "engine" in rawExtension && !readSiteEngine(rawExtension.engine)
  ) {
    issues.push({
      path: `${basePath}.engine`,
      message:
        'engine must be "caddy", "apache", "nginx", or "openlitespeed"',
    })
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
function validatePhpConsistency(
  basePath: string,
  raw: Record<string, unknown>,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []
  const rawPhp = raw.php
  if (rawPhp === undefined) return issues

  if (parsed.serviceKind !== 'site') {
    issues.push({
      path: `${basePath}.php`,
      message: 'php is only valid when serviceKind is site',
    })
    return issues
  }
  if (!isPlainMapping(rawPhp)) {
    issues.push({ path: `${basePath}.php`, message: 'php must be a mapping' })
    return issues
  }

  if (rawPhp.version !== undefined) {
    const version = typeof rawPhp.version === 'string'
      ? rawPhp.version.trim()
      : ''
    if (!PHP_VERSION_RE.test(version)) {
      issues.push({
        path: `${basePath}.php.version`,
        message: 'php.version must be a series like "8.4", not a patch version',
      })
    } else if (!SUPPORTED_PHP_SERIES.includes(version)) {
      issues.push({
        path: `${basePath}.php.version`,
        message: `PHP ${version} is not supported; supported: ${
          SUPPORTED_PHP_SERIES.join(', ')
        }`,
      })
    }
  }

  if (rawPhp.extensions !== undefined) {
    if (!Array.isArray(rawPhp.extensions)) {
      issues.push({
        path: `${basePath}.php.extensions`,
        message: 'php.extensions must be a list of extension names',
      })
    } else {
      for (const name of rawPhp.extensions) {
        const trimmed = typeof name === 'string' ? name.trim().toLowerCase() : ''
        if (!ALLOWED_PHP_EXTENSIONS.includes(trimmed)) {
          issues.push({
            path: `${basePath}.php.extensions`,
            message:
              `Unknown or disallowed PHP extension "${name}". Allowed: ${
                ALLOWED_PHP_EXTENSIONS.join(', ')
              }`,
          })
        }
      }
    }
  }

  for (
    const [field, validate] of [
      ['settings', validatePhpSetting],
      ['pool', validatePhpPoolSetting],
    ] as const
  ) {
    const block = rawPhp[field]
    if (block === undefined) continue
    if (!isPlainMapping(block)) {
      issues.push({
        path: `${basePath}.php.${field}`,
        message: `php.${field} must be a mapping`,
      })
      continue
    }
    for (const [key, value] of Object.entries(block)) {
      if (validate(key, value) === undefined) {
        issues.push({
          path: `${basePath}.php.${field}.${key}`,
          message:
            `"${key}" is not a settable php ${field} value, or "${value}" is out of range`,
        })
      }
    }
  }

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
