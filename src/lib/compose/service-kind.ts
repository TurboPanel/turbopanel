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
import {
  collectHostingExtensionValidationIssues,
  type ComposeHostingExtensionEntry,
  parseHostingExtensionEntries,
} from "./hosting-extension.ts"

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

/**
 * Document-local principal alias charset.
 *
 * Canonical home for the rule even though the root block is what *declares* an
 * alias: `x-turbopanel.principal` on a service **references** one, and
 * `root-extension.ts` already depends on this module, so putting the regex
 * there and importing it back would be the one import that closes the cycle.
 *
 * Not the Unix username: the daemon derives that (with its own reserved-name
 * and length rules in `lib/naming.ts`), and an alias that had to be the account
 * name would leak host-global uniqueness into a per-document identifier. This
 * is only "a name this compose file can refer to", so the rule is the ordinary
 * identifier shape.
 */
export const PRINCIPAL_ALIAS_RE = /^[a-z][a-z0-9_-]{0,63}$/i

export function isPrincipalAlias(value: unknown): value is string {
  return typeof value === "string" && PRINCIPAL_ALIAS_RE.test(value.trim())
}

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

/**
 * Every `x-turbopanel` service field, all optional — the flat, pre-narrowing
 * view the parser fills in and the validators read.
 *
 * The **exported** type is the discriminated union below. This one exists
 * because the *wire* shape has always been one flat mapping per service and
 * always will be: narrowing by `serviceKind` is a compile-time story about
 * which keys are legal, not a change to what is written or parsed. Keeping the
 * two apart is what lets {@link parseServiceTurbopanelExtension} keep filling a
 * single object field by field while callers still get a type that knows
 * `engine` is a site's business and `startupFile` is a node's.
 */
type ComposeServiceExtensionFields = {
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
  /**
   * The account this host-native service runs as, named by **alias**.
   *
   * The value is a key in the sibling root `x-turbopanel.principals` map — a
   * document-local name — never a Linux username. The Unix account it
   * materializes into (its `username` / `appliedUsername`, uid, gid, home,
   * shell) is decided control-plane side on the `principal` row, which is why
   * an alias can be written by anyone with compose edit rights while none of
   * those can (see `ROOT_KEY_REDIRECTS` in `./root-extension.ts`).
   *
   * Legal on `site` and `node`, refused on `container`: a container has no
   * account to run as. **Optional**, not required, on both host-native kinds —
   * every document written before this field existed names no alias and is
   * owned by whatever principal an operator assigned in the panel, so
   * requiring it here would reject them at save. Naming one is still the
   * better answer: it wins outright over the sole-steward lookup, which is the
   * guess the unowned-site / unowned-release class of bug came from. The
   * refusal for a host-native service that has *no* owner at all belongs where
   * the stewards are known — `principal_required_for_service_kind` in
   * `../../client/environments/deploy-sources.ts`.
   */
  principal?: string
  /**
   * Ingress routes this service answers on (`x-turbopanel.hosting`).
   *
   * Legal on every kind, because every kind can front one: a container behind
   * the edge, a site served by a host engine, a supervised `node` process. The
   * block is **never** a `ports:` replacement — it opens no host port, it
   * declares a hostname the edge routes by name. See `./hosting-extension.ts`,
   * which owns the shape, the messages, and the redirects that say so.
   *
   * Deploy-prepare materializes each entry into a `hosting` row
   * (`../../client/environments/reconcile-hostings.ts`); everything downstream
   * — `buildHostingsForService`, the daemon's ingress and TLS lanes — keeps
   * reading those rows and never sees this block.
   */
  hosting?: ComposeHostingExtensionEntry[]
}

/**
 * Fields any kind may carry: what the service is, where its code comes from,
 * and which hostnames reach it.
 */
type CommonServiceExtensionFields = Pick<
  ComposeServiceExtensionFields,
  "serviceKind" | "description" | "source" | "hosting"
>

