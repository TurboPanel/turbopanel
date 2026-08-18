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

/**
 * Parse daemon/stored IP facts. Returns `undefined` when the value is not an
 * array; returns `[]` when a valid array has no usable entries.
 */
export function parseServerIps(value: unknown): ServerReportedIp[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ServerReportedIp[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (typeof entry.address !== 'string') continue
    const address = stripInetPrefixSuffix(entry.address.trim())
    const version = parseIpVersion(entry.version)
    const scope = parseIpScope(entry.scope)
    if (!address || version === undefined || scope === undefined) continue
    if (seen.has(address)) continue
    seen.add(address)
    const row: ServerReportedIp = { address, version, scope }
    if (typeof entry.cidr === 'string') {
      const cidr = alignedNetworkCidr(entry.cidr)
      if (cidr) row.cidr = cidr
    }
    if (typeof entry.interface === 'string') {
      const iface = entry.interface.trim()
      if (iface.length > 0 && iface.length <= 64) row.interface = iface
    }
    out.push(row)
  }
  return out.sort((a, b) => a.address.localeCompare(b.address))
}

function pushLegacyAddressList(
  out: ServerReportedIp[],
  seen: Set<string>,
  list: unknown,
  version: 4 | 6,
  scope: ServerReportedIpScope,
): void {
  if (!Array.isArray(list)) return
  for (const item of list) {
    if (typeof item !== 'string') continue
    const address = stripInetPrefixSuffix(item.trim())
    if (!address || seen.has(address)) continue
    seen.add(address)
    out.push({ address, version, scope })
  }
}

/**
 * Map a pre-`ips[]` hello/heartbeat `addresses` object
 * (`privateIpv4` / `publicIpv4` / …) to {@link ServerReportedIp} rows.
 * Returns `undefined` when the value is not that object shape.
 */
export function parseLegacyServerAddresses(
  value: unknown,
): ServerReportedIp[] | undefined {
  if (!isRecord(value)) return undefined
  const out: ServerReportedIp[] = []
  const seen = new Set<string>()
  pushLegacyAddressList(out, seen, value.privateIpv4, 4, 'private')
  pushLegacyAddressList(out, seen, value.privateIpv6, 6, 'private')
  pushLegacyAddressList(out, seen, value.publicIpv4, 4, 'public')
  pushLegacyAddressList(out, seen, value.publicIpv6, 6, 'public')
  return out.sort((a, b) => a.address.localeCompare(b.address))
}

/**
 * Prefer `resources.ips[]`, then top-level `ips[]`, then the pre-rename
 * `addresses` object so remotes that have not rebuilt yet still persist
 * private IPs for datacenters.
 */
export function ipsFromDaemonPresence(
  payload: unknown,
): ServerReportedIp[] | undefined {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.resources)) {
    const nested = parseServerIps(payload.resources.ips)
    if (nested !== undefined) return nested
  }
  const fromIps = parseServerIps(payload.ips)
  if (fromIps !== undefined) return fromIps
  return parseLegacyServerAddresses(payload.addresses)
}

/**
 * Reported addresses stored on `server.metadata` — `resources.ips` first,
 * then the retired top-level `ips` key.
 */
export function reportedIpsFromServerMetadata(
  metadata: unknown,
): ServerReportedIp[] | undefined {
  if (!isRecord(metadata)) return undefined
  if (isRecord(metadata.resources)) {
    const nested = parseServerIps(metadata.resources.ips)
    if (nested !== undefined) return nested
  }
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
