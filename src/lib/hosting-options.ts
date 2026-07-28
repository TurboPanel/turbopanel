/** Validated `hosting.options` shape including proxy settings. */

export type HostingProxyOptions = {
  forceHttps?: boolean
  gzip?: boolean
  brotli?: boolean
  stripPrefix?: string
}

export type HostingBindScope = 'public' | 'datacenter' | 'local'

/**
 * `http` (default) routes hostnames through Traefik + hosting Caddy. `tcp` / `udp`
 * publish raw port(s) straight through Traefik — no hostname/TLS routing,
 * used for non-HTTP docker services (e.g. Postgres, a game server, a UDP
 * relay) that need a public/datacenter/local port rather than a hostname.
 */
export type HostingProtocol = 'http' | 'tcp' | 'udp'

/** One published↔target port mapping for `tcp` / `udp` hosting. */
export type HostingPortMapping = {
  /** Host/entrypoint port exposed by Traefik. */
  published: number
  /** Container port the compose service listens on. */
  target: number
}

export type HostingPhpOptions = {
  /**
   * Preferred mod_php package version (e.g. `"8.4"` → `libapache2-mod-php8.4`).
   * Applied on Apache traditional-web deploy; must match a package on the host.
   */
  version?: string
  /** Applied as Apache `php_admin_value memory_limit` (e.g. `"256M"`). */
  memoryLimit?: string
  /** Applied as Apache `php_admin_value max_execution_time` (seconds). */
  maxExecutionTime?: number
}

export type HostingWebOptions = {
  /**
   * Static env vars for host-native web stacks. Hosting-scoped variables with
   * `forRuntime` merge at deploy; these entries override on key collision.
   */
  env?: Record<string, string>
  php?: HostingPhpOptions
}

export type HostingOptions = {
  hostnames?: string[]
  pathPrefix?: string
  targetPort?: number
  proxy?: HostingProxyOptions
  bind?: HostingBindScope
  protocol?: HostingProtocol
  /** Required (non-empty) when `protocol` is `tcp` or `udp`. */
  ports?: HostingPortMapping[]
  web?: HostingWebOptions
}

const MAX_HOSTING_PORTS = 10
const MAX_WEB_ENV_ENTRIES = 64
const MAX_WEB_ENV_VALUE_LENGTH = 4096
export const HOSTING_WEB_ENV_KEY_RE = /^[A-Za-z_]\w*$/
const PHP_VERSION_RE = /^\d+\.\d+$/
const PHP_MEMORY_RE = /^\d+[KMG]?$/i

function isValidPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

const BIND_SCOPES = new Set<HostingBindScope>(['public', 'datacenter', 'local'])

function readOptionalBindScope(value: unknown): HostingBindScope | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!BIND_SCOPES.has(trimmed as HostingBindScope)) return undefined
  return trimmed as HostingBindScope
}

const HOSTING_PROTOCOLS = new Set<HostingProtocol>(['http', 'tcp', 'udp'])

function readOptionalProtocol(value: unknown): HostingProtocol | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!HOSTING_PROTOCOLS.has(trimmed as HostingProtocol)) return undefined
  return trimmed as HostingProtocol
}

function parsePortMapping(value: unknown): HostingPortMapping | undefined {
  if (!isRecord(value)) return undefined
  if (!isValidPortNumber(value.published) || !isValidPortNumber(value.target)) {
    return undefined
  }
  return { published: value.published, target: value.target }
}

/** Parse `options.ports`; invalid/duplicate entries are dropped rather than failing the whole document. */
function parsePorts(value: unknown): HostingPortMapping[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seenPublished = new Set<number>()
  const ports: HostingPortMapping[] = []
  for (const raw of value) {
    if (ports.length >= MAX_HOSTING_PORTS) break
    const mapping = parsePortMapping(raw)
    if (!mapping || seenPublished.has(mapping.published)) continue
    seenPublished.add(mapping.published)
    ports.push(mapping)
  }
  return ports.length > 0 ? ports : undefined
}

function parseHostnames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const hostnames = value.filter(
    (h): h is string => typeof h === 'string' && h.length > 0,
  )
  return hostnames.length > 0 ? hostnames : undefined
}

