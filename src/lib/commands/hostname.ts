export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

export const HOSTNAME_MAX_LENGTH = 253

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/

export function isValidHostname(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0) return false
  if (value.length > HOSTNAME_MAX_LENGTH) return false
  if (/[A-Z]/.test(value)) return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  return HOSTNAME_RE.test(value)
}

export function assertValidHostname(value: unknown): asserts value is string {
  if (!isValidHostname(value)) {
    throw new Error('Invalid hostname')
  }
}
