import { isLoopbackOrPrivateHostname } from '../../install/install-tls.ts'

export const MAX_CERTIFICATE_NAMES = 10

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export type ParsedNames = { ok: true; names: string[] } | { ok: false; detail: string }

/** The name without a leading `*.`. */
export function baseName(name: string): string {
  return name.startsWith('*.') ? name.slice(2) : name
}

function badName(raw: string): string | null {
  const base = baseName(raw)
  if (raw.includes('*') && !raw.startsWith('*.')) return `${raw} has a * in the wrong place`
  if (base.includes('*')) return `${raw} may have only one * at the start`
  const labels = base.split('.')
  if (labels.length < 2 || base.length > 253 || !labels.every((l) => LABEL.test(l))) {
    return `${raw} is not a valid domain name`
  }
  if (/^\d+(\.\d+)*$/.test(base)) return `${raw} is an address, not a name`
  if (isLoopbackOrPrivateHostname(base)) return `${raw} is a private name`
  return null
}

/** Exact names and wildcards (`*.example.com`) for one certificate, lowercased and without repeats. */
export function parseCertificateNames(value: unknown): ParsedNames {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CERTIFICATE_NAMES) {
    return { ok: false, detail: `Give 1 to ${MAX_CERTIFICATE_NAMES} names` }
  }
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, detail: 'Every name must be text' }
    const name = entry.trim().toLowerCase().replace(/\.$/, '')
    const problem = badName(name)
    if (problem) return { ok: false, detail: problem }
    if (!names.includes(name)) names.push(name)
  }
  return { ok: true, names }
}