function parseProxyOptions(value: unknown): HostingProxyOptions | undefined {
  if (!isRecord(value)) return undefined

  const proxy: HostingProxyOptions = {}
  const forceHttps = readOptionalBoolean(value.forceHttps)
  if (forceHttps !== undefined) proxy.forceHttps = forceHttps
  const gzip = readOptionalBoolean(value.gzip)
  if (gzip !== undefined) proxy.gzip = gzip
  const brotli = readOptionalBoolean(value.brotli)
  if (brotli !== undefined) proxy.brotli = brotli
  const stripPrefix = readOptionalString(value.stripPrefix)
  if (stripPrefix) proxy.stripPrefix = stripPrefix

  return Object.keys(proxy).length > 0 ? proxy : undefined
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  return rounded > 0 ? rounded : undefined
}

function parsePhpOptions(value: unknown): HostingPhpOptions | undefined {
  if (!isRecord(value)) return undefined
  const php: HostingPhpOptions = {}
  const version = readOptionalString(value.version)
  if (version && PHP_VERSION_RE.test(version)) php.version = version
  const memoryLimit = readOptionalString(value.memoryLimit)
  if (memoryLimit && PHP_MEMORY_RE.test(memoryLimit)) php.memoryLimit = memoryLimit
  const maxExecutionTime = readOptionalPositiveInt(value.maxExecutionTime)
  if (maxExecutionTime !== undefined) php.maxExecutionTime = maxExecutionTime
  return Object.keys(php).length > 0 ? php : undefined
}

function sanitizeParsedWebEnv(raw: Record<string, string>): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_WEB_ENV_VALUE_LENGTH) continue
    env[key] = trimmed
    if (Object.keys(env).length >= MAX_WEB_ENV_ENTRIES) break
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function parseWebEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const raw: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    if (typeof entry !== 'string') continue
    raw[key] = entry
  }
  return sanitizeParsedWebEnv(raw)
}

function parseWebOptions(value: unknown): HostingWebOptions | undefined {
  if (!isRecord(value)) return undefined
  const web: HostingWebOptions = {}
  const env = parseWebEnv(value.env)
  if (env) web.env = env
  const php = parsePhpOptions(value.php)
  if (php) web.php = php
  return Object.keys(web).length > 0 ? web : undefined
}

export function parseHostingOptions(value: unknown): HostingOptions | null {
  if (value === null || value === undefined) return {}
  if (!isRecord(value)) return null

  const options: HostingOptions = {}

  const hostnames = parseHostnames(value.hostnames)
  if (hostnames) options.hostnames = hostnames

  const pathPrefix = readOptionalString(value.pathPrefix)
  if (pathPrefix) options.pathPrefix = pathPrefix

  if (typeof value.targetPort === 'number' && Number.isFinite(value.targetPort)) {
    options.targetPort = value.targetPort
  }

  const proxy = parseProxyOptions(value.proxy)
  if (proxy) options.proxy = proxy

  const bind = readOptionalBindScope(value.bind)
  if (bind) options.bind = bind

  const protocol = readOptionalProtocol(value.protocol)
  if (protocol) options.protocol = protocol

  const ports = parsePorts(value.ports)
  if (ports) options.ports = ports

  const web = parseWebOptions(value.web)
  if (web) options.web = web

  return options
}

/** Defaults to `'http'` when unset/invalid — the only protocol prior to `tcp`/`udp` support. */
export function resolveHostingProtocol(
  options: HostingOptions | null | undefined,
): HostingProtocol {
  return options?.protocol ?? 'http'
}

export function resolveHostingProxy(options: HostingOptions | null | undefined): Required<
  Pick<HostingProxyOptions, 'forceHttps' | 'gzip' | 'brotli'>
> & Pick<HostingProxyOptions, 'stripPrefix'> {
  const proxy = options?.proxy
  return {
    forceHttps: proxy?.forceHttps ?? true,
    gzip: proxy?.gzip ?? true,
    brotli: proxy?.brotli ?? false,
    stripPrefix: proxy?.stripPrefix,
  }
}

export function resolveHostingBind(
  options: HostingOptions | null | undefined,
): HostingBindScope {
  return options?.bind ?? 'public'
}
