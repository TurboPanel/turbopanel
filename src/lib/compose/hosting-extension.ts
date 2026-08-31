/**
 * Per-service **authored** ingress (`services.<name>.x-turbopanel.hosting`).
 *
 * ## What this is, and what it is emphatically not
 *
 * `hosting` declares an **ingress route** — a hostname (optionally a path
 * prefix) that TurboPanel's edge answers on, terminated with TLS and forwarded
 * to the service. It is never a `--publish`. Compose's own `ports:` binds a
 * host port straight onto a container and stays exactly what it always was; a
 * `hosting` entry opens no host port at all, and the two are not
 * interchangeable in either direction:
 *
 * - `ports:` is the answer for "this container must own host port 5432".
 * - `hosting` is the answer for "https://app.example.com should reach this
 *   service" — the edge owns 80/443 and routes by name.
 *
 * A raw TCP/UDP publish through the edge is a third thing again
 * (`hosting.options.protocol` on the row, `tcp` / `udp`), authored from the
 * panel rather than from compose. {@link HOSTING_KEY_REDIRECTS} says all of
 * this out loud for every key an author plausibly reaches for.
 *
 * ## Shape only
 *
 * Like every other parser in this directory, this module is pure and
 * database-free. It answers "is this a well-formed ingress declaration"; it
 * does **not** answer "does `certificateRef` name a certificate this
 * organization owns". That resolution splits the same way
 * `x-turbopanel.source.sourceId` does: the linter checks it when a caller hands
 * it the set (`knownTlsIds` / `knownIpIds` in `./lint.ts`), and deploy-prepare
 * is the backstop that refuses rather than silently nulling
 * (`../../client/environments/reconcile-hostings.ts` →
 * `hosting_tls_ref_unresolved` / `hosting_ip_ref_unresolved`).
 */

import type {
  ComposeServiceKind,
  ServiceTurbopanelValidationIssue,
} from './service-kind.ts'

/**
 * How the edge terminates TLS for one authored hostname.
 *
 * `automatic` is **named but not yet deployable** — see
 * {@link HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE}. It stays in the type
 * (and in {@link HOSTING_TLS_MODES}) so an author who writes it hears the real
 * reason rather than "unknown mode", and so the reconcile can refuse it instead
 * of parsing it away into a route that silently terminates with a self-signed
 * certificate.
 */
export type ComposeHostingTlsMode = 'automatic' | 'internal' | 'certificate'

export const HOSTING_TLS_MODES: readonly ComposeHostingTlsMode[] = [
  'automatic',
  'internal',
  'certificate',
]

/**
 * Default when `tls` is omitted — the self-signed certificate the edge
 * terminates with today.
 *
 * Deliberately **not** `automatic`: the deploy payload carries exactly one TLS
 * knob (`EnvironmentDeployHosting.tlsId` — a resolved pin, or null meaning
 * Caddy `tls internal`), so there is no wire spelling for "obtain one for me".
 * A default naming a mode the deploy cannot perform would promise managed
 * certificates and hand back self-signed ones, so the omitted case names what
 * actually happens.
 */
export const DEFAULT_HOSTING_TLS_MODE: ComposeHostingTlsMode = 'internal'

/**
 * Which address family the route listens on. Mirrors `HostingBindScope` in
 * `../hosting-options.ts`, which is the shape actually stored on the row.
 */
export type ComposeHostingBindScope = 'public' | 'datacenter' | 'local'

export const HOSTING_BIND_SCOPES: readonly ComposeHostingBindScope[] = [
  'public',
  'datacenter',
  'local',
]

/** Default when `bind` is omitted — the same default `resolveHostingBind` reads. */
export const DEFAULT_HOSTING_BIND_SCOPE: ComposeHostingBindScope = 'public'

/** Default when `pathPrefix` is omitted — the whole hostname. */
export const DEFAULT_HOSTING_PATH_PREFIX = '/'

/** DNS name length ceiling, so an over-long hostname is reported, not stored. */
export const HOSTING_HOSTNAME_MAX_LENGTH = 253

/** Ceiling for `pathPrefix`, matching the relative-path rule `root` uses. */
export const HOSTING_PATH_PREFIX_MAX_LENGTH = 200

