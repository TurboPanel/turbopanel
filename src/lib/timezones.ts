/**
 * Shared IANA timezone allow-list for client timezone pickers and command
 * validation. Combines the daemon-parity shape check with `Intl` membership.
 */

/** Must stay in sync with the daemon `server.timezone.set` validator. */
export const TIMEZONE_RE =
  /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/

/** Must stay in sync with the daemon `server.timezone.set` validator. */
export const TIMEZONE_MAX_LENGTH = 64

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/

/**
 * Static fallback when `Intl.supportedValuesOf('timeZone')` is unavailable.
 * Sorted at module load for stable `listTimezones()` output.
 */
const FALLBACK_TIMEZONES = [
  'UTC',
  'America/Chicago',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
].sort((a, b) => a.localeCompare(b))

/** Daemon-parity shape check for timezone strings (no Intl membership). */
export function isValidTimezone(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0) return false
  if (value.length > TIMEZONE_MAX_LENGTH) return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  return TIMEZONE_RE.test(value)
}

let cachedTimezones: string[] | null = null

/** Sorted IANA timezone identifiers for pickers. */
export function listTimezones(): string[] {
  if (cachedTimezones) return cachedTimezones
  try {
    const supported = Intl.supportedValuesOf('timeZone')
    if (Array.isArray(supported) && supported.length > 0) {
      cachedTimezones = [...supported].sort((a, b) => a.localeCompare(b))
      return cachedTimezones
    }
  } catch {
    // Intl.supportedValuesOf unavailable — use static fallback.
  }
  cachedTimezones = FALLBACK_TIMEZONES
  return cachedTimezones
}

/**
 * Shape-valid and present in the supported IANA set (or fallback list).
 * Single source of truth for timezone command + org-default validation.
 */
export function isAllowedTimezone(value: unknown): boolean {
  if (!isValidTimezone(value)) return false
  return listTimezones().includes(value as string)
}
