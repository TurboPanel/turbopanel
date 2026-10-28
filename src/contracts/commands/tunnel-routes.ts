import { isValidIpAddress } from '../../lib/ip-address.ts'
import { ENVELOPE_PREFIX_DAEMON } from '../../lib/secrets/data-encryption.ts'
import { isValidHostname } from './hostname.ts'

/**
 * Tunnel traffic between servers of one datacenter.
 *
 * A tunnel connector on a server hands every visitor to that server's own web
 * server. When the site runs on another server of the datacenter, the web
 * server passes the request on over the datacenter network. Two payloads carry
 * what the daemon needs:
 *
 * - `environment.deploy` hostings may carry `tunnel`, so the server that runs
 *   a site answers its tunnel names only to local connectors and listed peers.
 * - `server.tunnel.routes` is the whole-server list of tunnel names that run
 *   elsewhere, with the servers to pass them to. It also carries the peer
 *   certificate the hop uses.
 *
 * Both are optional on the wire so an older daemon keeps working. Must stay in
 * sync with the daemon twin in `src/contracts/commands-contracts.ts`.
 */

/** The fixed certificate name of the hop between servers. Same on both sides. */
export const TUNNEL_PEER_TLS_NAME = 'tp-peer.internal'

const MAX_TUNNEL_HOSTNAMES = 256
const MAX_TUNNEL_ADDRESSES = 64
const MAX_TUNNEL_ROUTES = 2000
const MAX_TUNNEL_UPSTREAMS = 16
const MAX_TUNNEL_UPSTREAM_ADDRESSES = 8
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** A bare address (no prefix length, no brackets). Peers are exact addresses, never ranges. */
function parseAddressList(
  value: unknown,
  label: string,
  options: { min: number; max: number }
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < options.min ||
    value.length > options.max ||
    !value.every((entry) => isString(entry) && !entry.includes('/') && isValidIpAddress(entry))
  ) {
    throw new TypeError(`Invalid ${label}`)
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value as string[]
}

function parseHostnameList(value: unknown, label: string, min: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > MAX_TUNNEL_HOSTNAMES ||
    !value.every(isValidHostname)
  ) {
    throw new TypeError(`Invalid ${label}`)
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value as string[]
}

/**
 * `environment.deploy` hostings[].tunnel: the tunnel names this hosting
 * answers, and who may reach them.
 */
export type EnvironmentDeployHostingTunnel = {
  /** Tunnel names of this hosting; each is also in the hosting's `hostnames`. */
  hostnames: string[]
  /**
   * Tunnel names that are also public names on this server. They are listed in
   * `hostnames` too; the local-only lock is off for them so the public side
   * answers everyone. Absent = every tunnel name is locked.
   */
  openHostnames?: string[]
  /** Exact datacenter addresses of the servers that may forward to this one. */
  peers: string[]
  /** Addresses the web server must also listen on so peers can reach it. */
  extraBind?: string[]
}

/** Parse hostings[].tunnel. `siteHostnames` are the hosting's own names. */
export function parseDeployHostingTunnel(
  value: unknown,
  siteHostnames: readonly string[]
): EnvironmentDeployHostingTunnel | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('Invalid environment.deploy tunnel')
  const hostnames = parseHostnameList(value.hostnames, 'environment.deploy tunnel hostnames', 1)
  const own = new Set(siteHostnames)
  if (!hostnames.every((name) => own.has(name))) {
    throw new TypeError('Invalid environment.deploy tunnel hostnames')
  }
  const tunnel: EnvironmentDeployHostingTunnel = {
    hostnames,
    peers: parseAddressList(value.peers, 'environment.deploy tunnel peers', {
      min: 1,
      max: MAX_TUNNEL_ADDRESSES,
    }),
  }
  if (value.openHostnames !== undefined) {
    const open = parseHostnameList(
      value.openHostnames,
      'environment.deploy tunnel openHostnames',
      1
    )
    if (!open.every((name) => hostnames.includes(name))) {
      throw new TypeError('Invalid environment.deploy tunnel openHostnames')
    }
    tunnel.openHostnames = open
  }
  if (value.extraBind !== undefined) {
    tunnel.extraBind = parseAddressList(value.extraBind, 'environment.deploy tunnel extraBind', {
      min: 1,
      max: MAX_TUNNEL_ADDRESSES,
    })
  }
  return tunnel
}

