/**
 * Allowlist checks for hosting option values the daemon writes into configs a
 * root-run engine parses (the hosting Caddyfile, Traefik labels, Apache
 * `SetEnv`). Any project member can set these, so they are tenant input.
 *
 * Doctrine: refuse at the API boundary with a 400 naming the field, never
 * sanitize. The daemon runs the same rules again in its renderers
 * (`turbopaneld/src/contracts/config-values.ts`); the sink table lives in
 * `AGENTS.md` ("Tenant values in root-loaded configs").
 */

import { isValidHostname } from '../../contracts/commands/hostname.ts'
import { HOSTING_WEB_ENV_KEY_RE } from './hosting-options.ts'

/** Stable error code for a hosting option value outside its allowlist. */
export const INVALID_HOSTING_OPTION_ERROR = 'invalid_hosting_option'

/** Which option was refused and why. Never carries the value: it may be a secret. */
export type HostingOptionInputError = Readonly<{ field: string; message: string }>

/** Longest URL path prefix accepted (matches the compose extension's cap). */
export const MAX_URL_PATH_LENGTH = 200
/** Longest web env value accepted (larger values were already dropped). */
const MAX_WEB_ENV_VALUE_LENGTH = 4096
/** Longest web env name accepted. */
const MAX_ENV_NAME_LENGTH = 128

const URL_PATH_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/

/**
 * True when `value` holds a C0 control (including TAB, LF, CR and NUL), DEL, a
 * C1 control (including U+0085 NEL) or a Unicode line/paragraph separator.
 */
export function hasLineBreakOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
    if (code === 0x2028 || code === 0x2029) return true
  }
  return false
}

/**
 * Why `value` is not a clean absolute URL path prefix, or `null` when it is:
 * `/` alone, or `/` plus segments of `[A-Za-z0-9._~-]` joined by single `/`,
 * at most one trailing `/`, no `.` or `..` segment, at most
 * {@link MAX_URL_PATH_LENGTH} characters.
 */
export function urlPathPrefixProblem(value: string): string | null {
  if (value.length === 0 || value.length > MAX_URL_PATH_LENGTH) {
    return `must be 1-${MAX_URL_PATH_LENGTH} characters`
  }
  if (!value.startsWith('/')) return 'must start with /'
  if (value === '/') return null
  const body = value.endsWith('/') ? value.slice(1, -1) : value.slice(1)
  for (const segment of body.split('/')) {
    if (!URL_PATH_SEGMENT_RE.test(segment)) {
      return "must be / followed by segments of letters, digits, '.', '_', '~' or '-'"
    }
    if (segment === '.' || segment === '..') return 'must not contain . or .. segments'
  }
  return null
}

/** Why `value` is not an environment variable name, or `null` when it is. */
export function envNameProblem(value: string): string | null {
  if (value.length > MAX_ENV_NAME_LENGTH || !HOSTING_WEB_ENV_KEY_RE.test(value)) {
    return "must be a letter or '_' followed by letters, digits or '_'"
  }
  return null
}

/** Why `value` cannot sit on one config line, or `null` when it can. */
export function envValueProblem(value: string): string | null {
  return hasLineBreakOrControl(value) ? 'must not contain line breaks or control characters' : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function pathProblem(field: string, value: unknown): HostingOptionInputError | null {
  const path = trimmedString(value)
  if (path === undefined) return null
  const message = urlPathPrefixProblem(path)
  return message ? { field, message } : null
}

function hostnamesProblem(value: unknown): HostingOptionInputError | null {
  if (!Array.isArray(value)) return null
  const bad = value.some((h) => typeof h === 'string' && h.length > 0 && !isValidHostname(h))
  return bad
    ? { field: 'options.hostnames', message: 'must contain only lowercase DNS hostnames' }
    : null
}

function webEnvProblem(web: unknown): HostingOptionInputError | null {
  if (!isRecord(web) || !isRecord(web.env)) return null
  for (const [key, entry] of Object.entries(web.env)) {
    const nameMessage = envNameProblem(key)
    if (nameMessage) return { field: 'options.web.env', message: nameMessage }
    if (typeof entry !== 'string' || entry.length > MAX_WEB_ENV_VALUE_LENGTH) continue
    const valueMessage = envValueProblem(entry.trim())
    if (valueMessage) return { field: `options.web.env.${key}`, message: valueMessage }
  }
  return null
}

/**
 * The first hosting option a root-loaded config could not carry safely, or
 * `null`. Runs on create/update input only: stored rows keep parsing leniently
 * through `parseHostingOptions`, and the daemon refuses what this would have.
 */
export function hostingOptionsInputError(value: unknown): HostingOptionInputError | null {
  if (!isRecord(value)) return null
  return (
    pathProblem('options.pathPrefix', value.pathPrefix) ??
    pathProblem(
      'options.proxy.stripPrefix',
      isRecord(value.proxy) ? value.proxy.stripPrefix : undefined
    ) ??
    hostnamesProblem(value.hostnames) ??
    webEnvProblem(value.web)
  )
}
