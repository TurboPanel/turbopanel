/**
 * Operator-settable PHP directives, as a table.
 *
 * **Security property, preserved from the original accept-list:** validate,
 * then *drop* — never escape, never interpolate. A value that fails its spec
 * does not reach the rendered pool or vhost at all, so there is no escaping
 * bug to have. Every value here ends up in a php-fpm pool as
 * `php_admin_value[k] = v` or in an OpenLiteSpeed vhost as
 * `php_admin_value k v`, both of which are line-oriented and unquoted.
 *
 * Mirrored by the daemon (`src/deploy/site.ts`), which re-validates at the wire
 * boundary rather than trusting this. Divergence degrades to "control plane
 * accepted, daemon dropped" — visible, never exploitable. A shared fixture list
 * in both test suites is what catches drift.
 */

/** Ceiling for byte-valued directives — one tenant must not claim the box. */
export const PHP_MAX_BYTES_MB = 2048

const BYTES_RE = /^\d+[KMG]?$/i
const NAME_RE = /^[a-z_][a-z0-9_]*$/i

export type PhpSettingSpec =
  | { kind: 'bytes'; maxMb?: number }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'timezone' }
  | { kind: 'nameList' }
  | { kind: 'token'; pattern: RegExp }

/**
 * Deliberately absent, with reasons — do not add without re-reading these:
 *
 * - `open_basedir` — platform-computed from the release layout; an operator
 *   value would undo release confinement.
 * - `error_log` — must stay platform-owned so logs land where the log pipeline
 *   reads them.
 * - `extension` / `zend_extension` — extensions are installed, not declared
 *   here, and a duplicate opcache load aborts startup.
 * - `auto_prepend_file` / `auto_append_file` / `include_path` / `sys_temp_dir`
 *   / `upload_tmp_dir` — paths that interact with `open_basedir`; they need a
 *   "must resolve inside the site tree" rule before they can be safe.
 */
export const PHP_SETTINGS: Readonly<Record<string, PhpSettingSpec>> = {
  memory_limit: { kind: 'bytes' },
  upload_max_filesize: { kind: 'bytes' },
  post_max_size: { kind: 'bytes' },

  max_execution_time: { kind: 'int', min: 1, max: 600 },
  max_input_time: { kind: 'int', min: -1, max: 600 },
  max_input_vars: { kind: 'int', min: 1, max: 10_000 },
  max_file_uploads: { kind: 'int', min: 0, max: 200 },
  default_socket_timeout: { kind: 'int', min: 1, max: 300 },
  'session.gc_maxlifetime': { kind: 'int', min: 60, max: 604_800 },

  display_errors: { kind: 'bool' },
  display_startup_errors: { kind: 'bool' },
  log_errors: { kind: 'bool' },
  allow_url_fopen: { kind: 'bool' },
  file_uploads: { kind: 'bool' },
  expose_php: { kind: 'bool' },
  short_open_tag: { kind: 'bool' },
  'session.cookie_secure': { kind: 'bool' },
  'session.cookie_httponly': { kind: 'bool' },
  'session.use_strict_mode': { kind: 'bool' },
  'opcache.enable': { kind: 'bool' },

  // Named levels only. An arbitrary `E_ALL & ~E_DEPRECATED` expression is a
  // tiny language, and accepting one means parsing it safely.
  error_reporting: { kind: 'enum', values: ['production', 'development', 'all'] },
  'session.cookie_samesite': { kind: 'enum', values: ['Lax', 'Strict', 'None'] },

  'date.timezone': { kind: 'timezone' },
  disable_functions: { kind: 'nameList' },
  'session.name': { kind: 'token', pattern: /^[A-Za-z0-9_]{1,64}$/ },
}

/** `error_reporting` levels, expanded to the literal PHP constant expression. */
const ERROR_REPORTING_LEVELS: Readonly<Record<string, string>> = {
  production: 'E_ALL & ~E_DEPRECATED & ~E_STRICT',
  development: 'E_ALL',
  all: 'E_ALL',
}

function parseBytes(raw: string, maxMb: number): string | undefined {
  if (!BYTES_RE.test(raw)) return undefined
  const unit = raw.slice(-1).toUpperCase()
  const digits = /^\d+$/.test(raw) ? raw : raw.slice(0, -1)
  const n = Number(digits)
  if (!Number.isFinite(n)) return undefined
  const mb = unit === 'G' ? n * 1024 : unit === 'K' ? n / 1024 : unit === 'M' ? n : n / 1_048_576
  if (mb > maxMb) return undefined
  return raw
}

/** Shape gate before the runtime check — keeps odd input out of Intl. */
const TIMEZONE_SHAPE_RE = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/

/**
 * Ask the runtime, rather than matching a regex or a canonical list.
 *
 * `Intl.supportedValuesOf('timeZone')` returns **canonical zones only** — it
 * omits `UTC`, `Etc/UTC`, and `GMT`, which PHP accepts and which are the most
 * likely values an operator types. Constructing a formatter accepts those
 * aliases and still throws on `Foo/Bar`, which is regex-shaped but not a zone.
 */