/** One server that runs a copy of a site, and where to reach its web server. */
export type TunnelRouteUpstream = {
  serverId: string
  /** Every datacenter address of the server, the preferred family first. Exact, never a range. */
  addresses: string[]
  /** Port of the server's web server on those addresses. Default 443. */
  port?: number
}

export type TunnelRoute = {
  hostname: string
  /**
   * The site runs on this server. The daemon leaves the name out of the
   * forwarding file (the site's own file answers) and reports it as dropped.
   */
  local: boolean
  /**
   * True = only local connectors and listed peers are answered here; anyone
   * else is dropped. False = the name is also public on this server, so every
   * visitor that is not a peer is passed on like a tunnel visitor.
   */
  lock: boolean
  /** Servers that run the site. At least one unless `local` is true. */
  upstreams: TunnelRouteUpstream[]
}

/**
 * The hop's certificate for this server: the same shape as
 * `ManagedApplyOrgTlsMaterial`, plus the expiry. The certificate is a leaf of
 * the organization's certificate authority, `caCertPem` is the trust bundle
 * (active and retired authorities), and the key is sealed for this daemon.
 */
export type TunnelPeerMaterial = {
  certificatePem: string
  privateKeyEnvelope: string
  caCertPem: string
  notAfter?: string
}

/** Must stay in sync with the daemon `server.tunnel.routes` shape. */
export type TunnelRoutesCommandPayload = {
  /** Lower-case sha256 of the desired state; an unchanged hash with the file in place is a no-op. */
  hash: string
  /** Every tunnel name carried by this server, whole set. Empty = no forwarding. */
  routes: TunnelRoute[]
  /** Exact datacenter addresses of the servers that may forward to this one. */
  peerAddresses: string[]
  /** This server's own addresses the peer-facing site must listen on. */
  listenAddresses?: string[]
  /** Required when `routes` or `peerAddresses` is not empty. */
  peerMaterial?: TunnelPeerMaterial
}

/** Must stay in sync with the daemon `server.tunnel.routes` shape. */
export type TunnelRoutesCommandResult = {
  hash: string
  /** The files were written (or removed). False when the hash and files were already current. */
  applied: boolean
  /** Forwarded names now in the file. */
  routeCount: number
  /** Names left out because the site runs on this server. */
  dropped: string[]
  warnings: string[]
}

function parseTunnelUpstream(value: unknown): TunnelRouteUpstream {
  if (!isRecord(value) || !isString(value.serverId) || !UUID_RE.test(value.serverId)) {
    throw new TypeError('Invalid server.tunnel.routes upstream')
  }
  const upstream: TunnelRouteUpstream = {
    serverId: value.serverId,
    addresses: parseAddressList(value.addresses, 'server.tunnel.routes upstream addresses', {
      min: 1,
      max: MAX_TUNNEL_UPSTREAM_ADDRESSES,
    }),
  }
  if (value.port !== undefined) {
    if (
      typeof value.port !== 'number' ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535
    ) {
      throw new TypeError('Invalid server.tunnel.routes upstream port')
    }
    upstream.port = value.port
  }
  return upstream
}

function parseTunnelRoute(value: unknown): TunnelRoute {
  if (
    !isRecord(value) ||
    !isValidHostname(value.hostname) ||
    typeof value.local !== 'boolean' ||
    typeof value.lock !== 'boolean' ||
    !Array.isArray(value.upstreams) ||
    value.upstreams.length > MAX_TUNNEL_UPSTREAMS
  ) {
    throw new TypeError('Invalid server.tunnel.routes route')
  }
  const upstreams = value.upstreams.map(parseTunnelUpstream)
  if (!value.local && upstreams.length === 0) {
    throw new TypeError('Invalid server.tunnel.routes route: a remote site needs an upstream')
  }
  if (new Set(upstreams.map((upstream) => upstream.serverId)).size !== upstreams.length) {
    throw new TypeError('Invalid server.tunnel.routes route upstreams')
  }
  return {
    hostname: value.hostname as string,
    local: value.local,
    lock: value.lock,
    upstreams,
  }
}

