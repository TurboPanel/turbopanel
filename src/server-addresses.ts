import { alignedNetworkCidr, stripInetPrefixSuffix } from './lib/ip-address.ts'

export type ServerReportedIpScope = 'private' | 'public'

/** One daemon-reported host interface address (hello / heartbeat / addresses-result). */
export type ServerReportedIp = {
  address: string
  version: 4 | 6
  scope: ServerReportedIpScope
  /** Aligned interface network CIDR when known. */
  cidr?: string
  /** Host interface name (e.g. `eth0`, `enp1s0`). */
  interface?: string
}

/** Workers-safe empty IP list for runtimes without host interface access. */
export function emptyServerIps(): ServerReportedIp[] {
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIpVersion(value: unknown): 4 | 6 | undefined {
  if (value === 4 || value === 6) return value
  return undefined
}

function parseIpScope(value: unknown): ServerReportedIpScope | undefined {
  if (value === 'private' || value === 'public') return value
  return undefined
}

function parseOptionalCidr(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return alignedNetworkCidr(value) ?? undefined
}

function parseOptionalInterface(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const iface = value.trim()
  if (iface.length === 0 || iface.length > 64) return undefined
  return iface
}

function parseServerIpEntry(
  entry: unknown,
  seen: Set<string>,
): ServerReportedIp | undefined {
  if (!isRecord(entry) || typeof entry.address !== 'string') return undefined
  const address = stripInetPrefixSuffix(entry.address.trim())
  const version = parseIpVersion(entry.version)
  const scope = parseIpScope(entry.scope)
  if (!address || version === undefined || scope === undefined) return undefined
  if (seen.has(address)) return undefined
  seen.add(address)
  const row: ServerReportedIp = { address, version, scope }
  const cidr = parseOptionalCidr(entry.cidr)
  if (cidr) row.cidr = cidr
  const iface = parseOptionalInterface(entry.interface)
  if (iface) row.interface = iface
  return row
}

/**
 * Parse daemon/stored IP facts. Returns `undefined` when the value is not an
 * array; returns `[]` when a valid array has no usable entries.
 */
export function parseServerIps(value: unknown): ServerReportedIp[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ServerReportedIp[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const row = parseServerIpEntry(entry, seen)
    if (row) out.push(row)
  }
  return out.sort((a, b) => a.address.localeCompare(b.address))
}

/** Host addresses from daemon hello / change-detected heartbeat payloads. */
export function ipsFromDaemonPresence(
  payload: unknown,
): ServerReportedIp[] | undefined {
  if (!isRecord(payload)) return undefined
  if (!isRecord(payload.resources)) return undefined
  return parseServerIps(payload.resources.ips)
}

/** Reported addresses stored on `server.metadata.resources.ips`. */
export function reportedIpsFromServerMetadata(
  metadata: unknown,
): ServerReportedIp[] | undefined {
  if (!isRecord(metadata)) return undefined
  if (isRecord(metadata.resources) && metadata.resources.ips !== undefined) {
    return parseServerIps(metadata.resources.ips)
  }
  // Legacy top-level `metadata.ips` (pre-resources nest).
  return parseServerIps(metadata.ips)
}

export function serverIpsEquals(
  a: ServerReportedIp[] | null | undefined,
  b: ServerReportedIp[] | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const left = parseServerIps(a)
  const right = parseServerIps(b)
  if (!left || !right) return false
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    const l = left[i]
    const r = right[i]
    if (!l || !r) return false
    if (
      l.address !== r.address ||
      l.version !== r.version ||
      l.scope !== r.scope ||
      l.cidr !== r.cidr ||
      l.interface !== r.interface
    ) {
      return false
    }
  }
  return true
}

/** Private addresses from a reported IP list (any version). */
export function privateAddressesFromIps(
  ips: ServerReportedIp[] | null | undefined,
): string[] {
  if (!ips) return []
  return ips.filter((row) => row.scope === 'private').map((row) => row.address)
}

/** First public IPv4, then first private IPv4 — for relay endpoint fallback. */
export function preferredIpv4FromIps(
  ips: ServerReportedIp[] | null | undefined,
): string | undefined {
  if (!ips) return undefined
  const publicV4 = ips.find((row) => row.scope === 'public' && row.version === 4)
  if (publicV4) return publicV4.address
  const privateV4 = ips.find(
    (row) => row.scope === 'private' && row.version === 4,
  )
  return privateV4?.address
}

/**
 * First public IPv4 only — no private fallback.
 *
 * For values shown to readers whose network position is unknown (e.g. the
 * fabric GET `resolvedEndpoint`), where a private LAN address would be wrong
 * rather than merely less specific.
 */
export function publicIpv4FromIps(
  ips: ServerReportedIp[] | null | undefined,
): string | undefined {
  if (!ips) return undefined
  return ips.find((row) => row.scope === 'public' && row.version === 4)?.address
}