/** Site-only fields: how the content is served, and what serves it. */
type SiteOnlyExtensionField = "engine" | "root" | "sourceKind" | "php"

/** Node-only fields: how the process is built, pinned, and supervised. */
type NodeOnlyExtensionField =
  | "framework"
  | "nodeVersion"
  | "packageManager"
  | "appMode"
  | "enabled"
  | "documentRoot"
  | "startupFile"

/**
 * Fields both host-native kinds carry. A container has no principal to run as
 * and no tree to run in; `site` and `node` have exactly one of each.
 */
type HostNativeExtensionField = "cron" | "principal"

/**
 * Spell a field that belongs to a *different* kind, so authoring it is a type
 * error rather than a silently ignored key. Optional-`never` rather than an
 * omission on purpose: it keeps the key present on every union member, which is
 * what lets a caller holding the union still read `extension.engine` and get
 * `SiteEngine | undefined` instead of a property-does-not-exist error.
 */
type NotForThisKind<Field extends keyof ComposeServiceExtensionFields> = {
  [Key in Field]?: never
}

/** The default kind. Runs from an image; everything host-native is off-limits. */
export type ComposeContainerServiceExtension =
  & CommonServiceExtensionFields
  & { serviceKind?: "container" }
  & NotForThisKind<
    SiteOnlyExtensionField | NodeOnlyExtensionField | HostNativeExtensionField
  >

/** Served by a host engine out of a document root. */
export type ComposeSiteServiceExtension =
  & CommonServiceExtensionFields
  & { serviceKind: "site" }
  & Pick<
    ComposeServiceExtensionFields,
    SiteOnlyExtensionField | HostNativeExtensionField
  >
  & NotForThisKind<NodeOnlyExtensionField>

/**
 * A supervised host process built from Git. `source` is **required**, not
 * optional: without one there is nothing to check out, build, or supervise, so
 * a node service without a source is not a node service with a missing hint.
 */
export type ComposeNodeServiceExtension =
  & Omit<CommonServiceExtensionFields, "serviceKind" | "source">
  & { serviceKind: "node"; source: ComposeServiceSourceExtension }
  & Pick<
    ComposeServiceExtensionFields,
    NodeOnlyExtensionField | HostNativeExtensionField
  >
  & NotForThisKind<SiteOnlyExtensionField>

/**
 * The per-service `x-turbopanel` block, narrowed by `serviceKind`.
 *
 * The JSON on the wire is unchanged — still one flat mapping per service. What
 * the union adds is that the type now *says* which fields belong to which kind,
 * instead of being an all-optional bag whose real rules lived only in a
 * separate list of validators. Those validators still run (a document is
 * untyped text until it is parsed), but they now read their answers from
 * {@link SERVICE_KIND_FIELD_TABLE} rather than restating them.
 */
export type ComposeServiceTurbopanelExtension =
  | ComposeContainerServiceExtension
  | ComposeSiteServiceExtension
  | ComposeNodeServiceExtension

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
  extension: ComposeServiceExtensionFields,
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
  extension: ComposeServiceExtensionFields,
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
  // Shape-only, like every other reader here: whether the alias *resolves* is a
  // question about the document as a whole, so the linter answers it
  // (`knownPrincipalAliases`) rather than this per-service parse.
  const principalAlias = readTrimmedString(value.principal)
  if (isPrincipalAlias(principalAlias)) extension.principal = principalAlias.trim()
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
  const hosting = parseHostingExtensionEntries(value.hosting)
  if (hosting) extension.hosting = hosting
}

