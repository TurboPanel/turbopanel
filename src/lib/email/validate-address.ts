const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class PermanentSendError extends Error {}

export function validateEmailAddress(address: string, label: string): void {
  const trimmed = address.trim()
  const addressOnly = trimmed.endsWith('>')
    ? trimmed.slice(trimmed.lastIndexOf('<') + 1, -1).trim()
    : trimmed
  if (addressOnly === '' || !EMAIL_RE.test(addressOnly)) {
    throw new PermanentSendError(`malformed ${label} address`)
  }
}