/** Ceiling for a `certificateRef` / `ipRef` — a name or a UUID, never a blob. */
export const HOSTING_REF_MAX_LENGTH = 255

/**
 * Most routes one service may declare. Not a platform limit — a guard against
 * a generated document quietly minting hundreds of `hosting` rows per deploy.
 */
export const MAX_HOSTING_ENTRIES_PER_SERVICE = 20

/**
 * One label, or a leading `*` wildcard label. Deliberately narrower than the
 * RFC: the value ends up in an edge router rule and a certificate SAN, so the
 * safe direction is to accept what real hostnames use and report the rest.
 */
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
export const HOSTING_HOSTNAME_RE: RegExp = new RegExp(
  String.raw`^(?:\*\.)?${HOSTNAME_LABEL}(?:\.${HOSTNAME_LABEL})*$`,
  'i',
)

/** `tls` on one entry. `certificateRef` is required by `certificate` alone. */
export type ComposeHostingTlsSpec = {
  mode: ComposeHostingTlsMode
  /**
   * A `tls` row in the caller's organization, named by **id or name**. Shape
   * only here — resolution is the linter's (`knownTlsIds`) and deploy-prepare's.
   */
  certificateRef?: string
}

/** `bind` on one entry — which listen address the route is published on. */
export type ComposeHostingBindSpec = {
  scope: ComposeHostingBindScope
  /**
   * An `ip` row in the caller's organization, named by **id or address**.
   * Shape only here, same split as {@link ComposeHostingTlsSpec.certificateRef}.
   */
  ipRef?: string
}

/**
 * One entry in `x-turbopanel.hosting`.
 *
 * Identity is `(hostname, pathPrefix)` within the service — that pair is what
 * `reconcileHostingsFromCompose` upserts a `hosting` row on, which is why two
 * entries sharing it are reported rather than last-wins merged.
 */
export type ComposeHostingExtensionEntry = {
  /** The name the edge answers on. Lowercased on parse. */
  hostname: string
  /** Route prefix under the hostname. Omitted means {@link DEFAULT_HOSTING_PATH_PREFIX}. */
  pathPrefix?: string
  /**
   * Port inside the service the edge forwards to.
   *
   * Required in practice on a `container` whose ports are ambiguous, but that
   * is a *deploy-time* question — compose-level parsing cannot see the merged
   * ports list, so it is not enforced here. **Refused on `site` and `node`**:
   * both are host-native lanes answered by a process on a loopback port
   * TurboPanel allocates, so naming one is not "ignored" — it is a second
   * source of truth for a port the platform owns, and the honest answer is to
   * report it. {@link hostingTargetPortAuthorable} is the one place that says
   * which kinds may author it.
   */
  targetPort?: number
  /** Redirect plain HTTP to HTTPS. Omitted means the row default (`true`). */
  forceHttps?: boolean
  tls?: ComposeHostingTlsSpec
  bind?: ComposeHostingBindSpec
}

/** Keys one `hosting[]` entry may carry. Anything else is reported. */
export const HOSTING_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'hostname',
  'pathPrefix',
  'targetPort',
  'forceHttps',
  'tls',
  'bind',
])

/** Keys a `hosting[].tls` block may carry. */
export const HOSTING_TLS_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'certificateRef',
])

/** Keys a `hosting[].bind` block may carry. */
export const HOSTING_BIND_KEYS: ReadonlySet<string> = new Set([
  'scope',
  'ipRef',
])

/** The one sentence for "an ingress route is not a port publish". */
export const HOSTING_NOT_A_PUBLISH_MESSAGE =
  'x-turbopanel.hosting declares an ingress route, not a port publish; use the service ports: list to bind a host port'

/**
 * Keys refused with a pointer rather than a bare "unknown".
 *
 * Same contract as `ROOT_KEY_REDIRECTS` in `./root-extension.ts`: each of these
 * is a real concept an author might expect to write here, and the message's job
 * is to name where it actually lives so the answer is "over there", not "no".
 */
