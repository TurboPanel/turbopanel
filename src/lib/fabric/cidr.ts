/**
 * IPv4 CIDR helpers for TurboFabric host (`tp0`) and per-relay container
 * aggregates. Dual-stack is reserved in `fabric.options`; not implemented here.
 */

import { isValidCidr, isValidIpAddress, stripInetPrefixSuffix } from '../ip-address.ts'

export const DEFAULT_FABRIC_HOST_CIDR = '10.250.0.0/16'
export const DEFAULT_FABRIC_CONTAINER_POOL = '10.192.0.0/12'
export const DEFAULT_FABRIC_LISTEN_PORT = 51821
export const RELAY_PREFIX_LENGTH = 16

const CANDIDATE_HOST_CIDRS = [
  DEFAULT_FABRIC_HOST_CIDR,
  '10.251.0.0/16',
  '10.252.0.0/16',
  '10.253.0.0/16',
]

type Ipv4Cidr = {
  network: number
  prefix: number
  hostCount: number
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number.parseInt(part, 10)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value << 8) + octet
  }
  return value >>> 0
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.')
}

function maskForPrefix(prefix: number): number {
  if (prefix <= 0) return 0
  if (prefix >= 32) return 0xffffffff
  return (0xffffffff << (32 - prefix)) >>> 0
}

export function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const trimmed = value.trim()
  if (!isValidCidr(trimmed)) return null
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return null
  const address = trimmed.slice(0, slash)
  const prefix = Number.parseInt(trimmed.slice(slash + 1), 10)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const ip = ipv4ToInt(address)
  if (ip === null) return null
  const mask = maskForPrefix(prefix)
  const network = ip & mask
  const hostCount = prefix >= 32 ? 1 : 2 ** (32 - prefix)
  return { network, prefix, hostCount }
}

export function cidrOverlaps(a: string, b: string): boolean {
  const left = parseIpv4Cidr(a)
  const right = parseIpv4Cidr(b)
  if (!left || !right) return false
  const leftEnd = left.network + left.hostCount - 1
  const rightEnd = right.network + right.hostCount - 1
  return left.network <= rightEnd && right.network <= leftEnd
}

export function pickNonOverlappingCidr(
  candidates: readonly string[],
  occupied: readonly string[],
): string | null {
  for (const candidate of candidates) {
    if (occupied.some((row) => cidrOverlaps(candidate, row))) continue
    return candidate
  }
  return null
}

export function pickDefaultFabricHostCidr(occupied: readonly string[]): string | null {
  return pickNonOverlappingCidr(CANDIDATE_HOST_CIDRS, occupied)
}

export function nthHostAddress(cidrValue: string, index: number): string | null {
  const parsed = parseIpv4Cidr(cidrValue)
  if (!parsed || parsed.prefix >= 31) return null
  // Skip network (0) and broadcast (hostCount-1); index is 0-based among hosts.
  if (index < 0 || index >= parsed.hostCount - 2) return null
  return intToIpv4(parsed.network + 1 + index)
}

export function nthSubnet(
  poolCidr: string,
  prefixLength: number,
  index: number,
): string | null {
  const pool = parseIpv4Cidr(poolCidr)
  if (!pool || prefixLength < pool.prefix || prefixLength > 32) return null
  const blockSize = 2 ** (32 - prefixLength)
  const available = 2 ** (prefixLength - pool.prefix)
  if (index < 0 || index >= available) return null
  const network = pool.network + index * blockSize
  return `${intToIpv4(network)}/${String(prefixLength)}`
}

export function hostRoute32(address: string): string | null {
  const stripped = stripInetPrefixSuffix(address)
  if (!isValidIpAddress(stripped)) return null
  return `${stripped}/32`
}

export function parseFabricOptions(value: unknown): {
  containerPool: string
  listenPort: number
} {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const pool = typeof record.containerPool === 'string' && isValidCidr(record.containerPool)
    ? record.containerPool.trim()
    : DEFAULT_FABRIC_CONTAINER_POOL
  const port = typeof record.listenPort === 'number' &&
      Number.isInteger(record.listenPort) &&
      record.listenPort >= 1 &&
      record.listenPort <= 65535
    ? record.listenPort
    : DEFAULT_FABRIC_LISTEN_PORT
  return { containerPool: pool, listenPort: port }
}

export function composeNetworkHostName(networkId: string): string {
  return `tpn_${networkId}`
}
