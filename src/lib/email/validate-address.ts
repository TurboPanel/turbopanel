export class PermanentSendError extends Error {}

/**
 * Plausible-email gate matching the former `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
 * semantics without a backtracking regex (Sonar typescript:S5852).
 */
function isPlausibleEmailAddress(address: string): boolean {
  const at = address.indexOf('@')
  if (at <= 0) return false
  if (address.includes('@', at + 1)) return false

  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  if (local.length === 0 || domain.length < 3) return false
  // Linear character-class probes — no quantified regex.
  if (/\s/.test(local) || /\s/.test(domain)) return false

  const dot = domain.indexOf('.')
  return dot > 0 && dot < domain.length - 1
}

export function validateEmailAddress(address: string, label: string): void {
  const trimmed = address.trim()
  const addressOnly = trimmed.endsWith('>')
    ? trimmed.slice(trimmed.lastIndexOf('<') + 1, -1).trim()
    : trimmed
  if (addressOnly === '' || !isPlausibleEmailAddress(addressOnly)) {
    throw new PermanentSendError(`malformed ${label} address`)
  }
}