function parseTunnelPeerMaterial(value: unknown): TunnelPeerMaterial {
  if (
    !isRecord(value) ||
    !isString(value.certificatePem) ||
    !value.certificatePem.includes('BEGIN CERTIFICATE') ||
    !isString(value.privateKeyEnvelope) ||
    !value.privateKeyEnvelope.startsWith(ENVELOPE_PREFIX_DAEMON) ||
    !isString(value.caCertPem) ||
    !value.caCertPem.includes('BEGIN CERTIFICATE')
  ) {
    throw new TypeError('Invalid server.tunnel.routes peerMaterial')
  }
  const material: TunnelPeerMaterial = {
    certificatePem: value.certificatePem,
    privateKeyEnvelope: value.privateKeyEnvelope,
    caCertPem: value.caCertPem,
  }
  if (value.notAfter !== undefined) {
    if (!isString(value.notAfter) || Number.isNaN(Date.parse(value.notAfter))) {
      throw new TypeError('Invalid server.tunnel.routes peerMaterial notAfter')
    }
    material.notAfter = value.notAfter
  }
  return material
}

export function parseTunnelRoutesPayload(value: unknown): TunnelRoutesCommandPayload {
  if (!isRecord(value)) throw new TypeError('Invalid server.tunnel.routes payload')
  if (!isString(value.hash) || !SHA256_HEX_RE.test(value.hash)) {
    throw new TypeError('Invalid server.tunnel.routes hash')
  }
  if (!Array.isArray(value.routes) || value.routes.length > MAX_TUNNEL_ROUTES) {
    throw new TypeError('Invalid server.tunnel.routes routes')
  }
  const routes = value.routes.map(parseTunnelRoute)
  if (new Set(routes.map((route) => route.hostname)).size !== routes.length) {
    throw new TypeError('Invalid server.tunnel.routes routes')
  }
  const peerAddresses =
    Array.isArray(value.peerAddresses) && value.peerAddresses.length === 0
      ? []
      : parseAddressList(value.peerAddresses, 'server.tunnel.routes peerAddresses', {
          min: 1,
          max: MAX_TUNNEL_ADDRESSES,
        })
  const payload: TunnelRoutesCommandPayload = { hash: value.hash, routes, peerAddresses }
  if (value.listenAddresses !== undefined) {
    payload.listenAddresses = parseAddressList(
      value.listenAddresses,
      'server.tunnel.routes listenAddresses',
      { min: 1, max: MAX_TUNNEL_ADDRESSES }
    )
  }
  if (value.peerMaterial !== undefined) {
    payload.peerMaterial = parseTunnelPeerMaterial(value.peerMaterial)
  }
  const needsMaterial = routes.length > 0 || peerAddresses.length > 0
  if (needsMaterial && !payload.peerMaterial) {
    throw new TypeError('Invalid server.tunnel.routes peerMaterial: required with routes or peers')
  }
  if (routes.some((route) => !route.local) && peerAddresses.length === 0) {
    throw new TypeError('Invalid server.tunnel.routes peerAddresses: required for forwarding')
  }
  return payload
}

export function parseTunnelRoutesResult(value: unknown): TunnelRoutesCommandResult {
  if (
    !isRecord(value) ||
    !isString(value.hash) ||
    !SHA256_HEX_RE.test(value.hash) ||
    typeof value.applied !== 'boolean' ||
    typeof value.routeCount !== 'number' ||
    !Number.isInteger(value.routeCount) ||
    value.routeCount < 0 ||
    !Array.isArray(value.dropped) ||
    !value.dropped.every(isString) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isString)
  ) {
    throw new TypeError('Invalid server.tunnel.routes result')
  }
  return {
    hash: value.hash,
    applied: value.applied,
    routeCount: value.routeCount,
    dropped: value.dropped as string[],
    warnings: value.warnings as string[],
  }
}
