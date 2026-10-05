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

/** Characters that can start another recipient or another header line. */
const LIST_OR_HEADER_BREAKS = /[\r\n;<>]/

const MAX_ADDRESS_LENGTH = 254
const MAX_LOCAL_PART_LENGTH = 64

/**
 * One bare mailbox, or `null`. `Name <addr>` is reduced to `addr`; a list of
 * recipients, a header break, a quoted local part or an over-long address is
 * `null`. Used where an address is stored and later mailed, so the stored value
 * is exactly one recipient.
 */
export function parseSingleEmailAddress(raw: string): string | null {
  const trimmed = raw.trim()
  let candidate = trimmed
  const open = trimmed.indexOf('<')
  if (open !== -1) {
    if (!trimmed.endsWith('>') || trimmed.slice(open + 1).includes('<')) return null
    candidate = trimmed.slice(open + 1, -1).trim()
  }
  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_LENGTH) return null
  if (/[\s,;<>"()[\]\\]/.test(candidate)) return null
  if (!isPlausibleEmailAddress(candidate)) return null
  const local = candidate.slice(0, candidate.indexOf('@'))
  return local.length <= MAX_LOCAL_PART_LENGTH ? candidate : null
}

/** A display name that may hold a comma only when it is wholly quoted. */
function isSafeDisplayName(display: string): boolean {
  if (LIST_OR_HEADER_BREAKS.test(display)) return false
  if (!display.includes(',')) return true
  return (
    display.length >= 2 &&
    display.startsWith('"') &&
    display.endsWith('"') &&
    !display.slice(1, -1).includes('"')
  )
}

export function validateEmailAddress(address: string, label: string): void {
  const trimmed = address.trim()
  if (/[\r\n]/.test(trimmed)) throw new PermanentSendError(`malformed ${label} address`)
  let addressOnly = trimmed
  if (trimmed.endsWith('>')) {
    const open = trimmed.lastIndexOf('<')
    // One mailbox only: no second `<` inside the brackets or in the name.
    if (!isSafeDisplayName(trimmed.slice(0, Math.max(open, 0)).trim())) {
      throw new PermanentSendError(`malformed ${label} address`)
    }
    addressOnly = trimmed.slice(open + 1, -1).trim()
  } else if (/[,;<>]/.test(trimmed)) {
    throw new PermanentSendError(`malformed ${label} address`)
  }
  if (addressOnly === '' || /[,;<>]/.test(addressOnly) || !isPlausibleEmailAddress(addressOnly)) {
    throw new PermanentSendError(`malformed ${label} address`)
  }
}