export const HOSTING_KEY_REDIRECTS: Readonly<Record<string, string>> = {
  ports: HOSTING_NOT_A_PUBLISH_MESSAGE,
  publish: HOSTING_NOT_A_PUBLISH_MESSAGE,
  protocol:
    'protocol is not authored in compose; raw tcp/udp ingress is a hosting row setting (hosting.options.protocol)',
  certificate:
    'certificate is not authored in compose; pin one with tls.certificateRef and keep the material on the tls row',
  certificatePem:
    'certificatePem is not authored in compose; certificate material lives on the tls table',
  privateKeyPem:
    'privateKeyPem is not authored in compose; certificate material lives on the tls table',
  ip: 'ip is not authored in compose; name a managed address with bind.ipRef',
  ipId: 'ipId is not authored in compose; name a managed address with bind.ipRef',
  tlsId:
    'tlsId is not authored in compose; name an organization certificate with tls.certificateRef',
  web:
    'web is not authored in compose; static web env and PHP hints live on the hosting row (hosting.options.web)',
  php:
    'php is not authored in compose here; PHP belongs to the service block (x-turbopanel.php)',
  gzip: 'gzip is not authored in compose; proxy toggles live on the hosting row',
  brotli: 'brotli is not authored in compose; proxy toggles live on the hosting row',
  stripPrefix:
    'stripPrefix is not authored in compose; proxy toggles live on the hosting row',
}

/** Message for a `hosting[]` entry with no usable hostname. */
export const HOSTING_HOSTNAME_REQUIRED_MESSAGE =
  `hostname is required and must be a DNS name like "app.example.com" or "*.example.com" (at most ${HOSTING_HOSTNAME_MAX_LENGTH} characters)`

/** Message for `targetPort` on a `site`, where the daemon owns the port. */
export const HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE =
  'targetPort is not valid on a site service; the daemon allocates the engine listen port'

/** Message for `targetPort` on a `node`, where the daemon owns the port. */
export const HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE =
  'targetPort is not valid on a node service; the daemon allocates the app listen port'

/**
 * Message for `tls.mode: automatic`, which nothing downstream can perform yet.
 *
 * The deploy payload's only TLS field is a resolved certificate id, so the two
 * outcomes a route can actually have are "this pinned certificate" and "Caddy
 * `tls internal`". Accepting `automatic` and materializing the second is a
 * silent downgrade of the one setting an operator was most explicit about —
 * the same failure {@link hostingTlsRefUnresolvedMessage} exists to prevent —
 * so it is refused at save time and again at deploy-prepare.
 */
export const HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE =
  'tls.mode "automatic" is not supported yet; use "internal" for a self-signed certificate, or "certificate" with tls.certificateRef to pin one from this organization'

/** Message for an out-of-range or non-integer `targetPort`. */
export const HOSTING_TARGET_PORT_RANGE_MESSAGE =
  'targetPort must be an integer between 1 and 65535'

/** Message for a `pathPrefix` that is not an absolute, traversal-free path. */
export const HOSTING_PATH_PREFIX_MESSAGE =
  `pathPrefix must start with "/" and contain no whitespace or ".." (at most ${HOSTING_PATH_PREFIX_MAX_LENGTH} characters)`

export function hostingTlsRefUnresolvedMessage(ref: string): string {
  return `certificate '${ref}' was not found for this organization`
}

export function hostingIpRefUnresolvedMessage(ref: string): string {
  return `ip '${ref}' was not found for this organization`
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isHostingTlsMode(value: unknown): value is ComposeHostingTlsMode {
  return typeof value === 'string' &&
    (HOSTING_TLS_MODES as readonly string[]).includes(value)
}

export function isHostingBindScope(
  value: unknown,
): value is ComposeHostingBindScope {
  return typeof value === 'string' &&
    (HOSTING_BIND_SCOPES as readonly string[]).includes(value)
}

/** A DNS name this platform will route on, lowercased, or nothing. */
export function readHostingHostname(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > HOSTING_HOSTNAME_MAX_LENGTH) {
    return undefined
  }
  return HOSTING_HOSTNAME_RE.test(trimmed) ? trimmed : undefined
}

