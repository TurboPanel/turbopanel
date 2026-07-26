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

/** Strip a Postgres `inet` `/prefix` suffix when present. */
export function stripInetPrefixSuffix(value: string): string {
  const trimmed = value.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return trimmed
  const suffix = trimmed.slice(slash + 1)
  if (!/^\d+$/.test(suffix)) return trimmed
  return trimmed.slice(0, slash)
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
  return parseCidr(value) !== null
}

/** Derive address family from an IP string (API response helper; not a DB column). */
export function deriveIpVersion(address: string): 4 | 6 | null {
  return parseIpVersion(address)
}

export type ParsedCidr = {
  version: 4 | 6
  base: bigint
  prefix: number
}

export function parseCidr(value: string): ParsedCidr | null {
  const trimmed = value.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  const addressPart = trimmed.slice(0, slash)
  const prefixPart = trimmed.slice(slash + 1)
  const version = parseIpVersion(addressPart)
  if (version === null) return null
  const prefix = parsePrefix(prefixPart, version)
  if (prefix === null) return null
  const base = ipToBigInt(addressPart)
  if (base === null) return null
  const hostBits = (version === 4 ? 32 : 128) - prefix
  const aligned = hostBits === 0
    ? base
    : (base >> BigInt(hostBits)) << BigInt(hostBits)
  return { version, base: aligned, prefix }
}

export function ipToBigInt(address: string): bigint | null {
  const trimmed = stripInetPrefixSuffix(address)
  const version = parseIpVersion(trimmed)
  if (version === 4) {
    const parts = trimmed.split('.')
    if (parts.length !== 4) return null
    let value = 0n
    for (const part of parts) {
      value = (value << 8n) + BigInt(Number.parseInt(part, 10))
    }
    return value
  }
  if (version === 6) {
    const hextets = expandIpv6Hextets(trimmed)
    if (!hextets) return null
    let value = 0n
    for (const hextet of hextets) {
      value = (value << 16n) + BigInt(Number.parseInt(hextet, 16))
    }
    return value
  }
  return null
}

function expandIpv6Hextets(address: string): string[] | null {
  if (address.includes('::')) {
    const [left, right] = address.split('::')
    const leftParts = left === '' ? [] : left.split(':')
    const rightParts = right === '' ? [] : right.split(':')
    const missing = 8 - leftParts.length - rightParts.length
    if (missing < 0) return null
    return [
      ...leftParts,
      ...Array.from({ length: missing }, () => '0'),
      ...rightParts,
    ]
  }
  const parts = address.split(':')
  if (parts.length !== 8) return null
  return parts
}

function bigIntToIpv4(value: bigint): string {
  const n = value & 0xff_ff_ff_ffn
  return [
    Number((n >> 24n) & 0xffn),
    Number((n >> 16n) & 0xffn),
    Number((n >> 8n) & 0xffn),
    Number(n & 0xffn),
  ].join('.')
}

function ipv6HextetsFromBigInt(value: bigint): number[] {
  const hextets: number[] = []
  let remaining = value & ((1n << 128n) - 1n)
  for (let i = 0; i < 8; i++) {
    hextets.unshift(Number(remaining & 0xffffn))
    remaining >>= 16n
  }
  return hextets
}

/** Longest run of zero hextets (RFC 5952 prefers the leftmost on ties). */
function longestIpv6ZeroRun(
  hextets: readonly number[],
): { start: number; length: number } {
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  let runLen = 0
  for (let i = 0; i <= hextets.length; i++) {
    if (i < hextets.length && hextets[i] === 0) {
      if (runStart === -1) runStart = i
      runLen += 1
      continue
    }
    if (runStart !== -1 && runLen > bestLen) {
      bestStart = runStart
      bestLen = runLen
    }
    runStart = -1
    runLen = 0
  }
  return { start: bestStart, length: bestLen }
}

function formatHexHextets(hextets: readonly number[]): string {
  return hextets.map((h) => h.toString(16)).join(':')
}

/** RFC 5952-canonical IPv6 (lowercase, longest zero-run compressed). */
function bigIntToIpv6(value: bigint): string {
  const hextets = ipv6HextetsFromBigInt(value)
  const { start: bestStart, length: bestLen } = longestIpv6ZeroRun(hextets)

  if (bestLen < 2) return formatHexHextets(hextets)

  const left = formatHexHextets(hextets.slice(0, bestStart))
  const right = formatHexHextets(hextets.slice(bestStart + bestLen))
  if (bestStart === 0 && bestStart + bestLen === 8) return '::'
  if (bestStart === 0) return `::${right}`
  if (bestStart + bestLen === 8) return `${left}::`
  return `${left}::${right}`
}

export function bigIntToIp(value: bigint, version: 4 | 6): string {
  if (version === 4) return bigIntToIpv4(value)
  return bigIntToIpv6(value)
}

export type CidrHostRange = {
  first: bigint
  last: bigint
}

export function cidrHostRange(cidr: string): CidrHostRange | null {
  const parsed = parseCidr(cidr)
  if (!parsed) return null
  const bitWidth = parsed.version === 4 ? 32 : 128
  const hostBits = bitWidth - parsed.prefix
  const size = 1n << BigInt(hostBits)
  const network = parsed.base
  const broadcast = network + size - 1n

  if (parsed.version === 4) {
    if (parsed.prefix <= 30) {
      if (size < 4n) return null
      return { first: network + 1n, last: broadcast - 1n }
    }
    return { first: network, last: broadcast }
  }

  // IPv6: skip subnet-router anycast / unspecified (::). Never hand out ::.
  if (size === 1n) {
    if (network === 0n) return null
    return { first: network, last: network }
  }
  return { first: network + 1n, last: broadcast }
}

export function nextFreeHostAddress(
  cidr: string,
  usedAddresses: Iterable<string>,
): string | null {
  const range = cidrHostRange(cidr)
  const parsed = parseCidr(cidr)
  if (!range || !parsed) return null

  const used = new Set<bigint>()
  for (const raw of usedAddresses) {
    const value = ipToBigInt(raw)
    if (value !== null) used.add(value)
  }

  const maxIterations = used.size + 1
  let candidate = range.first
  for (let i = 0; i < maxIterations && candidate <= range.last; i++) {
    if (!used.has(candidate)) {
      return bigIntToIp(candidate, parsed.version)
    }
    candidate += 1n
  }
  return null
}
