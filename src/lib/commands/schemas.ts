import { isValidHostname, HOSTNAME_MAX_LENGTH } from './hostname.ts'
import { isValidIpAddress } from '../ip-address.ts'
import { isValidTimezone } from '../timezones.ts'
import {
  assertValidWireguardInterfaceName,
  isValidWireguardAllowedIp,
  isValidWireguardEndpoint,
  isValidWireguardListenPort,
  isValidWireguardPublicKey,
} from './wireguard.ts'
import type { CommandType } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/

/** Dotted-quad shape (octets validated separately). Daemon parity. */
const IPV4_SHAPE_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

/** Must stay in sync with the daemon `server.ntp.set` validator. */
function isValidIpv4Literal(value: string): boolean {
  if (!IPV4_SHAPE_RE.test(value)) return false
  const octets = value.split('.')
  for (const octet of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return false
    const n = Number(octet)
    if (n > 255) return false
  }
  return true
}

/**
 * Conservative IPv6 literal check (RFC 4291 / RFC 5952 shapes).
 * Must stay in sync with the daemon `server.ntp.set` validator.
 */
function isValidIpv6Literal(value: string): boolean {
  if (!value.includes(':')) return false
  if (value.includes('%')) return false
  if (value.includes(':::')) return false

  const sides = value.split('::')
  if (sides.length > 2) return false

  const parseSide = (side: string): number | null => {
    if (side === '') return 0
    const parts = side.split(':')
    let hextets = 0
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      if (part.includes('.')) {
        if (i !== parts.length - 1) return null
        if (!isValidIpv4Literal(part)) return null
        hextets += 2
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
      hextets += 1
    }
    return hextets
  }

  if (sides.length === 1) {
    const count = parseSide(sides[0]!)
    return count === 8
  }

  const left = parseSide(sides[0]!)
  const right = parseSide(sides[1]!)
  if (left === null || right === null) return false
  return left + right < 8
}

/** Must stay in sync with the daemon `server.ntp.set` validator. */
export function isValidNtpServer(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0) return false
  if (value.length > HOSTNAME_MAX_LENGTH) return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  if (IPV4_SHAPE_RE.test(value)) return isValidIpv4Literal(value)
  if (value.includes(':')) return isValidIpv6Literal(value)
  if (isValidHostname(value)) return true
  return false
}

export type PingCommandPayload = Record<string, never>

export type RebootCommandPayload = Record<string, never>

export type HostnameSetCommandPayload = {
  hostname: string
}

export function parsePingPayload(value: unknown): PingCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid ping payload')
  }
  return {}
}

export function parseRebootPayload(value: unknown): RebootCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid reboot payload')
  }
  return {}
}

export function parseHostnameSetPayload(value: unknown): HostnameSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid hostname set payload')
  }
  const hostname = value.hostname
  if (!isString(hostname) || hostname.length === 0 || !isValidHostname(hostname)) {
    throw new Error('Invalid hostname set payload')
  }
  return { hostname }
}

export type PingCommandResult = {
  apiAcceptedAt?: string
  queuedAt?: string
  consumerReceivedAt?: string
  cellEnqueuedAt?: string
  /** Instance-side WS send time from the cell outbox pump (`markSent`). */
  cellDispatchedAt?: string
  daemonReceivedAt?: string
  daemonRespondedAt?: string
  resultRecordedAt?: string
  daemonHostname?: string
  daemonBuild?: {
    commit?: string
    buildId?: string
    builtAt?: string
    channel?: string
  }
}

export type HostnameSetCommandResult = {
  observedHostname: string
  summary?: string
}

export type RebootCommandResult = {
  scheduled: boolean
  summary?: string
}

/** Must stay in sync with the daemon `server.timezone.set` shape. */
export type TimezoneSetCommandPayload = {
  timezone: string
}

/** Must stay in sync with the daemon `server.timezone.set` shape. */
export type TimezoneSetCommandResult = {
  timezone: string
  summary?: string
}

/** Must stay in sync with the daemon `server.ntp.set` shape. */
export type NtpSetCommandPayload = {
  enabled?: boolean
  servers?: string[]
  fallbackServers?: string[]
}

/** Must stay in sync with the daemon `server.ntp.set` shape. */
export type NtpSetCommandResult = {
  ntpEnabled?: boolean
  ntpSynced?: boolean
  ntpServers: string[]
  fallbackNtpServers?: string[]
  summary?: string
}

export function parseTimezoneSetPayload(value: unknown): TimezoneSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid timezone set payload')
  }
  const timezone = value.timezone
  if (!isString(timezone) || timezone.length === 0 || !isValidTimezone(timezone)) {
    throw new Error('Invalid timezone set payload')
  }
  return { timezone }
}