export function parseServiceTurbopanelExtension(
  value: unknown,
): ComposeServiceTurbopanelExtension | null {
  if (value === null || value === undefined) return {}
  if (!isPlainMapping(value)) return null

  const extension: ComposeServiceExtensionFields = {}
  applyRuntimeExtensionFields(value, extension)
  applyContentExtensionFields(value, extension)
  // Narrowed by assertion, not by re-checking. The union records which keys
  // each kind may carry; whether *this* document respected that is the
  // validator's question, and it answers with a message rather than a silent
  // drop — see `collectServiceTurbopanelValidationIssues`.
  return extension as ComposeServiceTurbopanelExtension
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

/**
 * The one table of "which fields may a service of this kind carry, and what
 * shape may each value take".
 *
 * Both the discriminated union above and every kind-membership check below are
 * statements of this table. They used to live apart — a hand-written
 * all-optional type that said nothing about legality, plus a set of
 * `validate*Consistency` functions that repeated the answer field by field in
 * prose — which is precisely the arrangement that drifts, and the reason a
 * doc could claim `engine` was required while the validator treated it as
 * optional.
 *
 * Only presence and value *shape* live here. The rules that check what a value
 * means — relative-path safety, php.ini directive tables, cron schedule and
 * command parsing — stay in their own validators below, because those answer a
 * different question and their messages come from the module that owns the
 * rule.
 */
type ServiceExtensionFieldRule = {
  /** Kinds the field may be authored on. */
  readonly kinds: readonly ComposeServiceKind[]
  /** Value-shape check, for fields with a closed set of accepted values. */
  readonly isValid?: (value: unknown) => boolean
  /** Message for a value that fails {@link ServiceExtensionFieldRule.isValid}. */
  readonly typeMessage?: string
}

const ALL_SERVICE_KINDS: readonly ComposeServiceKind[] = [
  "container",
  "site",
  "node",
]
const SITE_KIND_ONLY: readonly ComposeServiceKind[] = ["site"]
const NODE_KIND_ONLY: readonly ComposeServiceKind[] = ["node"]
/** Both host-native kinds — the set {@link isHostNativeServiceKind} names. */
const HOST_NATIVE_KINDS: readonly ComposeServiceKind[] = ["site", "node"]

const SERVICE_EXTENSION_FIELDS: Readonly<
  Record<string, ServiceExtensionFieldRule>
> = {
  serviceKind: {
    kinds: ALL_SERVICE_KINDS,
    isValid: (value) => Boolean(readServiceKind(value)),
    typeMessage: 'serviceKind must be "container", "site", or "node"',
  },
  description: { kinds: ALL_SERVICE_KINDS },
  // No kind restriction on *having* a source: a source builds a release for any
  // kind. `buildKind: railpack` is the one combination that contradicts a
  // host-native kind, and `validateSourceConsistency` owns that rule.
  source: { kinds: ALL_SERVICE_KINDS },
  // Legal on every kind: a container behind the edge, a site served by a host
  // engine, and a supervised `node` process can each answer on a hostname. The
  // per-kind rules that *do* exist (`targetPort` is a container question) live
  // in `./hosting-extension.ts`, next to the rest of the block's shape.
  hosting: { kinds: ALL_SERVICE_KINDS },
  engine: {
    kinds: SITE_KIND_ONLY,
    isValid: (value) => Boolean(readSiteEngine(value)),
    typeMessage: 'engine must be "caddy", "apache", "nginx", or "openlitespeed"',
  },
  root: { kinds: SITE_KIND_ONLY },
  sourceKind: { kinds: SITE_KIND_ONLY },
  php: { kinds: SITE_KIND_ONLY },
  cron: { kinds: HOST_NATIVE_KINDS },
  principal: {
    kinds: HOST_NATIVE_KINDS,
    isValid: (value) => isPrincipalAlias(value),
    typeMessage:
      'principal must name an alias declared in x-turbopanel.principals (a letter, then letters, digits, "-", and "_"; at most 64 characters)',
  },
  framework: {
    kinds: NODE_KIND_ONLY,
    isValid: (value) => Boolean(readNativeRuntimeFramework(value)),
    typeMessage: 'framework must be "auto", "node", or "next"',
  },
  nodeVersion: {
    kinds: NODE_KIND_ONLY,
    isValid: (value) => Boolean(readNodeVersion(value)),
    typeMessage: 'nodeVersion must be a pinned version like "24" or "24.17.0"',
  },
  packageManager: {
    kinds: NODE_KIND_ONLY,
    isValid: (value) => Boolean(readNodePackageManager(value)),
    typeMessage: 'packageManager must be "npm", "yarn", or "pnpm"',
  },
  appMode: {
    kinds: NODE_KIND_ONLY,
    isValid: (value) => Boolean(readNodeAppMode(value)),
    typeMessage: 'appMode must be "production" or "development"',
  },
  enabled: {
    kinds: NODE_KIND_ONLY,
    isValid: (value) => typeof value === "boolean",
    typeMessage: "enabled must be true or false",
  },
  documentRoot: { kinds: NODE_KIND_ONLY },
  startupFile: { kinds: NODE_KIND_ONLY },
}

/**
 * Fields a kind must carry to be that kind at all.
 *
 * Only `node` has one, and it is `source` for the reason its union member
 * states: a node service without a repository has nothing to build or run.
 *
 * `principal` is deliberately **not** here for either host-native kind. The
 * document-local alias is only one of the two ways a `site` / `node` service
 * names its account, and it is the newer one: every host-native service
 * authored before `x-turbopanel.principals` existed names no alias at all and
 * is owned by whatever principal an operator assigned in the UI. Requiring the
 * alias in the schema rejects those documents outright at save and at lint,
 * which puts the sole-steward fallback the deploy path still implements
 * permanently out of reach.
 *
 * "This service has nobody to run as" is a real refusal — it is just not a
 * question the document can answer, because the stewards live in the
 * environment rather than in the YAML. It is asked where they are known:
 * `resolveBindingPrincipal` in
 * `../../client/environments/deploy-sources.ts`, which raises
 * `principal_required_for_service_kind` only once the steward lookup has come
 * up empty, and the panel's own `principal-required.ts` /
 * `managed-directory-sites.ts`.
 *
 * What stays here is the half that *is* a document question: `principal` is
 * refused on `container` ({@link SERVICE_EXTENSION_FIELDS}), an authored alias
 * must have alias shape, and the linter resolves it against the document's own
 * `x-turbopanel.principals` map.
 */
const SERVICE_KIND_REQUIRED_FIELDS: Readonly<
  Record<ComposeServiceKind, readonly string[]>
> = {
  container: [],
  site: [],
  node: ["source"],
}

export type ServiceKindFieldRules = {
  readonly allowedFields: ReadonlySet<string>
  readonly requiredFields: ReadonlySet<string>
}

function buildServiceKindFieldTable(): Readonly<
  Record<ComposeServiceKind, ServiceKindFieldRules>
> {
  const table = {} as Record<ComposeServiceKind, ServiceKindFieldRules>
  for (const kind of ALL_SERVICE_KINDS) {
    const allowedFields = new Set<string>()
    for (const [field, rule] of Object.entries(SERVICE_EXTENSION_FIELDS)) {
      if (rule.kinds.includes(kind)) allowedFields.add(field)
    }
    table[kind] = {
      allowedFields,
      requiredFields: new Set(SERVICE_KIND_REQUIRED_FIELDS[kind]),
    }
  }
  return table
}

/**
 * Per-kind view of {@link SERVICE_EXTENSION_FIELDS}, derived rather than
 * written twice. Exported so the UI mirror and its tests can assert against the
 * same answer this module validates with.
 */
export const SERVICE_KIND_FIELD_TABLE: Readonly<
  Record<ComposeServiceKind, ServiceKindFieldRules>
> = buildServiceKindFieldTable()

/**
 * Order the value-shape rules are reported in. Separate from the table's own
 * key order because the two passes read the same facts for different reasons
 * and each has its own natural sequence.
 */
const RAW_FIELD_TYPE_ORDER: readonly string[] = [
  "serviceKind",
  "framework",
  "nodeVersion",
  "packageManager",
  "appMode",
  "enabled",
  "engine",
  "principal",
]

/** `site` / `site or node` / `container, site, or node`, as a message reads. */
function describeKinds(kinds: readonly ComposeServiceKind[]): string {
  if (kinds.length === 1) return kinds[0]
  if (kinds.length === 2) return `${kinds[0]} or ${kinds[1]}`
  return `${kinds.slice(0, -1).join(", ")}, or ${kinds.at(-1)}`
}

/**
 * The membership issue for `field` on `kind`, or `null` when it belongs.
 * The sentence is derived from the table, so it cannot disagree with it.
 */
function kindFieldIssue(
  basePath: string,
  field: string,
  kind: ComposeServiceKind | undefined,
): ServiceTurbopanelValidationIssue | null {
  const rule = SERVICE_EXTENSION_FIELDS[field]
  // An omitted `serviceKind` means `container`, the same default the parser and
  // the daemon read it as.
  if (rule.kinds.includes(kind ?? "container")) return null
  return {
    path: `${basePath}.${field}`,
    message:
      `${field} is only valid when serviceKind is ${describeKinds(rule.kinds)}`,
  }
}

/** Presence checks, not truthiness — `enabled: false` is still authored. */
function kindMembershipIssues(
  basePath: string,
  fields: ComposeServiceExtensionFields,
  checked: readonly string[],
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []
  const present = fields as Record<string, unknown>
  for (const field of checked) {
    if (present[field] === undefined) continue
    const issue = kindFieldIssue(basePath, field, fields.serviceKind)
    if (issue) issues.push(issue)
  }
  return issues
}

/** Node-only fields, in the order an operator sees them reported. */
const NODE_ONLY_FIELD_ORDER: readonly string[] = [
  "framework",
  "nodeVersion",
  "packageManager",
  "appMode",
  "enabled",
  "documentRoot",
  "startupFile",
]

function requiredFieldIssues(
  basePath: string,
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  const kind = fields.serviceKind
  if (kind === undefined) return []

  const issues: ServiceTurbopanelValidationIssue[] = []
  const present = fields as Record<string, unknown>
  for (const field of SERVICE_KIND_FIELD_TABLE[kind].requiredFields) {
    if (present[field] !== undefined) continue
    issues.push({
      path: `${basePath}.${field}`,
      message: `${kind} services require ${field}`,
    })
  }
  return issues
}

function validateRawExtensionFieldTypes(
  basePath: string,
  rawExtension: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(rawExtension)) return []
  const issues: ServiceTurbopanelValidationIssue[] = []

  for (const field of RAW_FIELD_TYPE_ORDER) {
    const rule = SERVICE_EXTENSION_FIELDS[field]
    if (!rule.isValid || !(field in rawExtension)) continue
    if (rule.isValid(rawExtension[field])) continue
    issues.push({
      path: `${basePath}.${field}`,
      message: rule.typeMessage ?? `${field} is not a valid value`,
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
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  const rawPhp = raw.php
  if (rawPhp === undefined) return []

  // Asked of the raw key, not the parsed block: `php: {}` on a container parses
  // to nothing but is still an authored php block, and saying so beats silence.
  const membership = kindFieldIssue(basePath, 'php', fields.serviceKind)
  if (membership) return [membership]

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
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  const jobs = fields.cron
  if (!jobs || jobs.length === 0) return []

  // A container has no principal to run as and no tree to run in; both
  // host-native kinds have exactly one of each — which is what the table says.
  const membership = kindFieldIssue(basePath, "cron", fields.serviceKind)
  if (membership) return [membership]

  const issues: ServiceTurbopanelValidationIssue[] = []
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

/**
 * `x-turbopanel.principal` membership, reported per field.
 *
 * Asked of the *raw* key rather than the parsed value for the same reason
 * `php` is: `principal: 7` on a container parses to nothing but is still an
 * authored ownership claim, and a container has no account to run as. The
 * blanket table check would only say "unknown field"; this says which field and
 * which kinds may carry it.
 *
 * Whether the alias resolves to an entry in the document's
 * `x-turbopanel.principals` is deliberately **not** answered here — that is a
 * whole-document question, and the linter owns it (`knownPrincipalAliases`).
 */
function validatePrincipalConsistency(
  basePath: string,
  raw: Record<string, unknown>,
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  if (raw.principal === undefined) return []
  const membership = kindFieldIssue(basePath, "principal", fields.serviceKind)
  return membership ? [membership] : []
}

function validateEngineConsistency(
  basePath: string,
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  // `engine` is optional on a site and defaults to `caddy` (resolved at the
  // control-plane split, so the daemon never sees it absent). That makes the
  // minimum static site four lines of compose, which is the whole point — the
  // table says site-only, not site-required.
  const issues = kindMembershipIssues(basePath, fields, ["engine", "sourceKind"])

  // A repository-backed site serves the tree the release engine published, so
  // the daemon takes the release branch and the flag would be a lie. Rejected
  // at save rather than silently ignored at deploy: an operator who sets both
  // has a belief about where their content comes from, and one of the two is
  // wrong.
  if (fields.sourceKind === "managed-directory" && fields.source) {
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
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  const issues = [
    ...requiredFieldIssues(basePath, fields),
    ...kindMembershipIssues(basePath, fields, NODE_ONLY_FIELD_ORDER),
  ]

  if (fields.serviceKind !== "node") return issues

  // Both land in daemon-side paths (and startupFile in an ExecStart line), so
  // they share the same relative-path rule as `root`.
  for (const field of ["documentRoot", "startupFile"] as const) {
    const value = fields[field]
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
  fields: ComposeServiceExtensionFields,
  rawService: Record<string, unknown>,
): ServiceTurbopanelValidationIssue[] {
  if (fields.serviceKind !== "node") return []

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
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  if (fields.root === undefined) return []

  const membership = kindFieldIssue(basePath, "root", fields.serviceKind)
  if (membership) return [membership]

  if (isSafeRoot(fields.root)) return []
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
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  const source = fields.source
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
    isHostNativeServiceKind(fields.serviceKind)
  ) {
    issues.push({
      path: `${basePath}.source.buildKind`,
      message:
        "source.buildKind railpack is only valid when serviceKind is container",
    })
  }

  return issues
}

/**
 * `x-turbopanel.hosting` rules, delegated whole to the module that owns the
 * block. Kept as a one-line fold entry rather than inlined for the same reason
 * `validatePhpConsistency` is: the messages come from the module that owns the
 * rule, so they cannot drift from the parser that reads it.
 *
 * Asked of the **raw** mapping, not the parsed extension: a malformed entry is
 * dropped on parse, and silence is exactly the wrong answer for a route an
 * operator believes they declared.
 */
function validateHostingConsistency(
  basePath: string,
  raw: Record<string, unknown>,
  fields: ComposeServiceExtensionFields,
): ServiceTurbopanelValidationIssue[] {
  if (!("hosting" in raw)) return []
  const membership = kindFieldIssue(basePath, "hosting", fields.serviceKind)
  if (membership) return [membership]
  return collectHostingExtensionValidationIssues(
    basePath,
    raw.hosting,
    fields.serviceKind,
  )
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

  // Validators reason over the flat view: their job is deciding whether this
  // document earns one of the union's narrow shapes, so they cannot presume it
  // already has one. Every member widens to it, so this is an assignment.
  const fields: ComposeServiceExtensionFields = parsed

  return [
    ...validateRawExtensionFieldTypes(basePath, rawExtension),
    ...validateEngineConsistency(basePath, fields),
    ...(isPlainMapping(rawExtension)
      ? [
        ...validatePhpConsistency(basePath, rawExtension, fields),
        ...validatePrincipalConsistency(basePath, rawExtension, fields),
        ...validateHostingConsistency(basePath, rawExtension, fields),
      ]
      : []),
    ...validateNodeConsistency(basePath, fields),
    ...validateNodeComposeFields(basePath, fields, rawService),
    ...validateRootConsistency(basePath, fields),
    ...validateSourceConsistency(basePath, fields),
    ...validateCronConsistency(basePath, fields),
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
