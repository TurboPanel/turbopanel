/**
 * Where a daemon connects from, and which address to show for it.
 *
 * Two separate questions, answered here so every transport agrees:
 *
 * 1. **Connect time** — `resolvePeerAddress()` turns request headers into
 *    the peer address, honouring `CF-Connecting-IP` only when the immediate
 *    peer is a trusted local proxy (a Cloudflare Tunnel connector, or the
 *    co-located Caddy in front of the Unix socket). A daemon dialling Caddy
 *    directly cannot forge its own address by sending those headers.
 *
 * 2. **Read time** — `resolveServerAddress()` picks the address to display,
 *    because the address on the wire is not always the host's address. Behind a
 *    reverse proxy on the same box, or through a forwarded port (every
 *    development Vagrant guest), the wire address is `127.0.0.1` for *every*
 *    server. When the observed address is that kind of artifact, the
 *    daemon-reported interface addresses are the better answer.
 */

import {
  addressInCidr,
  ipAddressScope,
  isRoutableHostAddress,
  isValidCidr,
  normalizeIpAddress,
} from './ip-address.ts'
import {
  bestReportedAddress,
  type ServerReportedIp,
} from '../server-addresses.ts'

/**
 * Peer addresses the instance will read forwarding headers from.
 *
 * Loopback only by default. The Deno instance listens on a Unix socket, so its
 * only direct callers are local processes: Caddy, or a `cloudflared` connector
 * beside it. Anything arriving with a non-loopback `X-Real-IP` reached Caddy
 * over the network and speaks only for itself.
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
] as const

/**
 * Parse `TURBOPANEL_TRUSTED_PROXY_CIDRS` (comma-separated). Invalid entries are
 * dropped rather than widening trust; an empty or absent value keeps the
 * loopback default.
 */
export function parseTrustedProxyCidrs(
  value: string | null | undefined,
): string[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isValidCidr(entry))
  return entries.length > 0 ? entries : [...DEFAULT_TRUSTED_PROXY_CIDRS]
}

export function isTrustedProxyAddress(
  address: string,
  trustedProxyCidrs: readonly string[] = DEFAULT_TRUSTED_PROXY_CIDRS,
): boolean {
  const normalized = normalizeIpAddress(address)
  if (!normalized) return false
  return trustedProxyCidrs.some((cidr) => addressInCidr(normalized, cidr))
}

/** How the control plane learned the peer address. */
export type PeerAddressSource =
  /** `CF-Connecting-IP` from a trusted Cloudflare edge or Tunnel connector. */
  | 'cloudflare'
  /** `X-Forwarded-For`, via a trusted local proxy. */
  | 'forwarded'
  /** The proxy's own view of its peer (`X-Real-IP`). */
  | 'direct'

export type ResolvedPeerAddress = {
  address: string
  source: PeerAddressSource
}

/** Request headers that can carry a peer address, already read off the wire. */
export type PeerAddressHeaders = {
  /** Stamped by the local reverse proxy — its own socket peer. */
  realIp?: string | null
  forwardedFor?: string | null
  cfConnectingIp?: string | null
}

function routableOrNull(value: string | null | undefined): string | null {
  const address = normalizeIpAddress(value)
  return address && isRoutableHostAddress(address) ? address : null
}

export type ResolvePeerAddressOptions = {
  runtime: 'deno' | 'workers'
  trustedProxyCidrs?: readonly string[]
}

/**
 * Leftmost routable address in an `X-Forwarded-For` list.
 *
 * Loopback entries are skipped rather than returned: Caddy synthesizes
 * `X-Forwarded-For: 127.0.0.1` for a loopback peer, and taking that would
 * shadow the `X-Real-IP` we would otherwise fall through to.
 */
function firstForwardedAddress(value: string | null | undefined): string | null {
  for (const entry of (value ?? '').split(',')) {
    const address = normalizeIpAddress(entry)
    if (address && isRoutableHostAddress(address)) return address
  }
  return null
}

/**
 * Resolve the address a daemon is connecting from.
 *
 * Returns `null` when no header identifies a peer at all — a co-located daemon
 * dialling the Unix socket. Callers map that to their own local-attach
 * sentinel; it is not an error.
 */
