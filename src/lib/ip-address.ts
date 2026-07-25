/** Dependency-free IPv4/IPv6 and CIDR validators (Deno + Workers). */

const IPV4_OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)`
const IPV4_ADDRESS_RE = new RegExp(
  String.raw`^${IPV4_OCTET}\.${IPV4_OCTET}\.${IPV4_OCTET}\.${IPV4_OCTET}$`,
)

function isIpv6Hextet(part: string): boolean {
  if (part.length === 0 || part.length > 4) return false
  return /^[0-9a-fA-F]+$/.test(part)
}

function areValidIpv6Hextets(parts: readonly string[]): boolean {
  return parts.every(isIpv6Hextet)
}

function hextetsAroundCompression(address: string): string[] {
  const [left, right] = address.split('::')
  const leftParts = left === '' ? [] : left.split(':')
  const rightParts = right === '' ? [] : right.split(':')
  return [...leftParts, ...rightParts]
}

/** Compressed form with a single `::` (0–7 hextets around the gap). */
function isValidCompressedIpv6(address: string): boolean {
  const parts = hextetsAroundCompression(address)
  if (!areValidIpv6Hextets(parts)) return false
  return parts.length < 8
}

/** Full form: exactly eight hextets, no `::`. */
function isValidFullIpv6(address: string): boolean {
  const parts = address.split(':')
  if (parts.length !== 8) return false
  return areValidIpv6Hextets(parts)
}

/** RFC 5952-style IPv6 (single `::`, non-empty groups, no zone id). */
function isValidIpv6Address(address: string): boolean {
  if (address.includes('.') || address.includes('%')) return false

  const doubleColonMatches = address.match(/::/g)
  const doubleColonCount = doubleColonMatches?.length ?? 0
  if (doubleColonCount > 1) return false
  if (doubleColonCount === 1) return isValidCompressedIpv6(address)
  return isValidFullIpv6(address)
}

export function parseIpVersion(address: string): 4 | 6 | null {
  const trimmed = address.trim()
  if (trimmed.length === 0) return null
  if (IPV4_ADDRESS_RE.test(trimmed)) return 4
  if (trimmed.includes(':') && isValidIpv6Address(trimmed)) return 6
  return null
}

export function isValidIpAddress(address: string): boolean {
  return parseIpVersion(address) !== null
}

function parsePrefix(value: string, version: 4 | 6): number | null {
  if (!/^\d+$/.test(value)) return null
  const prefix = Number.parseInt(value, 10)
  const max = version === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null
  return prefix
}

export function isValidCidr(value: string): boolean {
  const trimmed = value.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return false
  const addressPart = trimmed.slice(0, slash)
  const prefixPart = trimmed.slice(slash + 1)
  const version = parseIpVersion(addressPart)
  if (version === null) return false
  return parsePrefix(prefixPart, version) !== null
}

/** Cross-check helper for `ip.version` vs `ip.address` before insert/update. */
export function deriveIpVersion(address: string): 4 | 6 | null {
  return parseIpVersion(address)
}
