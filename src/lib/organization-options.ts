/**
 * Defensive parsers for `organization.options` jsonb fields used by the
 * client timezone, server-capacity, and default-environment APIs.
 */

/** Platform fallback when `defaultEnvironmentName` is unset. */
export const DEFAULT_ENVIRONMENT_NAME = 'Production'

/**
 * Intentionally mirrors `DISPLAY_NAME_RE` in `src/client/shared.ts`.
 * `src/lib/` must not import from `src/client/`.
 */
const ENVIRONMENT_DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]+$/

export type OrganizationOptions = {
  /** Org-wide default timezone applied when a server has no override. */
  defaultServerTimezone?: string
  /**
   * When true, the org default wins over any per-server `options.timezone`
   * override.
   */
  enforceServerTimezone?: boolean
  /**
   * Cap on enrolled servers + unconsumed registration keys for this org.
   * Omitted or `null` = unlimited (self-hosted default). Workers/Stripe billing
   * will set a concrete cap later; self-hosted operators may set one on the
   * control plane.
   */
  maxServers?: number | null
  /**
   * Org-wide name used for the environment scaffolded with every new project.
   * Platform fallback is {@link DEFAULT_ENVIRONMENT_NAME} (`Production`).
   */
  defaultEnvironmentName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when no finite server seat cap is configured. */
export function isUnlimitedMaxServers(
  maxServers: number | null | undefined,
): boolean {
  return maxServers === null || maxServers === undefined
}

/**
 * Parse a maxServers value from JSON. Returns `{ ok: true, value }` where
 * `value` is a non-negative integer, or `null` for unlimited. Invalid input
 * returns `{ ok: false }`.
 */
export function parseMaxServersInput(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false }
  }
  return { ok: true, value }
}

/**
 * Parse a defaultEnvironmentName PUT body value.
 * `null` → `{ ok: true, value: null }` (reset to platform default). Empty /
 * whitespace-only strings, non-strings, names longer than 255, or names
 * failing the display-name regex → `{ ok: false }`.
 */
export function parseDefaultEnvironmentNameInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false }
  if (trimmed.length > 255 || !ENVIRONMENT_DISPLAY_NAME_RE.test(trimmed)) {
    return { ok: false }
  }
  return { ok: true, value: trimmed }
}

/** Resolved scaffold name: option when set, else platform fallback. */
export function resolveDefaultEnvironmentName(
  options: OrganizationOptions,
): string {
  return options.defaultEnvironmentName ?? DEFAULT_ENVIRONMENT_NAME
}

/** Parse organization.options jsonb (missing/invalid keys → omitted). */
export function parseOrganizationOptions(value: unknown): OrganizationOptions {
  if (!isRecord(value)) return {}
  const options: OrganizationOptions = {}
  if (typeof value.defaultServerTimezone === 'string') {
    const trimmed = value.defaultServerTimezone.trim()
    if (trimmed.length > 0) options.defaultServerTimezone = trimmed
  }
  if (typeof value.enforceServerTimezone === 'boolean') {
    options.enforceServerTimezone = value.enforceServerTimezone
  }
  if ('maxServers' in value) {
    const parsed = parseMaxServersInput(value.maxServers)
    if (parsed.ok) options.maxServers = parsed.value
  }
  if (typeof value.defaultEnvironmentName === 'string') {
    const trimmed = value.defaultEnvironmentName.trim()
    if (trimmed.length > 0) options.defaultEnvironmentName = trimmed
  }
  return options
}
