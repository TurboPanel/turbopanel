export type ServerAddresses = {
  privateIpv4: string[]
  privateIpv6: string[]
  publicIpv4: string[]
  publicIpv6: string[]
}

/** Workers-safe empty address payload for runtimes without host interface access. */
export function emptyServerAddresses(): ServerAddresses {
  return {
    privateIpv4: [],
    privateIpv6: [],
    publicIpv4: [],
    publicIpv6: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filteredStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Parse daemon/stored address facts. Returns `undefined` when the value is not
 * an address object; returns empty lists when a valid object has no addresses.
 */
export function parseServerAddresses(
  value: unknown,
): ServerAddresses | undefined {
  if (!isRecord(value)) return undefined
  return {
    privateIpv4: filteredStringArray(value.privateIpv4),
    privateIpv6: filteredStringArray(value.privateIpv6),
    publicIpv4: filteredStringArray(value.publicIpv4),
    publicIpv6: filteredStringArray(value.publicIpv6),
  }
}

export function serverAddressesEquals(
  a: ServerAddresses | null | undefined,
  b: ServerAddresses | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    stringArraysEqual(a.privateIpv4, b.privateIpv4) &&
    stringArraysEqual(a.privateIpv6, b.privateIpv6) &&
    stringArraysEqual(a.publicIpv4, b.publicIpv4) &&
    stringArraysEqual(a.publicIpv6, b.publicIpv6)
  )
}
