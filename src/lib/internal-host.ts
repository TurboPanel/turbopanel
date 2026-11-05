/**
 * Which hosts count as internal: the one static rule for a remote address the
 * control plane hands to a server to fetch from, a remote Compose build source
 * (`features/compose/build-policy.ts`) and a repository clone URL
 * (`features/git/clone-url.ts`) alike. The daemon applies the same rule again
 * (`internalHostReason` in its `deploy/compose-build-policy.ts`).
 *
 * Loopback, link-local, private and ULA literals, cloud metadata endpoints,
 * numeric hosts (`2130706433`, `0x7f.1`), `localhost`, single-label names and
 * reserved suffixes are internal. A DNS name is not resolved: a pre-check could
 * be answered differently when the server looks the name up, so it would
 * promise more than it holds.
 *
 * Web APIs only, so it stays reachable from `src/workers.ts`.
 */
import { hostIsReserved, stripTrailingDots, unbracket } from './http/outbound-url.ts'
import { ipAddressScope, ipToBigInt, normalizeIpAddress } from './ip-address.ts'

/**
 * Cloud metadata endpoints that sit in ranges `ipAddressScope` calls private:
 * AWS's IPv6 endpoint (`fd00:ec2::254`) and Alibaba's (`100.100.100.200`).
 * Kept as numbers: link-local metadata (`169.254.169.254`) is caught by scope.
 */
const METADATA_ADDRESSES: ReadonlySet<bigint> = new Set([
  0xfd000ec2000000000000000000000254n,
  0x646464c8n,
])

/** A host label spelled the way `inet_aton` reads a number (`0x7f`, `017`, `2130706433`). */
const NUMERIC_LABEL_RE = /^(?:0x[0-9a-f]*|\d+)$/i

/** Why an address is one a build must not be pointed at, or `null`. */
export function internalAddressReason(value: string): string | null {
  const address = normalizeIpAddress(value)
  if (address === null) {
    return 'is not an IP address, so where it points cannot be checked'
  }
  const numeric = ipToBigInt(address)
  if (numeric !== null && METADATA_ADDRESSES.has(numeric)) {
    return 'is a cloud metadata endpoint'
  }
  const scope = ipAddressScope(address)
  if (scope === 'loopback') return 'is a loopback address on the build host'
  if (scope === 'link-local') {
    return 'is link-local, where cloud metadata endpoints live'
  }
  if (scope === null) return 'is not a unicast host address'
  return null
}

/**
 * Why a remote host is internal, or `null` when it may be fetched from. A
 * static check: IP literals, numeric hosts, `localhost`, single-label and
 * reserved-suffix names. A DNS name is not resolved.
 */
export function internalHostReason(rawHost: string): string | null {
  const host = stripTrailingDots(unbracket(rawHost.toLowerCase()))
  if (host === '') return 'names no host'
  if (normalizeIpAddress(host) !== null) {
    const reason = internalAddressReason(host)
    if (reason) return reason
    return ipAddressScope(host) === 'public' ? null : 'is a private address'
  }
  if (host.split('.').every((label) => NUMERIC_LABEL_RE.test(label))) {
    return 'is a numeric host that resolves to an address this check cannot see'
  }
  return hostIsReserved(host) ? 'names an internal host' : null
}