export function resolvePeerAddress(
  headers: PeerAddressHeaders,
  options: ResolvePeerAddressOptions,
): ResolvedPeerAddress | null {
  // A forwarding header that names a loopback address describes the proxy, not
  // the caller — it must not shadow the address we would otherwise fall back to.
  const cfConnectingIp = routableOrNull(headers.cfConnectingIp)

  // Workers: the edge stamps CF-Connecting-IP and strips any client copy, so it
  // is the only trustworthy value and no local proxy is in play.
  if (options.runtime === 'workers') {
    return cfConnectingIp
      ? { address: cfConnectingIp, source: 'cloudflare' }
      : null
  }

  const trusted = options.trustedProxyCidrs ?? DEFAULT_TRUSTED_PROXY_CIDRS
  const realIp = normalizeIpAddress(headers.realIp)

  // No X-Real-IP means nothing stood between us and the caller: the Unix
  // socket, reachable only by a local process. A local process is trusted, so
  // forwarding headers from a connector that dialled the socket still count.
  const peerIsTrusted = realIp === null || isTrustedProxyAddress(realIp, trusted)

  if (peerIsTrusted) {
    if (cfConnectingIp) return { address: cfConnectingIp, source: 'cloudflare' }
    const forwarded = firstForwardedAddress(headers.forwardedFor)
    if (forwarded) return { address: forwarded, source: 'forwarded' }
  }

  return realIp ? { address: realIp, source: 'direct' } : null
}

/** Which fact the displayed address came from. */
export type ServerAddressSource =
  /** Daemon shares a host with the control plane; it dialled the Unix socket. */
  | 'local'
  /** The address the control plane saw the daemon connect from. */
  | 'observed'
  /** A host interface the daemon reported, used when the wire address was an
   *  artifact of a proxy or a forwarded port. */
  | 'interface'

export type ResolvedServerAddress = {
  address: string
  source: ServerAddressSource
  scope: 'public' | 'private'
  /** Host interface the address belongs to, when it came from a daemon report. */
  interface?: string
  /** The observed address also appears in the daemon's own interface list. */
  confirmed?: boolean
}

export type ResolveServerAddressParams = {
  /** Peer address stored on the daemon projection (`__direct__` when local). */
  remoteAddress?: string | null
  /** Host interfaces the daemon reported in hello / heartbeat. */
  ips?: readonly ServerReportedIp[] | null
}

/** Sentinel stored for a daemon that dialled the local Unix socket. */
export const DIRECT_ATTACH_SENTINEL = '__direct__'

function reportedAddressToResolved(
  reported: ServerReportedIp,
): ResolvedServerAddress {
  return {
    address: reported.address,
    source: 'interface',
    scope: reported.scope,
    ...(reported.interface ? { interface: reported.interface } : {}),
  }
}

function findReportedIp(
  ips: readonly ServerReportedIp[],
  address: string,
): ServerReportedIp | undefined {
  return ips.find((row) => row.address === address)
}

function observedResolved(
  address: string,
  scope: 'public' | 'private',
  match?: ServerReportedIp,
): ResolvedServerAddress {
  const resolved: ResolvedServerAddress = { address, source: 'observed', scope }
  if (!match) return resolved
  if (match.interface) resolved.interface = match.interface
  resolved.confirmed = true
  return resolved
}

/**
 * Steps 2–3: a public wire address, or a private one the daemon also reports.
 * Unmatched private stays for after the interface fallback (step 5).
 */
function preferredObservedAddress(
  observed: string,
  ips: readonly ServerReportedIp[],
): ResolvedServerAddress | null {
  const scope = ipAddressScope(observed)
  const match = findReportedIp(ips, observed)
  if (scope === 'public') return observedResolved(observed, 'public', match)
  if (scope === 'private' && match) {
    return observedResolved(observed, 'private', match)
  }
  return null
}

/**
 * Pick the address to show for a server.
 *
 * Order, and why:
 *
 * 1. `__direct__` — co-located, there is no network address to show.
 * 2. A **public** observed address. Nothing beats seeing the host connect from
 *    a routable address; this is the Cloudflare Tunnel and remote-worker case.
 * 3. An observed address the daemon **also reports on one of its interfaces**.
 *    Exact agreement between both sides — the same-LAN case.
 * 4. The daemon's own best interface address. Reached when the observed address
 *    was loopback (local reverse proxy, or a development forwarded port) or
 *    link-local, so it identified the proxy rather than the host.
 * 5. An unmatched **private** observed address — the host is behind NAT that we
 *    cannot see past, but the address is still the closest thing to its
 *    location on the network.
 */
export function resolveServerAddress(
  params: ResolveServerAddressParams,
): ResolvedServerAddress | null {
  const raw = params.remoteAddress?.trim() ?? ''
  if (raw === DIRECT_ATTACH_SENTINEL) {
    return { address: DIRECT_ATTACH_SENTINEL, source: 'local', scope: 'private' }
  }

  const ips = [...(params.ips ?? [])]
  const observed = normalizeIpAddress(raw)
  const preferred = observed ? preferredObservedAddress(observed, ips) : null
  if (preferred) return preferred

  const reported = bestReportedAddress(ips)
  if (reported) return reportedAddressToResolved(reported)
  if (observed && ipAddressScope(observed) === 'private') {
    return observedResolved(observed, 'private')
  }
  return null
}