/** An absolute, traversal-free route prefix, or nothing. */
export function readHostingPathPrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > HOSTING_PATH_PREFIX_MAX_LENGTH) {
    return undefined
  }
  if (!trimmed.startsWith('/')) return undefined
  if (trimmed.includes('..')) return undefined
  if (/\s/.test(trimmed)) return undefined
  return trimmed
}

function readHostingTargetPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 1 && value <= 65535 ? value : undefined
}

function readHostingRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > HOSTING_REF_MAX_LENGTH) {
    return undefined
  }
  return trimmed
}

function parseHostingTlsSpec(value: unknown): ComposeHostingTlsSpec | undefined {
  if (!isPlainMapping(value)) return undefined
  if (!isHostingTlsMode(value.mode)) return undefined
  const spec: ComposeHostingTlsSpec = { mode: value.mode }
  const certificateRef = readHostingRef(value.certificateRef)
  if (certificateRef && spec.mode === 'certificate') {
    spec.certificateRef = certificateRef
  }
  return spec
}

function parseHostingBindSpec(value: unknown): ComposeHostingBindSpec | undefined {
  if (!isPlainMapping(value)) return undefined
  if (!isHostingBindScope(value.scope)) return undefined
  const spec: ComposeHostingBindSpec = { scope: value.scope }
  const ipRef = readHostingRef(value.ipRef)
  if (ipRef) spec.ipRef = ipRef
  return spec
}

function parseHostingEntry(
  value: unknown,
): ComposeHostingExtensionEntry | undefined {
  if (!isPlainMapping(value)) return undefined
  const hostname = readHostingHostname(value.hostname)
  if (!hostname) return undefined

  const entry: ComposeHostingExtensionEntry = { hostname }
  const pathPrefix = readHostingPathPrefix(value.pathPrefix)
  if (pathPrefix) entry.pathPrefix = pathPrefix
  const targetPort = readHostingTargetPort(value.targetPort)
  if (targetPort !== undefined) entry.targetPort = targetPort
  // `false` must survive the round-trip — never a truthiness guard here.
  if (typeof value.forceHttps === 'boolean') entry.forceHttps = value.forceHttps
  const tls = parseHostingTlsSpec(value.tls)
  if (tls) entry.tls = tls
  const bind = parseHostingBindSpec(value.bind)
  if (bind) entry.bind = bind
  return entry
}

/**
 * Permissive read, matching every other parser in this directory: anything
 * malformed is **dropped** rather than thrown, so a bad document still opens in
 * the editor. {@link collectHostingExtensionValidationIssues} is the strict
 * pass that turns the same input into operator-facing messages at save time.
 *
 * Duplicate `(hostname, pathPrefix)` pairs collapse to the first entry here —
 * the validator is where the author hears about the second one.
 */
export function parseHostingExtensionEntries(
  value: unknown,
): ComposeHostingExtensionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  const entries: ComposeHostingExtensionEntry[] = []
  for (const raw of value) {
    if (entries.length >= MAX_HOSTING_ENTRIES_PER_SERVICE) break
    const entry = parseHostingEntry(raw)
    if (!entry) continue
    const key = hostingEntryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries.length > 0 ? entries : undefined
}

/** The prefix an entry routes on, resolving the omitted case. */
export function hostingPathPrefixOf(
  entry: Pick<ComposeHostingExtensionEntry, 'pathPrefix'>,
): string {
  return entry.pathPrefix ?? DEFAULT_HOSTING_PATH_PREFIX
}

/** The TLS mode an entry asks for, resolving the omitted case. */
export function hostingTlsModeOf(
  entry: ComposeHostingExtensionEntry,
): ComposeHostingTlsMode {
  return entry.tls?.mode ?? DEFAULT_HOSTING_TLS_MODE
}

/** The bind scope an entry asks for, resolving the omitted case. */
export function hostingBindScopeOf(
  entry: ComposeHostingExtensionEntry,
): ComposeHostingBindScope {
  return entry.bind?.scope ?? DEFAULT_HOSTING_BIND_SCOPE
}

