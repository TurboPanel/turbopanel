/** Per-service `x-turbopanel` extension (Compose `services.<name>.x-turbopanel`). */

export const TURBOPANEL_SERVICE_EXTENSION_KEY = "x-turbopanel"

export type ComposeServiceKind = "container" | "traditional-web" | "node"

export type TraditionalWebEngine = "apache" | "nginx" | "openlitespeed"

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
  engine?: TraditionalWebEngine
  /**
   * Native runtime family for `serviceKind: node`. Omitted means `auto`.
   * Only valid on a `node` service — a container's runtime comes from its
   * image, and a traditional-web site is served by an engine, not a process.
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
   * Default `public` when omitted for traditional-web.
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
}

const SERVICE_KINDS = new Set<ComposeServiceKind>([
  "container",
  "traditional-web",
  "node",
])
const NATIVE_RUNTIME_FRAMEWORKS = new Set<NativeRuntimeFramework>([
  "auto",
  "node",
  "next",
])
const TRADITIONAL_WEB_ENGINES = new Set<TraditionalWebEngine>([
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

function readTraditionalWebEngine(
  value: unknown,
): TraditionalWebEngine | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!TRADITIONAL_WEB_ENGINES.has(trimmed as TraditionalWebEngine)) {
    return undefined
  }
  return trimmed as TraditionalWebEngine
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
  const engine = readTraditionalWebEngine(value.engine)
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

  return extension
}

export function readServiceTurbopanelExtension(
  service: Record<string, unknown>,
): ComposeServiceTurbopanelExtension | null {
  if (!(TURBOPANEL_SERVICE_EXTENSION_KEY in service)) return {}
  return parseServiceTurbopanelExtension(service[TURBOPANEL_SERVICE_EXTENSION_KEY])
}

export function isTraditionalWebComposeService(
  service: Record<string, unknown>,
): boolean {
  const extension = readServiceTurbopanelExtension(service)
  if (extension === null) return false
  return extension.serviceKind === "traditional-web"
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
 * `image` / `build`: traditional-web sites are served by a host engine, and
 * `node` apps are supervised from a Git release.
 */
export function isHostNativeServiceKind(
  kind: ComposeServiceKind | undefined,
): boolean {
  return kind === "traditional-web" || kind === "node"
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
      message: 'serviceKind must be "container", "traditional-web", or "node"',
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
    "engine" in rawExtension && !readTraditionalWebEngine(rawExtension.engine)
  ) {
    issues.push({
      path: `${basePath}.engine`,
      message: 'engine must be "apache", "nginx", or "openlitespeed"',
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

function validateEngineConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  if (parsed.serviceKind === "traditional-web" && !parsed.engine) {
    issues.push({
      path: `${basePath}.engine`,
      message: "traditional-web services require engine",
    })
  }

  if (parsed.engine && parsed.serviceKind !== "traditional-web") {
    issues.push({
      path: `${basePath}.engine`,
      message: "engine is only valid when serviceKind is traditional-web",
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

  if (parsed.serviceKind !== "traditional-web") {
    return [
      {
        path: `${basePath}.root`,
        message: "root is only valid when serviceKind is traditional-web",
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
 * only a container service can run — `traditional-web` and `node` already have
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
