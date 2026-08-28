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
  /**
   * Daemon-side marker: this address sits on the interface carrying the host's
   * default route for its family. On multi-homed hosts it is the address a
   * peer would actually reach the host on, so it wins address selection.
   */
  preferred?: boolean
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

function parseOptionalPreferred(value: unknown): true | undefined {
  return value === true ? true : undefined
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
  if (parseOptionalPreferred(entry.preferred)) row.preferred = true
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

/**
 * Reported addresses stored on `server.metadata`.
 *
 * Current writes nest under `resources.ips`. Leftover top-level `ips[]` from
 * older jsonb is still accepted so datacenter membership and fleet reads keep
 * working for hosts that have not been rewritten.
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
      l.interface !== r.interface ||
      l.preferred !== r.preferred
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
  return pickIpv4(ips, 'public') ?? pickIpv4(ips, 'private')
}

/**
 * First IPv4 in `scope`, preferring an address the daemon marked as sitting on
 * the default-route interface. Without that marker the list is sorted by
 * address, which on a multi-homed host picks an arbitrary NIC.
 */
function pickIpv4(
  ips: ServerReportedIp[],
  scope: ServerReportedIpScope,
): string | undefined {
  const matching = ips.filter(
    (row) => row.scope === scope && row.version === 4,
  )
  const onDefaultRoute = matching.find((row) => row.preferred === true)
  return (onDefaultRoute ?? matching[0])?.address
}

/** First IPv6 in `scope`, default-route interface first. */
function pickIpv6(
  ips: ServerReportedIp[],
  scope: ServerReportedIpScope,
): string | undefined {
  const matching = ips.filter(
    (row) => row.scope === scope && row.version === 6,
  )
  const onDefaultRoute = matching.find((row) => row.preferred === true)
  return (onDefaultRoute ?? matching[0])?.address
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
  return pickIpv4(ips, 'public')
}

/**
 * Best host-reported address in daemon-preference order: public IPv4, public
 * IPv6, private IPv4, private IPv6 — each preferring the default-route NIC.
 *
 * Used when the address the control plane observed on the wire is a proxy
 * artifact (loopback behind a local reverse proxy, or a forwarded port in
 * development) rather than the host's own address.
 */
export function bestReportedAddress(
  ips: ServerReportedIp[] | null | undefined,
): ServerReportedIp | undefined {
  if (!ips) return undefined
  const address = pickIpv4(ips, 'public') ?? pickIpv6(ips, 'public') ??
    pickIpv4(ips, 'private') ?? pickIpv6(ips, 'private')
  if (!address) return undefined
  return ips.find((row) => row.address === address)
}