/**
 * The `(hostname, pathPrefix)` identity a `hosting` row is keyed on.
 *
 * One function rather than an inline template at each site: the parser's
 * dedupe, the validator's duplicate report, and deploy-prepare's upsert all
 * have to agree on what "the same route" means, and any of them spelling it
 * separately is how the three drift.
 */
export function hostingEntryKey(
  entry: Pick<ComposeHostingExtensionEntry, 'hostname' | 'pathPrefix'>,
): string {
  return `${entry.hostname} ${hostingPathPrefixOf(entry)}`
}

/**
 * Strict, save-time validation of one service's `hosting` list.
 *
 * `basePath` is the dotted path of the per-service extension
 * (`services.<name>.x-turbopanel`), so issue paths read
 * `services.web.x-turbopanel.hosting[0].tls.certificateRef`.
 */
export function collectHostingExtensionValidationIssues(
  basePath: string,
  value: unknown,
  serviceKind: ComposeServiceKind | undefined,
): ServiceTurbopanelValidationIssue[] {
  const path = `${basePath}.hosting`
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    return [{ path, message: 'hosting must be a list of ingress entries' }]
  }
  if (value.length > MAX_HOSTING_ENTRIES_PER_SERVICE) {
    return [{
      path,
      message:
        `hosting must declare at most ${MAX_HOSTING_ENTRIES_PER_SERVICE} entries`,
    }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const entryPath = `${path}[${index}]`
    if (!isPlainMapping(raw)) {
      issues.push({ path: entryPath, message: 'hosting entry must be a mapping' })
      continue
    }
    issues.push(...validateHostingEntry(entryPath, raw, serviceKind))

    const hostname = readHostingHostname(raw.hostname)
    if (!hostname) continue
    const pathPrefix = readHostingPathPrefix(raw.pathPrefix)
    const key = hostingEntryKey(
      pathPrefix ? { hostname, pathPrefix } : { hostname },
    )
    if (seen.has(key)) {
      issues.push({
        path: entryPath,
        message: `hosting already declares ${hostname}${
          pathPrefix ?? DEFAULT_HOSTING_PATH_PREFIX
        } on this service; one route is one entry`,
      })
      continue
    }
    seen.add(key)
  }
  return issues
}

function validateHostingEntry(
  entryPath: string,
  raw: Record<string, unknown>,
  serviceKind: ComposeServiceKind | undefined,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  for (const key of Object.keys(raw)) {
    if (HOSTING_ENTRY_KEYS.has(key)) continue
    issues.push({
      path: `${entryPath}.${key}`,
      message: HOSTING_KEY_REDIRECTS[key] ?? unknownHostingKeyMessage(key),
    })
  }

  if (!readHostingHostname(raw.hostname)) {
    issues.push({
      path: `${entryPath}.hostname`,
      message: HOSTING_HOSTNAME_REQUIRED_MESSAGE,
    })
  }

  if ('pathPrefix' in raw && !readHostingPathPrefix(raw.pathPrefix)) {
    issues.push({
      path: `${entryPath}.pathPrefix`,
      message: HOSTING_PATH_PREFIX_MESSAGE,
    })
  }

  issues.push(...validateHostingTargetPort(entryPath, raw, serviceKind))

  if ('forceHttps' in raw && typeof raw.forceHttps !== 'boolean') {
    issues.push({
      path: `${entryPath}.forceHttps`,
      message: 'forceHttps must be true or false',
    })
  }

  if ('tls' in raw) issues.push(...validateHostingTls(entryPath, raw.tls))
  if ('bind' in raw) issues.push(...validateHostingBind(entryPath, raw.bind))

  return issues
}

/**
 * Which service kinds may author `targetPort`.
 *
 * Only `container`: a site and a node app are both answered by a host process
 * on a loopback port TurboPanel allocates and the daemon reads back off
 * `sites[]` / `nativeAppServices[]`, so an authored port there is not a
 * forwarding target — it is a competing claim on an allocation the platform
 * owns. An unknown kind is treated as a container, matching every other rule
 * here: absent `serviceKind` means the compose default.
 */
export function hostingTargetPortAuthorable(
  serviceKind: ComposeServiceKind | undefined,
): boolean {
  return serviceKind !== 'site' && serviceKind !== 'node'
}