export function parseTimezoneSetResult(value: unknown): TimezoneSetCommandResult {
  if (!isRecord(value)) {
    throw new Error('Invalid timezone set result')
  }
  const timezone = value.timezone
  if (!isString(timezone) || timezone.length === 0) {
    throw new Error('Invalid timezone set result')
  }
  const result: TimezoneSetCommandResult = { timezone }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

function parseOptionalNtpServerList(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of server hostnames or IPs`)
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be empty when provided`)
  }
  const servers: string[] = []
  for (const entry of value) {
    if (!isValidNtpServer(entry)) {
      throw new Error(`Invalid NTP server in ${field}`)
    }
    servers.push(entry as string)
  }
  return servers
}

export function parseNtpSetPayload(value: unknown): NtpSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid ntp set payload')
  }
  const payload: NtpSetCommandPayload = {}

  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean')
    }
    payload.enabled = value.enabled
  }

  const servers = parseOptionalNtpServerList(value.servers, 'servers')
  if (servers !== undefined) payload.servers = servers

  const fallbackServers = parseOptionalNtpServerList(
    value.fallbackServers,
    'fallbackServers',
  )
  if (fallbackServers !== undefined) payload.fallbackServers = fallbackServers

  if (
    payload.enabled === undefined &&
    payload.servers === undefined &&
    payload.fallbackServers === undefined
  ) {
    throw new Error(
      'ntp payload must include enabled, servers, and/or fallbackServers',
    )
  }

  return payload
}

