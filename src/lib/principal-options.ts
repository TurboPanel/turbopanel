/**
 * Defensive parser for `principal.options` jsonb. Validates `shell` and
 * resolves the default (`/usr/sbin/nologin`) for deploy materialization.
 * Create/request paths use {@link parsePrincipalOptionsInput} (strict).
 */

export type PrincipalOptions = {
  shell?: string
}

/** Persisted create shape — `shell` is always present. */
export type PrincipalOptionsPersisted = {
  shell: string
}

export const DEFAULT_PRINCIPAL_SHELL = '/usr/sbin/nologin'

const MAX_SHELL_PATH_LENGTH = 255
/** Absolute path: leading `/`, no whitespace/newline/NUL, conservative allowlist. */
const PRINCIPAL_SHELL_RE = /^\/[A-Za-z0-9._+/-]{0,254}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidPrincipalShell(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SHELL_PATH_LENGTH) return false
  if (/\s/.test(value) || value.includes('\0') || value.includes('\n')) return false
  return PRINCIPAL_SHELL_RE.test(value)
}

/** Parse principal.options jsonb (missing/invalid keys → omitted). */
export function parsePrincipalOptions(value: unknown): PrincipalOptions {
  if (!isRecord(value)) return {}
  const options: PrincipalOptions = {}
  if (typeof value.shell === 'string') {
    // Reject newline/NUL before trim so they cannot be silently stripped.
    if (!value.shell.includes('\0') && !value.shell.includes('\n')) {
      const trimmed = value.shell.trim()
      if (isValidPrincipalShell(trimmed)) options.shell = trimmed
    }
  }
  return options
}

/**
 * Strict request parser for principal create `options`.
 *
 * - `undefined` / `null` / `{}` / omitted `shell` → default shell persisted
 * - non-object (when provided) or malformed `shell` → `{ ok: false }`
 */
export function parsePrincipalOptionsInput(
  value: unknown,
): { ok: true; value: PrincipalOptionsPersisted } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: { shell: DEFAULT_PRINCIPAL_SHELL } }
  }
  if (!isRecord(value)) return { ok: false }

  if (!('shell' in value) || value.shell === undefined) {
    return { ok: true, value: { shell: DEFAULT_PRINCIPAL_SHELL } }
  }
  if (typeof value.shell !== 'string') return { ok: false }
  // Reject newline/NUL before trim so they cannot be silently stripped.
  if (value.shell.includes('\0') || value.shell.includes('\n')) return { ok: false }
  const trimmed = value.shell.trim()
  if (!isValidPrincipalShell(trimmed)) return { ok: false }
  return { ok: true, value: { shell: trimmed } }
}

/** Default shell when absent/invalid. */
export function resolvePrincipalShell(
  options: PrincipalOptions | null | undefined,
): string {
  return options?.shell ?? DEFAULT_PRINCIPAL_SHELL
}