/**
 * `targetPort` is a container question.
 *
 * A `site` or a `node` app is served on a port the daemon allocates, so naming
 * one there is a belief about the deploy that is simply wrong — reported, not
 * ignored. On a container it is optional at *save* time on purpose: whether the
 * service's merged ports resolve to one unambiguous target is a deploy-time
 * question this pure pass cannot see.
 */
function validateHostingTargetPort(
  entryPath: string,
  raw: Record<string, unknown>,
  serviceKind: ComposeServiceKind | undefined,
): ServiceTurbopanelValidationIssue[] {
  if (!('targetPort' in raw)) return []
  const path = `${entryPath}.targetPort`
  if (!hostingTargetPortAuthorable(serviceKind)) {
    return [{
      path,
      message: serviceKind === 'site'
        ? HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE
        : HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
    }]
  }
  if (readHostingTargetPort(raw.targetPort) === undefined) {
    return [{ path, message: HOSTING_TARGET_PORT_RANGE_MESSAGE }]
  }
  return []
}

function validateHostingTls(
  entryPath: string,
  value: unknown,
): ServiceTurbopanelValidationIssue[] {
  const path = `${entryPath}.tls`
  if (!isPlainMapping(value)) {
    return [{ path, message: 'tls must be a mapping' }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const key of Object.keys(value)) {
    if (HOSTING_TLS_KEYS.has(key)) continue
    issues.push({
      path: `${path}.${key}`,
      message: HOSTING_KEY_REDIRECTS[key] ?? unknownTlsKeyMessage(key),
    })
  }

  if (!isHostingTlsMode(value.mode)) {
    issues.push({
      path: `${path}.mode`,
      message: 'tls.mode must be "automatic", "internal", or "certificate"',
    })
  } else if (value.mode === 'automatic') {
    issues.push({
      path: `${path}.mode`,
      message: HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
    })
  }

  const certificateRef = readHostingRef(value.certificateRef)
  if (value.mode === 'certificate') {
    if (!certificateRef) {
      issues.push({
        path: `${path}.certificateRef`,
        message:
          'tls.certificateRef is required when tls.mode is "certificate"; name a certificate in this organization by id or name',
      })
    }
  } else if ('certificateRef' in value) {
    issues.push({
      path: `${path}.certificateRef`,
      message: 'tls.certificateRef is only valid when tls.mode is "certificate"',
    })
  }

  return issues
}

function validateHostingBind(
  entryPath: string,
  value: unknown,
): ServiceTurbopanelValidationIssue[] {
  const path = `${entryPath}.bind`
  if (!isPlainMapping(value)) {
    return [{ path, message: 'bind must be a mapping' }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const key of Object.keys(value)) {
    if (HOSTING_BIND_KEYS.has(key)) continue
    issues.push({
      path: `${path}.${key}`,
      message: HOSTING_KEY_REDIRECTS[key] ?? unknownBindKeyMessage(key),
    })
  }

  if (!isHostingBindScope(value.scope)) {
    issues.push({
      path: `${path}.scope`,
      message: 'bind.scope must be "public", "datacenter", or "local"',
    })
  }

  if ('ipRef' in value && !readHostingRef(value.ipRef)) {
    issues.push({
      path: `${path}.ipRef`,
      message:
        `bind.ipRef must name a managed address in this organization by id or address (at most ${HOSTING_REF_MAX_LENGTH} characters)`,
    })
  }

  return issues
}

function sortedKeys(keys: ReadonlySet<string>): string {
  return [...keys].sort((a, b) => a.localeCompare(b)).join(', ')
}

function unknownHostingKeyMessage(key: string): string {
  return `unknown hosting key "${key}"; supported: ${
    sortedKeys(HOSTING_ENTRY_KEYS)
  }`
}

function unknownTlsKeyMessage(key: string): string {
  return `unknown tls key "${key}"; supported: ${sortedKeys(HOSTING_TLS_KEYS)}`
}

function unknownBindKeyMessage(key: string): string {
  return `unknown bind key "${key}"; supported: ${sortedKeys(HOSTING_BIND_KEYS)}`
}