function parseRequiredNtpServerList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of server hostnames or IPs`)
  }
  const servers: string[] = []
  for (const entry of value) {
    if (!isValidNtpServer(entry)) {
      throw new Error(`Invalid NTP server in ${field}`)
    }
    servers.push(entry as string)
  }
  return servers
}

export function parseNtpSetResult(value: unknown): NtpSetCommandResult {
  if (!isRecord(value)) {
    throw new Error('Invalid ntp set result')
  }
  const result: NtpSetCommandResult = {
    ntpServers: parseRequiredNtpServerList(value.ntpServers, 'ntpServers'),
  }
  if (typeof value.ntpEnabled === 'boolean') result.ntpEnabled = value.ntpEnabled
  if (typeof value.ntpSynced === 'boolean') result.ntpSynced = value.ntpSynced
  const fallback = parseOptionalNtpServerList(
    value.fallbackNtpServers,
    'fallbackNtpServers',
  )
  if (fallback !== undefined) result.fallbackNtpServers = fallback
  if (isString(value.summary)) result.summary = value.summary
  return result
}

function parseDaemonBuild(value: unknown): PingCommandResult['daemonBuild'] {
  if (!isRecord(value)) {
    return undefined
  }
  const build: NonNullable<PingCommandResult['daemonBuild']> = {}
  if (isString(value.commit)) build.commit = value.commit
  if (isString(value.buildId)) build.buildId = value.buildId
  if (isString(value.builtAt)) build.builtAt = value.builtAt
  if (isString(value.channel)) build.channel = value.channel
  return Object.keys(build).length > 0 ? build : undefined
}

export function parsePingResult(value: unknown): PingCommandResult {
  if (!isRecord(value)) {
    return {}
  }
  const result: PingCommandResult = {}
  if (isString(value.apiAcceptedAt)) result.apiAcceptedAt = value.apiAcceptedAt
  if (isString(value.queuedAt)) result.queuedAt = value.queuedAt
  if (isString(value.consumerReceivedAt)) result.consumerReceivedAt = value.consumerReceivedAt
  if (isString(value.cellEnqueuedAt)) result.cellEnqueuedAt = value.cellEnqueuedAt
  if (isString(value.cellDispatchedAt)) {
    result.cellDispatchedAt = value.cellDispatchedAt
  }
  if (isString(value.daemonReceivedAt)) result.daemonReceivedAt = value.daemonReceivedAt
  if (isString(value.daemonRespondedAt)) result.daemonRespondedAt = value.daemonRespondedAt
  if (isString(value.resultRecordedAt)) result.resultRecordedAt = value.resultRecordedAt
  if (isString(value.daemonHostname)) result.daemonHostname = value.daemonHostname
  const daemonBuild = parseDaemonBuild(value.daemonBuild)
  if (daemonBuild) result.daemonBuild = daemonBuild
  return result
}

export function parseHostnameSetResult(value: unknown): HostnameSetCommandResult {
  if (!isRecord(value)) {
    throw new Error('Invalid hostname set result')
  }
  const observedHostname = value.observedHostname
  if (!isString(observedHostname) || observedHostname.length === 0) {
    throw new Error('Invalid hostname set result')
  }
  const result: HostnameSetCommandResult = { observedHostname }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

export function parseRebootResult(value: unknown): RebootCommandResult {
  if (!isRecord(value)) {
    return { scheduled: false }
  }
  const result: RebootCommandResult = {
    scheduled: value.scheduled === true,
  }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

/** Must stay in sync with the daemon `server.wireguard.apply` shape. */
export type WireguardApplyPeerMaterial = {
  peerId: string
  publicKey: string
  allowedIps: string[]
  endpoint?: string
  persistentKeepalive?: number
  presharedKeyEnvelope?: string
}

/** Must stay in sync with the daemon `server.wireguard.apply` shape. */
export type WireguardApplyCommandPayload = {
  vpnId: string
  peerId: string
  interfaceName: string
  address: string
  listenPort?: number
  /** When true, the daemon enables host IP forwarding (primary gateway). */
  enableIpForwarding?: boolean
  peers: WireguardApplyPeerMaterial[]
}

/** Must stay in sync with the daemon `server.wireguard.apply` shape. */
export type WireguardApplyCommandResult = {
  interfaceName: string
  publicKey: string
  listenPort?: number
  applied: boolean
  summary?: string
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseWireguardUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`Invalid wireguard ${field}`)
  }
  return value
}

function parseWireguardPeerEntry(value: unknown): WireguardApplyPeerMaterial {
  if (!isRecord(value)) {
    throw new Error('Invalid wireguard peer entry')
  }
  const peerId = parseWireguardUuid(value.peerId, 'peerId')
  const publicKey = value.publicKey
  if (!isString(publicKey) || !isValidWireguardPublicKey(publicKey)) {
    throw new Error('Invalid wireguard peer publicKey')
  }
  if (!Array.isArray(value.allowedIps) || value.allowedIps.length === 0) {
    throw new Error('Invalid wireguard peer allowedIps')
  }
  const allowedIps: string[] = []
  for (const entry of value.allowedIps) {
    if (!isValidWireguardAllowedIp(entry)) {
      throw new Error('Invalid wireguard peer allowedIps')
    }
    allowedIps.push((entry as string).trim())
  }
  const material: WireguardApplyPeerMaterial = { peerId, publicKey, allowedIps }
  if (value.endpoint !== undefined) {
    if (!isString(value.endpoint) || !isValidWireguardEndpoint(value.endpoint)) {
      throw new Error('Invalid wireguard peer endpoint')
    }
    material.endpoint = value.endpoint
  }
  if (value.persistentKeepalive !== undefined) {
    if (
      typeof value.persistentKeepalive !== 'number' ||
      !Number.isInteger(value.persistentKeepalive) ||
      value.persistentKeepalive < 0 ||
      value.persistentKeepalive > 65535
    ) {
      throw new Error('Invalid wireguard peer persistentKeepalive')
    }
    material.persistentKeepalive = value.persistentKeepalive
  }
  if (value.presharedKeyEnvelope !== undefined) {
    if (
      !isString(value.presharedKeyEnvelope) ||
      value.presharedKeyEnvelope.length === 0
    ) {
      throw new Error('Invalid wireguard peer presharedKeyEnvelope')
    }
    material.presharedKeyEnvelope = value.presharedKeyEnvelope
  }
  return material
}

export function parseWireguardApplyPayload(value: unknown): WireguardApplyCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid wireguard apply payload')
  }
  const vpnId = parseWireguardUuid(value.vpnId, 'vpnId')
  const peerId = parseWireguardUuid(value.peerId, 'peerId')
  const interfaceName = value.interfaceName
  assertValidWireguardInterfaceName(interfaceName)
  const address = value.address
  if (!isString(address) || address.length === 0 || !isValidWireguardAllowedIp(address)) {
    throw new Error('Invalid wireguard apply address')
  }
  if (!Array.isArray(value.peers)) {
    throw new TypeError('Invalid wireguard apply peers')
  }
  const peers = value.peers.map(parseWireguardPeerEntry)
  const payload: WireguardApplyCommandPayload = {
    vpnId,
    peerId,
    interfaceName,
    address: address.trim(),
    peers,
  }
  if (value.listenPort !== undefined) {
    if (!isValidWireguardListenPort(value.listenPort)) {
      throw new Error('Invalid wireguard apply listenPort')
    }
    payload.listenPort = value.listenPort
  }
  if (value.enableIpForwarding !== undefined) {
    if (typeof value.enableIpForwarding !== 'boolean') {
      throw new TypeError('Invalid wireguard apply enableIpForwarding')
    }
    payload.enableIpForwarding = value.enableIpForwarding
  }
  return payload
}

export function parseWireguardApplyResult(value: unknown): WireguardApplyCommandResult {
  if (!isRecord(value)) {
    throw new Error('Invalid wireguard apply result')
  }
  const interfaceName = value.interfaceName
  assertValidWireguardInterfaceName(interfaceName)
  const publicKey = value.publicKey
  if (!isString(publicKey) || !isValidWireguardPublicKey(publicKey)) {
    throw new Error('Invalid wireguard apply result publicKey')
  }
  if (typeof value.applied !== 'boolean') {
    throw new TypeError('Invalid wireguard apply result applied')
  }
  const result: WireguardApplyCommandResult = {
    interfaceName,
    publicKey,
    applied: value.applied,
  }
  if (value.listenPort !== undefined) {
    if (!isValidWireguardListenPort(value.listenPort)) {
      throw new Error('Invalid wireguard apply result listenPort')
    }
    result.listenPort = value.listenPort
  }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

export type EnvironmentDeployTlsMaterial = {
  tlsId: string
  /** Public leaf + intermediate chain PEM. */
  certificatePem: string
  /** Daemon-recipient sealed private key (`tpdaemon.v1…`). */
  privateKeyEnvelope: string
}

export type EnvironmentDeployHostingProxy = {
  forceHttps?: boolean
  gzip?: boolean
  brotli?: boolean
  stripPrefix?: string
}

export type EnvironmentDeployVariableMaterial = {
  key: string
  composeServiceName: string | null
  forBuild: boolean
  forRuntime: boolean
  isLiteral: boolean
  valueEnvelope: string
}

export type EnvironmentDeployStorageMaterial = {
  storageId: string
  kind: 'docker_volume' | 'bind_mount' | 'file' | 'directory'
  name: string
  sourcePath?: string
  destinationPath: string
  principalId?: string
  serviceId?: string
  composeServiceName?: string
  serverId: string
  contentEnvelope?: string
}

export type EnvironmentDeployPrincipalMaterial = {
  principalId: string
  username: string
  uid: number
  gid: number
  home?: string
}

export type EnvironmentDeployServiceHook = {
  composeServiceName: string
  preDeployCommand?: string
  postDeployCommand?: string
  buildDisableCache?: boolean
}

export type EnvironmentDeployHostingPhp = {
  version?: string
  memoryLimit?: string
  maxExecutionTime?: number
}

/**
 * Project principal that owns a traditional-web site tree on the host.
 * Daemon `ensureSystemPrincipals` creates the Linux user before apply;
 * document roots are `chown`ed to this user with the engine group for read.
 */
export type EnvironmentDeployTraditionalWebPrincipal = {
  principalId: string
  username: string
  uid: number
  gid: number
}

export type EnvironmentDeployTraditionalWebSite = {
  composeServiceName: string
  engine: 'apache' | 'nginx' | 'openlitespeed'
  /** Relative document-root segment under the site directory. */
  root: string
  /** Loopback port hosting Caddy reverse-proxies to. */
  listenPort: number
  /** Merged hosting web env (variables + options.web.env). */
  webEnv?: Record<string, string>
  php?: EnvironmentDeployHostingPhp
  /**
   * When set (from a project principal ↔ service assignment), the site tree
   * is owned by this principal and Apache php-fpm workers run as that user.
   */
  principal?: EnvironmentDeployTraditionalWebPrincipal
}

export type EnvironmentDeployCommandPayload = {
  environmentId: string
  projectId: string
  organizationId: string
  projectName: string
  /** Runtime docker-compose YAML (presentation stripped). May be `services: {}` when all sites are traditional-web. */
  composeYaml: string
  /** Public hosting routes to wire through Traefik + edge Caddy. */
  hostings: EnvironmentDeployHosting[]
  /**
   * Host-native web sites (nginx MVP). Compose services with
   * `x-turbopanel.serviceKind: traditional-web` are stripped from `composeYaml`
   * and listed here instead.
   */
  traditionalWebSites?: EnvironmentDeployTraditionalWebSite[]
  /** External Docker networks referenced in compose — ensured on the host before compose up. */
  dockerExternalNetworks?: string[]
  /** Unique TLS material referenced by `hostings[].tlsId` (deduped). */
  tlsMaterial?: EnvironmentDeployTlsMaterial[]
  variableMaterial?: EnvironmentDeployVariableMaterial[]
  storageMaterial?: EnvironmentDeployStorageMaterial[]
  principalMaterial?: EnvironmentDeployPrincipalMaterial[]
  serviceHooks?: EnvironmentDeployServiceHook[]
}

export type EnvironmentDeployHostingPort = {
  /** Host/entrypoint port exposed by Traefik. */
  published: number
  /** Container port the compose service listens on. */
  target: number
}

export type EnvironmentDeployHostingWeb = {
  env?: Record<string, string>
  php?: EnvironmentDeployHostingPhp
}

export type EnvironmentDeployHosting = {
  hostingId: string
  serviceId: string
  composeServiceName: string
  hostnames: string[]
  pathPrefix?: string
  /** Container port Traefik should target (default 80). */
  targetPort?: number
  /** Resolved org TLS id when pinned; null/omit = Caddy `tls internal` (self-signed). */
  tlsId?: string | null
  proxy?: EnvironmentDeployHostingProxy
  /**
   * Resolved Caddy `bind` address for this hosting (public pinned IP, datacenter
   * private IP, or loopback). Omitted when bind is public with no pin.
   */
  bindAddress?: string
  /**
   * `http` (default/omitted) routes `hostnames` through Traefik + edge Caddy.
   * `tcp` / `udp` publish `ports[]` straight through Traefik — no hostname/TLS
   * routing.
   */
  protocol?: 'http' | 'tcp' | 'udp'
  /** Required (non-empty) when `protocol` is `tcp` or `udp`; ignored for `http`. */
  ports?: EnvironmentDeployHostingPort[]
  /** Merged hosting web env + PHP hints for traditional-web materialization. */
  web?: EnvironmentDeployHostingWeb
}

export type EnvironmentDeployContainer = {
  /** Present when the compose service appears in `payload.hostings`. */
  serviceId?: string
  composeServiceName: string
  containerId: string
  containerName: string
  status: string
}

export type EnvironmentDeployCommandResult = {
  projectName: string
  summary?: string
  services?: string[]
  containers?: EnvironmentDeployContainer[]
}

const MAX_ENVIRONMENT_DEPLOY_CONTAINERS = 100

function requireDeployPayloadStrings(
  value: Record<string, unknown>,
): Pick<
  EnvironmentDeployCommandPayload,
  'environmentId' | 'projectId' | 'organizationId' | 'projectName' | 'composeYaml'
> {
  const { environmentId, projectId, organizationId, projectName, composeYaml } = value
  if (
    !isString(environmentId) ||
    !isString(projectId) ||
    !isString(organizationId) ||
    !isString(projectName) ||
    !isString(composeYaml) ||
    composeYaml.length === 0
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  return { environmentId, projectId, organizationId, projectName, composeYaml }
}

function parseDeployHostingProxy(
  value: unknown,
): EnvironmentDeployHostingProxy | undefined {
  if (!isRecord(value)) return undefined
  const proxy: EnvironmentDeployHostingProxy = {}
  if (typeof value.forceHttps === 'boolean') proxy.forceHttps = value.forceHttps
  if (typeof value.gzip === 'boolean') proxy.gzip = value.gzip
  if (typeof value.brotli === 'boolean') proxy.brotli = value.brotli
  if (isString(value.stripPrefix)) proxy.stripPrefix = value.stripPrefix
  return Object.keys(proxy).length > 0 ? proxy : undefined
}

const DEPLOY_HOSTING_PROTOCOLS = new Set(['http', 'tcp', 'udp'])

function parseDeployHostingProtocol(
  value: unknown,
): EnvironmentDeployHosting['protocol'] | undefined {
  if (value === undefined) return undefined
  if (!isString(value) || !DEPLOY_HOSTING_PROTOCOLS.has(value)) {
    throw new Error('Invalid environment.deploy payload')
  }
  return value as EnvironmentDeployHosting['protocol']
}

function isValidDeployPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function parseDeployHostingPortEntry(entry: unknown): EnvironmentDeployHostingPort {
  if (!isRecord(entry) || !isValidDeployPort(entry.published) || !isValidDeployPort(entry.target)) {
    throw new Error('Invalid environment.deploy payload')
  }
  return { published: entry.published, target: entry.target }
}

function parseDeployHostingPorts(
  value: unknown,
): EnvironmentDeployHostingPort[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid environment.deploy payload')
  }
  return value.map(parseDeployHostingPortEntry)
}

function parseDeployHostingPhp(value: unknown): EnvironmentDeployHostingPhp | undefined {
  if (!isRecord(value)) return undefined
  const php: EnvironmentDeployHostingPhp = {}
  if (isString(value.version)) php.version = value.version
  if (isString(value.memoryLimit)) php.memoryLimit = value.memoryLimit
  if (typeof value.maxExecutionTime === 'number' && Number.isInteger(value.maxExecutionTime)) {
    php.maxExecutionTime = value.maxExecutionTime
  }
  return Object.keys(php).length > 0 ? php : undefined
}

function parseDeployHostingWebEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isString(raw)) continue
    env[key] = raw
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function parseDeployHostingWeb(value: unknown): EnvironmentDeployHostingWeb | undefined {
  if (!isRecord(value)) return undefined
  const web: EnvironmentDeployHostingWeb = {}
  const env = parseDeployHostingWebEnv(value.env)
  if (env) web.env = env
  const php = parseDeployHostingPhp(value.php)
  if (php) web.php = php
  return Object.keys(web).length > 0 ? web : undefined
}

function applyOptionalDeployHostingFields(
  hosting: EnvironmentDeployHosting,
  entry: Record<string, unknown>,
): void {
  if (isString(entry.pathPrefix)) hosting.pathPrefix = entry.pathPrefix
  if (typeof entry.targetPort === 'number' && Number.isFinite(entry.targetPort)) {
    hosting.targetPort = entry.targetPort
  }
  if (entry.tlsId === null) {
    hosting.tlsId = null
  } else if (isString(entry.tlsId)) {
    hosting.tlsId = entry.tlsId
  }
  const proxy = parseDeployHostingProxy(entry.proxy)
  if (proxy) hosting.proxy = proxy
  if (entry.bindAddress !== undefined) {
    if (!isString(entry.bindAddress) || entry.bindAddress.length === 0) {
      throw new Error('Invalid environment.deploy payload')
    }
    if (!isValidIpAddress(entry.bindAddress)) {
      throw new Error('Invalid environment.deploy payload')
    }
    hosting.bindAddress = entry.bindAddress
  }
  const protocol = parseDeployHostingProtocol(entry.protocol)
  if (protocol) hosting.protocol = protocol
  const ports = parseDeployHostingPorts(entry.ports)
  if (ports) hosting.ports = ports
  const web = parseDeployHostingWeb(entry.web)
  if (web) hosting.web = web
}

function parseDeployHostingEntry(entry: unknown): EnvironmentDeployHosting {
  if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
  if (
    !isString(entry.hostingId) ||
    !isString(entry.serviceId) ||
    !isString(entry.composeServiceName)
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  if (!Array.isArray(entry.hostnames) || !entry.hostnames.every(isString)) {
    throw new Error('Invalid environment.deploy payload')
  }
  const hosting: EnvironmentDeployHosting = {
    hostingId: entry.hostingId,
    serviceId: entry.serviceId,
    composeServiceName: entry.composeServiceName,
    hostnames: entry.hostnames as string[],
  }
  applyOptionalDeployHostingFields(hosting, entry)
  return hosting
}

function parseDeployHostings(value: unknown): EnvironmentDeployHosting[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid environment.deploy payload')
  }
  return value.map(parseDeployHostingEntry)
}

function parseDeployTlsMaterialEntry(entry: unknown): EnvironmentDeployTlsMaterial {
  if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
  if (
    !isString(entry.tlsId) ||
    !isString(entry.certificatePem) ||
    !isString(entry.privateKeyEnvelope)
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  return {
    tlsId: entry.tlsId,
    certificatePem: entry.certificatePem,
    privateKeyEnvelope: entry.privateKeyEnvelope,
  }
}

function parseDeployTlsMaterial(
  value: unknown,
): EnvironmentDeployTlsMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(parseDeployTlsMaterialEntry)
}

function parseDeployVariableMaterialEntry(entry: unknown): EnvironmentDeployVariableMaterial {
  if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
  if (!isString(entry.key) || !isString(entry.valueEnvelope)) {
    throw new Error('Invalid environment.deploy payload')
  }
  return {
    key: entry.key,
    composeServiceName: isString(entry.composeServiceName) ? entry.composeServiceName : null,
    forBuild: entry.forBuild === true,
    forRuntime: entry.forRuntime !== false,
    isLiteral: entry.isLiteral === true,
    valueEnvelope: entry.valueEnvelope,
  }
}

function parseDeployVariableMaterial(
  value: unknown,
): EnvironmentDeployVariableMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(parseDeployVariableMaterialEntry)
}

function parseDeployStorageMaterialEntry(entry: unknown): EnvironmentDeployStorageMaterial {
  if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
  if (
    !isString(entry.storageId) ||
    !isString(entry.kind) ||
    !isString(entry.name) ||
    !isString(entry.destinationPath) ||
    !isString(entry.serverId)
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  const material: EnvironmentDeployStorageMaterial = {
    storageId: entry.storageId,
    kind: entry.kind as EnvironmentDeployStorageMaterial['kind'],
    name: entry.name,
    destinationPath: entry.destinationPath,
    serverId: entry.serverId,
  }
  if (isString(entry.sourcePath)) material.sourcePath = entry.sourcePath
  if (isString(entry.principalId)) material.principalId = entry.principalId
  if (isString(entry.serviceId)) material.serviceId = entry.serviceId
  if (isString(entry.composeServiceName)) material.composeServiceName = entry.composeServiceName
  if (isString(entry.contentEnvelope)) material.contentEnvelope = entry.contentEnvelope
  return material
}

function parseDeployPrincipalMaterialEntry(entry: unknown): EnvironmentDeployPrincipalMaterial {
  if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
  if (
    !isString(entry.principalId) ||
    !isString(entry.username) ||
    typeof entry.uid !== 'number' ||
    typeof entry.gid !== 'number'
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  const material: EnvironmentDeployPrincipalMaterial = {
    principalId: entry.principalId,
    username: entry.username,
    uid: entry.uid,
    gid: entry.gid,
  }
  if (isString(entry.home)) material.home = entry.home
  return material
}

function parseDeployPrincipalMaterial(
  value: unknown,
): EnvironmentDeployPrincipalMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(parseDeployPrincipalMaterialEntry)
}

function parseDeployStorageMaterial(
  value: unknown,
): EnvironmentDeployStorageMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(parseDeployStorageMaterialEntry)
}

function parseDeployServiceHookEntry(entry: unknown): EnvironmentDeployServiceHook {
  if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
  if (!isString(entry.composeServiceName)) {
    throw new Error('Invalid environment.deploy payload')
  }
  const hook: EnvironmentDeployServiceHook = {
    composeServiceName: entry.composeServiceName,
  }
  if (isString(entry.preDeployCommand)) hook.preDeployCommand = entry.preDeployCommand
  if (isString(entry.postDeployCommand)) hook.postDeployCommand = entry.postDeployCommand
  if (entry.buildDisableCache === true) hook.buildDisableCache = true
  return hook
}

function parseDeployServiceHooks(value: unknown): EnvironmentDeployServiceHook[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(parseDeployServiceHookEntry)
}

const TRADITIONAL_WEB_ENGINES = new Set(['apache', 'nginx', 'openlitespeed'])

function parseDeployTraditionalWebSiteEntry(
  entry: unknown,
): EnvironmentDeployTraditionalWebSite {
  if (!isRecord(entry)) {
    throw new Error('Invalid traditionalWebSites entry')
  }
  if (
    !isString(entry.composeServiceName) ||
    entry.composeServiceName.length === 0 ||
    !isString(entry.engine) ||
    !TRADITIONAL_WEB_ENGINES.has(entry.engine) ||
    !isString(entry.root) ||
    entry.root.length === 0 ||
    typeof entry.listenPort !== 'number' ||
    !Number.isInteger(entry.listenPort) ||
    entry.listenPort < 1024 ||
    entry.listenPort > 65_535
  ) {
    throw new Error('Invalid traditionalWebSites entry')
  }
  const site: EnvironmentDeployTraditionalWebSite = {
    composeServiceName: entry.composeServiceName,
    engine: entry.engine as EnvironmentDeployTraditionalWebSite['engine'],
    root: entry.root,
    listenPort: entry.listenPort,
  }
  const webEnv = parseDeployHostingWebEnv(entry.webEnv)
  if (webEnv) site.webEnv = webEnv
  const php = parseDeployHostingPhp(entry.php)
  if (php) site.php = php
  const principal = parseDeployTraditionalWebPrincipal(entry.principal)
  if (principal) site.principal = principal
  return site
}

const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

function parseDeployTraditionalWebPrincipal(
  value: unknown,
): EnvironmentDeployTraditionalWebPrincipal | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new Error('Invalid traditionalWebSites.principal entry')
  }
  if (
    !isString(value.principalId) ||
    value.principalId.length === 0 ||
    !isString(value.username) ||
    !PRINCIPAL_USERNAME_RE.test(value.username) ||
    typeof value.uid !== 'number' ||
    !Number.isInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.gid !== 'number' ||
    !Number.isInteger(value.gid) ||
    value.gid < 0
  ) {
    throw new Error('Invalid traditionalWebSites.principal entry')
  }
  return {
    principalId: value.principalId,
    username: value.username,
    uid: value.uid,
    gid: value.gid,
  }
}

function parseDeployTraditionalWebSites(
  value: unknown,
): EnvironmentDeployTraditionalWebSite[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError('traditionalWebSites must be an array')
  }
  return value.map(parseDeployTraditionalWebSiteEntry)
}

const DOCKER_EXTERNAL_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function parseDeployDockerExternalNetworks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError('dockerExternalNetworks must be an array')
  }
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new TypeError('dockerExternalNetworks must be an array of strings')
    }
    const trimmed = entry.trim()
    if (!DOCKER_EXTERNAL_NETWORK_NAME_RE.test(trimmed)) {
      throw new Error('Invalid dockerExternalNetworks entry')
    }
    names.push(trimmed)
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

function parseDeployContainerEntry(entry: unknown): EnvironmentDeployContainer | undefined {
  if (!isRecord(entry)) return undefined
  if (
    !isString(entry.composeServiceName) ||
    !isString(entry.containerId) ||
    !isString(entry.containerName) ||
    !isString(entry.status)
  ) {
    return undefined
  }
  const container: EnvironmentDeployContainer = {
    composeServiceName: entry.composeServiceName,
    containerId: entry.containerId,
    containerName: entry.containerName,
    status: entry.status,
  }
  if (isString(entry.serviceId)) container.serviceId = entry.serviceId
  return container
}

function parseDeployContainers(value: unknown): EnvironmentDeployContainer[] | undefined {
  if (!Array.isArray(value)) return undefined
  const containers: EnvironmentDeployContainer[] = []
  for (const entry of value) {
    const container = parseDeployContainerEntry(entry)
    if (!container) continue
    containers.push(container)
    if (containers.length >= MAX_ENVIRONMENT_DEPLOY_CONTAINERS) break
  }
  // Preserve an explicitly empty array so callers can distinguish
  // "authoritative empty report" from "containers field omitted".
  return containers
}

export function parseEnvironmentDeployPayload(value: unknown): EnvironmentDeployCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid environment.deploy payload')
  }
  const strings = requireDeployPayloadStrings(value)
  const hostings = parseDeployHostings(value.hostings)
  const tlsMaterial = parseDeployTlsMaterial(value.tlsMaterial)
  const variableMaterial = parseDeployVariableMaterial(value.variableMaterial)
  const storageMaterial = parseDeployStorageMaterial(value.storageMaterial)
  const principalMaterial = parseDeployPrincipalMaterial(value.principalMaterial)
  const serviceHooks = parseDeployServiceHooks(value.serviceHooks)
  const traditionalWebSites = parseDeployTraditionalWebSites(value.traditionalWebSites)
  const dockerExternalNetworks = parseDeployDockerExternalNetworks(value.dockerExternalNetworks)
  return {
    ...strings,
    hostings,
    ...(traditionalWebSites !== undefined ? { traditionalWebSites } : {}),
    ...(dockerExternalNetworks !== undefined ? { dockerExternalNetworks } : {}),
    ...(tlsMaterial !== undefined ? { tlsMaterial } : {}),
    ...(variableMaterial !== undefined ? { variableMaterial } : {}),
    ...(storageMaterial !== undefined ? { storageMaterial } : {}),
    ...(principalMaterial !== undefined ? { principalMaterial } : {}),
    ...(serviceHooks !== undefined ? { serviceHooks } : {}),
  }
}

export function parseEnvironmentDeployResult(value: unknown): EnvironmentDeployCommandResult {
  if (!isRecord(value)) {
    return { projectName: '' }
  }
  const result: EnvironmentDeployCommandResult = {
    projectName: isString(value.projectName) ? value.projectName : '',
  }
  if (isString(value.summary)) result.summary = value.summary
  if (Array.isArray(value.services) && value.services.every(isString)) {
    result.services = value.services as string[]
  }
  const containers = parseDeployContainers(value.containers)
  if (containers !== undefined) result.containers = containers
  return result
}

export type EnvironmentStopCommandPayload = {
  environmentId: string
  projectId: string
  projectName: string
}

export type EnvironmentStopCommandResult = {
  projectName: string
  summary?: string
  /** Authoritative report — stop always returns `[]` on success so Postgres clears pins. */
  containers?: EnvironmentDeployContainer[]
}

export function parseEnvironmentStopPayload(value: unknown): EnvironmentStopCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid environment.stop payload')
  }
  const environmentId = value.environmentId
  const projectId = value.projectId
  const projectName = value.projectName
  if (
    !isString(environmentId) ||
    !isString(projectId) ||
    !isString(projectName) ||
    environmentId.length === 0 ||
    projectId.length === 0 ||
    projectName.length === 0
  ) {
    throw new Error('Invalid environment.stop payload')
  }
  return { environmentId, projectId, projectName }
}

export function parseEnvironmentStopResult(value: unknown): EnvironmentStopCommandResult {
  if (!isRecord(value)) {
    return { projectName: '' }
  }
  const result: EnvironmentStopCommandResult = {
    projectName: isString(value.projectName) ? value.projectName : '',
  }
  if (isString(value.summary)) result.summary = value.summary
  const containers = parseDeployContainers(value.containers)
  if (containers !== undefined) result.containers = containers
  return result
}

export function parseCommandPayload(
  type: CommandType,
  value: unknown,
):
  | PingCommandPayload
  | HostnameSetCommandPayload
  | TimezoneSetCommandPayload
  | NtpSetCommandPayload
  | RebootCommandPayload
  | WireguardApplyCommandPayload
  | EnvironmentDeployCommandPayload
  | EnvironmentStopCommandPayload {
  switch (type) {
    case 'daemon.ping':
      return parsePingPayload(value)
    case 'server.hostname.set':
      return parseHostnameSetPayload(value)
    case 'server.timezone.set':
      return parseTimezoneSetPayload(value)
    case 'server.ntp.set':
      return parseNtpSetPayload(value)
    case 'server.reboot':
      return parseRebootPayload(value)
    case 'server.wireguard.apply':
      return parseWireguardApplyPayload(value)
    case 'environment.deploy':
      return parseEnvironmentDeployPayload(value)
    case 'environment.stop':
      return parseEnvironmentStopPayload(value)
  }
}

export function parseCommandResult(
  type: CommandType,
  value: unknown,
):
  | PingCommandResult
  | HostnameSetCommandResult
  | TimezoneSetCommandResult
  | NtpSetCommandResult
  | RebootCommandResult
  | WireguardApplyCommandResult
  | EnvironmentDeployCommandResult
  | EnvironmentStopCommandResult {
  switch (type) {
    case 'daemon.ping':
      return parsePingResult(value)
    case 'server.hostname.set':
      return parseHostnameSetResult(value)
    case 'server.timezone.set':
      return parseTimezoneSetResult(value)
    case 'server.ntp.set':
      return parseNtpSetResult(value)
    case 'server.reboot':
      return parseRebootResult(value)
    case 'server.wireguard.apply':
      return parseWireguardApplyResult(value)
    case 'environment.deploy':
      return parseEnvironmentDeployResult(value)
    case 'environment.stop':
      return parseEnvironmentStopResult(value)
  }
}