function isKnownTimezone(value: string): boolean {
  if (!TIMEZONE_SHAPE_RE.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Validate one directive. Returns the rendered value, or `undefined` when the
 * key is unknown or the value fails its spec — the caller drops it.
 */
export function validatePhpSetting(
  key: string,
  raw: unknown,
): string | undefined {
  const spec = PHP_SETTINGS[key]
  if (!spec) return undefined
  const value = typeof raw === 'number' ? String(raw) : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 512) return undefined
  // Nothing here is ever multi-line: both render targets are line-oriented.
  if (/[\r\n]/.test(trimmed)) return undefined

  switch (spec.kind) {
    case 'bytes':
      return parseBytes(trimmed, spec.maxMb ?? PHP_MAX_BYTES_MB)
    case 'int': {
      if (!/^-?\d+$/.test(trimmed)) return undefined
      const n = Number(trimmed)
      return n >= spec.min && n <= spec.max ? String(n) : undefined
    }
    case 'bool': {
      const lower = trimmed.toLowerCase()
      if (['on', '1', 'true', 'yes'].includes(lower)) return 'On'
      if (['off', '0', 'false', 'no'].includes(lower)) return 'Off'
      return undefined
    }
    case 'enum': {
      if (!spec.values.includes(trimmed)) return undefined
      return ERROR_REPORTING_LEVELS[trimmed] !== undefined && key === 'error_reporting'
        ? ERROR_REPORTING_LEVELS[trimmed]
        : trimmed
    }
    case 'timezone':
      return isKnownTimezone(trimmed) ? trimmed : undefined
    case 'nameList': {
      const names = trimmed.split(',').map((n) => n.trim()).filter((n) => n.length > 0)
      if (names.length === 0 || names.length > 128) return undefined
      return names.every((n) => NAME_RE.test(n)) ? names.join(',') : undefined
    }
    case 'token':
      return spec.pattern.test(trimmed) ? trimmed : undefined
  }
}

/** Pool directives (not `php_admin_value`) an operator may tune. */
export const PHP_POOL_SETTINGS: Readonly<Record<string, PhpSettingSpec>> = {
  pm: { kind: 'enum', values: ['static', 'ondemand', 'dynamic'] },
  // A ceiling, not just a range: an unbounded worker count is a host DoS.
  'pm.max_children': { kind: 'int', min: 1, max: 100 },
  'pm.start_servers': { kind: 'int', min: 1, max: 100 },
  'pm.min_spare_servers': { kind: 'int', min: 1, max: 100 },
  'pm.max_spare_servers': { kind: 'int', min: 1, max: 100 },
  'pm.max_requests': { kind: 'int', min: 0, max: 10_000 },
  'pm.process_idle_timeout': { kind: 'token', pattern: /^\d{1,4}s$/ },
  // The real runaway killer: max_execution_time does not count time spent
  // inside system calls, so a wedged request can outlive it indefinitely.
  request_terminate_timeout: { kind: 'int', min: 0, max: 600 },
}

export function validatePhpPoolSetting(
  key: string,
  raw: unknown,
): string | undefined {
  const spec = PHP_POOL_SETTINGS[key]
  if (!spec) return undefined
  const value = typeof raw === 'number' ? String(raw) : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) return undefined
  switch (spec.kind) {
    case 'enum':
      return spec.values.includes(trimmed) ? trimmed : undefined
    case 'int': {
      if (!/^\d+$/.test(trimmed)) return undefined
      const n = Number(trimmed)
      return n >= spec.min && n <= spec.max ? String(n) : undefined
    }
    case 'token':
      return spec.pattern.test(trimmed) ? trimmed : undefined
    default:
      return undefined
  }
}

/**
 * Render a compose `x-turbopanel.php` block into the validated wire shape.
 *
 * Every value goes through {@link validatePhpSetting} /
 * {@link validatePhpPoolSetting} and is **dropped** if it fails — the same
 * validate-then-drop doctrine the daemon applies again at the wire boundary.
 * Save-time linting is what tells the operator; this is the belt.
 *
 * Cross-field sanity (`post_max_size >= upload_max_filesize`, etc.) is
 * deliberately *not* clamped here — a silent clamp is worse than a warning the
 * operator can see, so that stays a non-blocking lint issue.
 */
export function renderPhpForDeploy(
  php: {
    version?: string
    extensions?: string[]
    settings?: Record<string, string | number>
    pool?: Record<string, string | number>
  } | undefined,
  allowedExtensions: readonly string[],
): {
  version?: string
  settings?: Record<string, string>
  pool?: Record<string, string>
  extensions?: string[]
} | undefined {
  if (!php) return undefined
  const out: {
    version?: string
    settings?: Record<string, string>
    pool?: Record<string, string>
    extensions?: string[]
  } = {}
  if (php.version) out.version = php.version

  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(php.settings ?? {})) {
    const rendered = validatePhpSetting(key, value)
    if (rendered !== undefined) settings[key] = rendered
  }
  if (Object.keys(settings).length > 0) out.settings = settings

  const pool: Record<string, string> = {}
  for (const [key, value] of Object.entries(php.pool ?? {})) {
    const rendered = validatePhpPoolSetting(key, value)
    if (rendered !== undefined) pool[key] = rendered
  }
  if (Object.keys(pool).length > 0) out.pool = pool

  const extensions = (php.extensions ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter((name) => allowedExtensions.includes(name))
  if (extensions.length > 0) out.extensions = [...new Set(extensions)].sort()

  return Object.keys(out).length > 0 ? out : undefined
}
