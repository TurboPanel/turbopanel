import { isValidHostname, HOSTNAME_MAX_LENGTH } from './hostname.ts'
import { isValidIpAddress } from '../ip-address.ts'
import {
  isManagedBackupArtifactExtension,
  isManagedEngineCode,
  type ManagedBackupArtifactExtension,
  type ManagedEngineCode,
} from '../managed/types.ts'
import {
  getManagedReservedEnvKeys,
  parseManagedDockerOptions,
  RESERVED_PUBLISHED_PORTS,
  type ManagedDockerOptions,
} from '../managed/settings.ts'
import { isValidDockerResourceName } from '../naming.ts'
import type { ServiceOptions } from '../service-options.ts'
import { isValidTimezone } from '../timezones.ts'
import {
  assertValidWireguardInterfaceName,
  isValidWireguardAllowedIp,
  isValidWireguardEndpoint,
  isValidWireguardListenPort,
  isValidWireguardPublicKey,
} from './wireguard.ts'
import { DAEMON_ENVELOPE_MAGIC } from '../../client/authn/data-encryption.ts'
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
  /** Daemon-recipient sealed private key (`denc.…`). */
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
  /**
   * Mount target inside the container. Required for bind/file/directory;
   * optional for `docker_volume` when the volume is only declared in compose
   * (compose-declared named volumes have no destinationPath).
   */
  destinationPath?: string
  /**
   * On-host Docker volume name. Instance-owned — UUID for new rows, legacy
   * `tp-<org8>-<name>` for unstamped rows. Daemon must not derive names when set.
   */
  volumeName?: string
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
  /**
   * Absolute shell path (default `/usr/sbin/nologin`), applied by the daemon
   * via `useradd -s` / `usermod -s`.
   */
  shell?: string
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
  /** Public hosting routes to wire through Traefik + hosting Caddy. */
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
   * `http` (default/omitted) routes `hostnames` through Traefik + hosting Caddy.
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
    !isString(entry.serverId)
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  const kind = entry.kind as EnvironmentDeployStorageMaterial['kind']
  if (kind !== 'docker_volume' && !isString(entry.destinationPath)) {
    throw new Error('Invalid environment.deploy payload')
  }
  const material: EnvironmentDeployStorageMaterial = {
    storageId: entry.storageId,
    kind,
    name: entry.name,
    serverId: entry.serverId,
  }
  if (isString(entry.destinationPath)) material.destinationPath = entry.destinationPath
  if (isString(entry.volumeName)) material.volumeName = entry.volumeName
  if (isString(entry.sourcePath)) material.sourcePath = entry.sourcePath
  if (isString(entry.principalId)) material.principalId = entry.principalId
  if (isString(entry.serviceId)) material.serviceId = entry.serviceId
  if (isString(entry.composeServiceName)) material.composeServiceName = entry.composeServiceName
  if (isString(entry.contentEnvelope)) material.contentEnvelope = entry.contentEnvelope
  return material
}

/** Absolute path: leading `/`, no whitespace/newline/NUL (mirrors principal-options). */
const PRINCIPAL_SHELL_RE = /^\/[A-Za-z0-9._+/-]{0,254}$/

function isValidPrincipalShellPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false
  if (/\s/.test(value) || value.includes('\0') || value.includes('\n')) return false
  return PRINCIPAL_SHELL_RE.test(value)
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
  if (entry.shell !== undefined) {
    if (!isString(entry.shell) || !isValidPrincipalShellPath(entry.shell)) {
      throw new Error('Invalid environment.deploy payload')
    }
    material.shell = entry.shell
  }
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

/** Docker Compose project name charset (daemon `COMPOSE_PROJECT_RE` parity). */
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/
const SAFE_IDENTIFIER_RE = /^[A-Za-z_]\w*$/
const SAFE_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const MAX_IDENTIFIER_LENGTH = 63
const MAX_MANAGED_CONFIG_FILES = 32
const MAX_MANAGED_CONFIG_CONTENTS_BYTES = 64 * 1024
const MAX_MANAGED_VOLUMES = 16
const MAX_MANAGED_CREDENTIALS = 32
const MAX_MANAGED_DATABASES = 64
const MAX_MANAGED_DROP_USERS = 32
const MAX_MANAGED_IMAGE_LENGTH = 256
const DAEMON_ENVELOPE_PREFIX = `${DAEMON_ENVELOPE_MAGIC}.`
const MANAGED_CONFIG_MODES = new Set(['0640', '0600'])
const MANAGED_LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart'])
const MANAGED_EXPOSURE_PROTOCOLS = new Set(['tcp', 'udp', 'http'])
const MANAGED_CREDENTIAL_ROLES = new Set(['root', 'user'])
const MANAGED_DATABASE_ACTIONS = new Set(['create', 'drop'])

function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_IDENTIFIER_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  )
}

function isSafeUsername(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_USERNAME_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  )
}

function isComposeProjectName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    COMPOSE_PROJECT_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  )
}

/** Light OCI-ref charset check (mirrors managed/settings.ts syntax rules). */
function isValidManagedImageRef(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MANAGED_IMAGE_LENGTH) return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  return true
}

function isValidPortNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  )
}

function isValidPublishedManagedPort(value: unknown): value is number {
  return isValidPortNumber(value) && !RESERVED_PUBLISHED_PORTS.has(value)
}

/**
 * Relative paths the platform may materialize under managed state.
 * Keep in sync with generated engine specs (e.g. postgres `postgresql.conf`
 * + TLS material) and the daemon twin allowlist.
 */
const MANAGED_CONFIG_PATH_ALLOWLIST = new Set([
  'postgresql.conf',
  'tls/server.crt',
  'tls/server.key',
])

/** Relative-only allowlist for managed `configFiles[].path`. */
function isAllowedManagedConfigPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  if (value.includes('..')) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  return MANAGED_CONFIG_PATH_ALLOWLIST.has(value)
}

function isAbsoluteContainerPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value.startsWith('/') &&
    !value.includes('..') &&
    !SHELL_METACHAR_RE.test(value)
  )
}

export type ManagedApplyConfigFile = {
  path: string
  contents: string
  mode: '0640' | '0600'
}

export type ManagedApplyVolume = {
  name: string
  target: string
}

export type ManagedApplyExposure = {
  enabled: boolean
  protocol: 'tcp' | 'udp' | 'http'
  publishedPort?: number
  bindAddress?: string
  sni?: { hostnames: string[] }
}

export type ManagedApplyCredential = {
  principalId: string
  username: string
  role: 'root' | 'user'
  databases: string[]
  privileges?: string[]
  /** Daemon-recipient sealed password (`denc.…`). */
  password: string
}

export type ManagedApplyDatabaseOp = {
  name: string
  action: 'create' | 'drop'
}

/** Mirror of `ManagedTlsMaterialRequest` — daemon generates key material on host. */
export type ManagedApplyTlsMaterial = {
  selfSigned: true
  commonName: string
  certPath: string
  keyPath: string
}

/**
 * Per-service managed Traefik identity allocated by the instance when
 * `exposure.enabled` — own `service` + ordinal-1 `container` rows.
 */
export type ManagedApplyIngress = {
  serviceId: string
  composeServiceName: string
  containerName: string
}

export type ManagedApplyCommandPayload = {
  managedId: string
  environmentId: string
  engine: ManagedEngineCode
  projectName: string
  /** Compose `container_name` — `<service.id>-1` from managed pre-allocation. */
  containerName: string
  image: string
  containerPort: number
  composeYaml: string
  configFiles: ManagedApplyConfigFile[]
  volumes: ManagedApplyVolume[]
  resources?: NonNullable<ServiceOptions['resources']>
  dockerOptions?: ManagedDockerOptions
  exposure: ManagedApplyExposure
  /**
   * Required when `exposure.enabled`; omitted when exposure is disabled.
   * Identity for the dedicated per-service Traefik ingress container.
   */
  ingress?: ManagedApplyIngress
  credentials: ManagedApplyCredential[]
  databases?: ManagedApplyDatabaseOp[]
  /** Transient usernames to drop after credentials are applied (never root). */
  dropUsers?: string[]
  /** When set, daemon generates a self-signed cert under managed state `tls/`. */
  tlsMaterial?: ManagedApplyTlsMaterial
}

export type ManagedApplyCommandResult = {
  host: string
  port: number
  containers?: EnvironmentDeployContainer[]
  appliedUsers?: string[]
  appliedDatabases?: string[]
  engineVersion?: string
  summary?: string
}

export type ManagedLifecycleCommandPayload = {
  managedId: string
  action: 'start' | 'stop' | 'restart'
}

export type ManagedLifecycleCommandResult = {
  status: string
  summary?: string
}

export type ManagedDestroyCommandPayload = {
  managedId: string
  removeVolumes: boolean
  /**
   * Instance-only marker (never read by the daemon) distinguishing an API
   * hard-delete request from a future "destroy runtime only" action. When
   * true, `applyManagedDestroySideEffect` deletes the `managed` row after a
   * successful destroy so `principal.managed_id` cascades.
   */
  deleteAfterDestroy?: boolean
}

export type ManagedDestroyCommandResult = {
  /** Daemon-observed managed status after destroy (e.g. `stopped`). */
  status: string
  /** Always present — destroy returns `[]` so Postgres clears pins. */
  containers: EnvironmentDeployContainer[]
  summary?: string
}

function parseManagedApplyConfigFiles(value: unknown): ManagedApplyConfigFile[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply configFiles')
  }
  if (value.length > MAX_MANAGED_CONFIG_FILES) {
    throw new Error('Invalid managed.apply configFiles: too many entries')
  }
  const files: ManagedApplyConfigFile[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('Invalid managed.apply configFiles entry')
    }
    if (
      !isString(entry.path) ||
      !isAllowedManagedConfigPath(entry.path) ||
      !isString(entry.contents) ||
      entry.contents.length > MAX_MANAGED_CONFIG_CONTENTS_BYTES ||
      !isString(entry.mode) ||
      !MANAGED_CONFIG_MODES.has(entry.mode)
    ) {
      throw new Error('Invalid managed.apply configFiles entry')
    }
    files.push({
      path: entry.path,
      contents: entry.contents,
      mode: entry.mode as '0640' | '0600',
    })
  }
  return files
}

function parseManagedApplyVolumes(value: unknown): ManagedApplyVolume[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply volumes')
  }
  if (value.length > MAX_MANAGED_VOLUMES) {
    throw new Error('Invalid managed.apply volumes: too many entries')
  }
  const volumes: ManagedApplyVolume[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('Invalid managed.apply volumes entry')
    }
    if (
      !isString(entry.name) ||
      !isSafeIdentifier(entry.name) ||
      !isString(entry.target) ||
      !isAbsoluteContainerPath(entry.target)
    ) {
      throw new Error('Invalid managed.apply volumes entry')
    }
    volumes.push({ name: entry.name, target: entry.target })
  }
  return volumes
}

function parseManagedApplyResources(
  value: unknown,
): NonNullable<ServiceOptions['resources']> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new Error('Invalid managed.apply resources')
  }
  const resources: NonNullable<ServiceOptions['resources']> = {}
  if (value.cpus !== undefined) {
    if (typeof value.cpus !== 'number' || !Number.isFinite(value.cpus) || value.cpus < 0) {
      throw new Error('Invalid managed.apply resources.cpus')
    }
    resources.cpus = value.cpus
  }
  if (value.memoryBytes !== undefined) {
    if (
      typeof value.memoryBytes !== 'number' ||
      !Number.isInteger(value.memoryBytes) ||
      value.memoryBytes <= 0
    ) {
      throw new Error('Invalid managed.apply resources.memoryBytes')
    }
    resources.memoryBytes = value.memoryBytes
  }
  if (value.memoryReservationBytes !== undefined) {
    if (
      typeof value.memoryReservationBytes !== 'number' ||
      !Number.isInteger(value.memoryReservationBytes) ||
      value.memoryReservationBytes <= 0
    ) {
      throw new Error('Invalid managed.apply resources.memoryReservationBytes')
    }
    resources.memoryReservationBytes = value.memoryReservationBytes
  }
  return Object.keys(resources).length > 0 ? resources : undefined
}

function parseManagedApplyExposureBindAddress(value: unknown): string {
  if (
    !isString(value) ||
    value.length === 0 ||
    (!isValidIpv4Literal(value) && !isValidIpv6Literal(value))
  ) {
    throw new Error('Invalid managed.apply exposure.bindAddress')
  }
  return value
}

function parseManagedApplyExposureSni(
  value: unknown,
): NonNullable<ManagedApplyExposure['sni']> {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.apply exposure.sni')
  }
  if (!Array.isArray(value.hostnames)) {
    throw new TypeError('Invalid managed.apply exposure.sni')
  }
  const hostnames: string[] = []
  for (const hostname of value.hostnames) {
    if (!isString(hostname) || !isValidHostname(hostname)) {
      throw new Error('Invalid managed.apply exposure.sni.hostnames')
    }
    hostnames.push(hostname)
  }
  return { hostnames }
}

function parseManagedApplyExposure(value: unknown): ManagedApplyExposure {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid managed.apply exposure')
  }
  if (
    !isString(value.protocol) ||
    !MANAGED_EXPOSURE_PROTOCOLS.has(value.protocol)
  ) {
    throw new Error('Invalid managed.apply exposure.protocol')
  }
  const exposure: ManagedApplyExposure = {
    enabled: value.enabled,
    protocol: value.protocol as ManagedApplyExposure['protocol'],
  }
  if (value.publishedPort !== undefined) {
    if (!isValidPublishedManagedPort(value.publishedPort)) {
      throw new Error('Invalid managed.apply exposure.publishedPort')
    }
    exposure.publishedPort = value.publishedPort
  }
  if (value.bindAddress !== undefined) {
    exposure.bindAddress = parseManagedApplyExposureBindAddress(value.bindAddress)
  }
  if (value.sni !== undefined) {
    exposure.sni = parseManagedApplyExposureSni(value.sni)
  }
  // Mirror managed/settings.ts: enabled exposure requires a published port.
  if (exposure.enabled && exposure.publishedPort === undefined) {
    throw new Error('Invalid managed.apply exposure')
  }
  return exposure
}

/** Matches `service_display_name_format_check` / compose-service-name charset. */
function isValidComposeServiceName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9 ._-]+$/.test(value)
  )
}

function parseManagedApplyIngress(value: unknown): ManagedApplyIngress {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.apply ingress')
  }
  if (
    !isString(value.serviceId) ||
    !UUID_RE.test(value.serviceId) ||
    !isString(value.composeServiceName) ||
    !isValidComposeServiceName(value.composeServiceName) ||
    !isString(value.containerName) ||
    !isValidDockerResourceName(value.containerName)
  ) {
    throw new Error('Invalid managed.apply ingress')
  }
  return {
    serviceId: value.serviceId,
    composeServiceName: value.composeServiceName,
    containerName: value.containerName,
  }
}

function parseManagedApplyCredentialDatabases(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply credentials entry')
  }
  const databases: string[] = []
  for (const name of value) {
    if (!isString(name) || !isSafeIdentifier(name)) {
      throw new Error('Invalid managed.apply credentials.databases')
    }
    databases.push(name)
  }
  return databases
}

function parseManagedApplyCredentialPrivileges(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply credentials.privileges')
  }
  if (!value.every(isString)) {
    throw new Error('Invalid managed.apply credentials.privileges')
  }
  return value as string[]
}

function parseManagedApplyCredentialEntry(entry: unknown): ManagedApplyCredential {
  if (!isRecord(entry)) {
    throw new Error('Invalid managed.apply credentials entry')
  }
  if (
    !isString(entry.principalId) ||
    entry.principalId.length === 0 ||
    !isString(entry.username) ||
    !isSafeUsername(entry.username) ||
    !isString(entry.role) ||
    !MANAGED_CREDENTIAL_ROLES.has(entry.role) ||
    !isString(entry.password) ||
    !entry.password.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new Error('Invalid managed.apply credentials entry')
  }
  const credential: ManagedApplyCredential = {
    principalId: entry.principalId,
    username: entry.username,
    role: entry.role as ManagedApplyCredential['role'],
    databases: parseManagedApplyCredentialDatabases(entry.databases),
    password: entry.password,
  }
  const privileges = parseManagedApplyCredentialPrivileges(entry.privileges)
  if (privileges !== undefined) credential.privileges = privileges
  return credential
}

function parseManagedApplyCredentials(value: unknown): ManagedApplyCredential[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply credentials')
  }
  if (value.length === 0) {
    throw new Error('Invalid managed.apply credentials')
  }
  if (value.length > MAX_MANAGED_CREDENTIALS) {
    throw new Error('Invalid managed.apply credentials: too many entries')
  }
  return value.map(parseManagedApplyCredentialEntry)
}

function parseManagedApplyDatabases(
  value: unknown,
): ManagedApplyDatabaseOp[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply databases')
  }
  if (value.length > MAX_MANAGED_DATABASES) {
    throw new Error('Invalid managed.apply databases: too many entries')
  }
  const databases: ManagedApplyDatabaseOp[] = []
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isString(entry.name) ||
      !isSafeIdentifier(entry.name) ||
      !isString(entry.action) ||
      !MANAGED_DATABASE_ACTIONS.has(entry.action)
    ) {
      throw new Error('Invalid managed.apply databases entry')
    }
    databases.push({
      name: entry.name,
      action: entry.action as ManagedApplyDatabaseOp['action'],
    })
  }
  return databases
}

function parseManagedApplyDropUsers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid managed.apply dropUsers')
  }
  if (value.length > MAX_MANAGED_DROP_USERS) {
    throw new Error('Invalid managed.apply dropUsers: too many entries')
  }
  const dropUsers: string[] = []
  for (const entry of value) {
    if (!isString(entry) || !isSafeUsername(entry)) {
      throw new Error('Invalid managed.apply dropUsers entry')
    }
    dropUsers.push(entry)
  }
  return dropUsers
}

function parseManagedApplyTlsMaterial(
  value: unknown,
): ManagedApplyTlsMaterial | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new Error('Invalid managed.apply tlsMaterial')
  }
  if (
    value.selfSigned !== true ||
    !isString(value.commonName) ||
    !isValidHostname(value.commonName) ||
    !isString(value.certPath) ||
    !isAllowedManagedConfigPath(value.certPath) ||
    !isString(value.keyPath) ||
    !isAllowedManagedConfigPath(value.keyPath)
  ) {
    throw new Error('Invalid managed.apply tlsMaterial')
  }
  return {
    selfSigned: true,
    commonName: value.commonName,
    certPath: value.certPath,
    keyPath: value.keyPath,
  }
}

export function parseManagedApplyPayload(value: unknown): ManagedApplyCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.apply payload')
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.environmentId) ||
    value.environmentId.length === 0 ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.projectName) ||
    !isComposeProjectName(value.projectName) ||
    !isString(value.containerName) ||
    !isValidDockerResourceName(value.containerName) ||
    !isString(value.image) ||
    !isValidManagedImageRef(value.image) ||
    !isValidPortNumber(value.containerPort) ||
    !isString(value.composeYaml) ||
    value.composeYaml.length === 0
  ) {
    throw new Error('Invalid managed.apply payload')
  }

  const dockerOptions = parseManagedDockerOptions(
    value.dockerOptions,
    getManagedReservedEnvKeys(value.engine),
  )
  if (dockerOptions === null) {
    throw new Error('Invalid managed.apply dockerOptions')
  }

  const resources = parseManagedApplyResources(value.resources)
  const databases = parseManagedApplyDatabases(value.databases)
  const dropUsers = parseManagedApplyDropUsers(value.dropUsers)
  const tlsMaterial = parseManagedApplyTlsMaterial(value.tlsMaterial)
  const exposure = parseManagedApplyExposure(value.exposure)

  let ingress: ManagedApplyIngress | undefined
  if (value.ingress !== undefined) {
    ingress = parseManagedApplyIngress(value.ingress)
  }
  if (exposure.enabled && ingress === undefined) {
    throw new Error('Invalid managed.apply ingress: required when exposure.enabled')
  }
  if (!exposure.enabled && ingress !== undefined) {
    throw new Error('Invalid managed.apply ingress: must be omitted when exposure is disabled')
  }

  return {
    managedId: value.managedId,
    environmentId: value.environmentId,
    engine: value.engine,
    projectName: value.projectName,
    containerName: value.containerName,
    image: value.image,
    containerPort: value.containerPort,
    composeYaml: value.composeYaml,
    configFiles: parseManagedApplyConfigFiles(value.configFiles),
    volumes: parseManagedApplyVolumes(value.volumes),
    ...(resources === undefined ? {} : { resources }),
    ...(dockerOptions === undefined ? {} : { dockerOptions }),
    exposure,
    ...(ingress === undefined ? {} : { ingress }),
    credentials: parseManagedApplyCredentials(value.credentials),
    ...(databases === undefined ? {} : { databases }),
    ...(dropUsers === undefined ? {} : { dropUsers }),
    ...(tlsMaterial === undefined ? {} : { tlsMaterial }),
  }
}

export function parseManagedApplyResult(value: unknown): ManagedApplyCommandResult {
  if (!isRecord(value)) {
    return { host: '', port: 0 }
  }
  const result: ManagedApplyCommandResult = {
    host: isString(value.host) ? value.host : '',
    port: isValidPortNumber(value.port) ? value.port : 0,
  }
  const containers = parseDeployContainers(value.containers)
  if (containers !== undefined) result.containers = containers
  if (Array.isArray(value.appliedUsers) && value.appliedUsers.every(isString)) {
    result.appliedUsers = value.appliedUsers as string[]
  }
  if (
    Array.isArray(value.appliedDatabases) &&
    value.appliedDatabases.every(isString)
  ) {
    result.appliedDatabases = value.appliedDatabases as string[]
  }
  if (isString(value.engineVersion)) result.engineVersion = value.engineVersion
  if (isString(value.summary)) result.summary = value.summary
  return result
}

export function parseManagedLifecyclePayload(
  value: unknown,
): ManagedLifecycleCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.lifecycle payload')
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.action) ||
    !MANAGED_LIFECYCLE_ACTIONS.has(value.action)
  ) {
    throw new Error('Invalid managed.lifecycle payload')
  }
  return {
    managedId: value.managedId,
    action: value.action as ManagedLifecycleCommandPayload['action'],
  }
}

export function parseManagedLifecycleResult(
  value: unknown,
): ManagedLifecycleCommandResult {
  if (!isRecord(value)) {
    return { status: '' }
  }
  const result: ManagedLifecycleCommandResult = {
    status: isString(value.status) ? value.status : '',
  }
  if (isString(value.summary)) result.summary = value.summary
  return result
}

export function parseManagedDestroyPayload(
  value: unknown,
): ManagedDestroyCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.destroy payload')
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    typeof value.removeVolumes !== 'boolean'
  ) {
    throw new Error('Invalid managed.destroy payload')
  }
  if (
    value.deleteAfterDestroy !== undefined &&
    typeof value.deleteAfterDestroy !== 'boolean'
  ) {
    throw new Error('Invalid managed.destroy payload')
  }
  const payload: ManagedDestroyCommandPayload = {
    managedId: value.managedId,
    removeVolumes: value.removeVolumes,
  }
  if (typeof value.deleteAfterDestroy === 'boolean') {
    payload.deleteAfterDestroy = value.deleteAfterDestroy
  }
  return payload
}

export function parseManagedDestroyResult(
  value: unknown,
): ManagedDestroyCommandResult {
  if (!isRecord(value)) {
    return { status: '', containers: [] }
  }
  const containers = parseDeployContainers(value.containers) ?? []
  const result: ManagedDestroyCommandResult = {
    status: isString(value.status) ? value.status : '',
    containers,
  }
  if (isString(value.summary)) result.summary = value.summary
  return result
}

/** Mirrors the daemon `SAFE_MANAGED_ID_RE` (`daemon/src/managed/paths.ts`) — backupId becomes a filename. */
const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_BACKUP_ID_LENGTH = 64
const CHECKSUM_SHA256_RE = /^[a-f0-9]{64}$/
const MANAGED_BACKUP_ACTIONS = new Set(['create', 'delete'])
const MANAGED_BACKUP_SCOPES = new Set(['database', 'instance'])
/** Bound on `managed.backup` payload `retentionKeep` — mirrors managed/settings.ts. */
const MAX_BACKUP_RETENTION_KEEP_BOUND = 100
const MAX_PRUNED_BACKUP_IDS = 200

function isSafeBackupId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_BACKUP_ID_LENGTH &&
    SAFE_BACKUP_ID_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  )
}

export type ManagedBackupCommandPayload = {
  managedId: string
  engine: ManagedEngineCode
  action: 'create' | 'delete'
  backupId: string
  artifactExtension: ManagedBackupArtifactExtension
  scope: 'database' | 'instance'
  database?: string
  retentionKeep?: number
}

export type ManagedBackupCommandResult = {
  backupId: string
  deleted?: boolean
  path?: string
  sizeBytes?: number
  checksum?: string
  completedAt?: string
  database?: string
  pruned?: string[]
  summary?: string
}

export type ManagedRestoreCommandPayload = {
  managedId: string
  engine: ManagedEngineCode
  backupId: string
  artifactExtension: ManagedBackupArtifactExtension
  database?: string
  checksum: string
  sizeBytes?: number
}

export type ManagedRestoreCommandResult = {
  backupId: string
  status?: string
  restoredAt?: string
  database?: string
  summary?: string
}

export function parseManagedBackupPayload(
  value: unknown,
): ManagedBackupCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.backup payload')
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.action) ||
    !MANAGED_BACKUP_ACTIONS.has(value.action) ||
    !isString(value.backupId) ||
    !isSafeBackupId(value.backupId) ||
    !isString(value.artifactExtension) ||
    !isManagedBackupArtifactExtension(value.artifactExtension) ||
    !isString(value.scope) ||
    !MANAGED_BACKUP_SCOPES.has(value.scope)
  ) {
    throw new Error('Invalid managed.backup payload')
  }
  const payload: ManagedBackupCommandPayload = {
    managedId: value.managedId,
    engine: value.engine,
    action: value.action as ManagedBackupCommandPayload['action'],
    backupId: value.backupId,
    artifactExtension: value.artifactExtension,
    scope: value.scope as ManagedBackupCommandPayload['scope'],
  }
  if (value.database !== undefined) {
    if (!isString(value.database) || !isSafeIdentifier(value.database)) {
      throw new Error('Invalid managed.backup payload database')
    }
    payload.database = value.database
  }
  if (payload.scope === 'database' && payload.database === undefined) {
    throw new Error('Invalid managed.backup payload: scope database requires database')
  }
  if (value.retentionKeep !== undefined) {
    if (
      typeof value.retentionKeep !== 'number' ||
      !Number.isInteger(value.retentionKeep) ||
      value.retentionKeep < 1 ||
      value.retentionKeep > MAX_BACKUP_RETENTION_KEEP_BOUND
    ) {
      throw new Error('Invalid managed.backup payload retentionKeep')
    }
    payload.retentionKeep = value.retentionKeep
  }
  return payload
}

/** Lenient result parser (like other managed results): missing → omitted. Never carries dump contents. */
export function parseManagedBackupResult(
  value: unknown,
): ManagedBackupCommandResult {
  if (!isRecord(value) || !isString(value.backupId) || value.backupId.length === 0) {
    return { backupId: '' }
  }
  const result: ManagedBackupCommandResult = { backupId: value.backupId }
  if (typeof value.deleted === 'boolean') result.deleted = value.deleted
  if (isString(value.path)) result.path = value.path
  if (
    typeof value.sizeBytes === 'number' &&
    Number.isFinite(value.sizeBytes) &&
    value.sizeBytes >= 0
  ) {
    result.sizeBytes = value.sizeBytes
  }
  if (isString(value.checksum) && CHECKSUM_SHA256_RE.test(value.checksum)) {
    result.checksum = value.checksum
  }
  if (isString(value.completedAt)) result.completedAt = value.completedAt
  if (isString(value.database)) result.database = value.database
  if (Array.isArray(value.pruned) && value.pruned.every(isString)) {
    result.pruned = (value.pruned as string[]).slice(0, MAX_PRUNED_BACKUP_IDS)
  }
  if (isString(value.summary)) result.summary = value.summary
  return result
}

export function parseManagedRestorePayload(
  value: unknown,
): ManagedRestoreCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid managed.restore payload')
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.backupId) ||
    !isSafeBackupId(value.backupId) ||
    !isString(value.artifactExtension) ||
    !isManagedBackupArtifactExtension(value.artifactExtension) ||
    !isString(value.checksum) ||
    !CHECKSUM_SHA256_RE.test(value.checksum)
  ) {
    throw new Error('Invalid managed.restore payload')
  }
  const payload: ManagedRestoreCommandPayload = {
    managedId: value.managedId,
    engine: value.engine,
    backupId: value.backupId,
    artifactExtension: value.artifactExtension,
    checksum: value.checksum,
  }
  if (value.database !== undefined) {
    if (!isString(value.database) || !isSafeIdentifier(value.database)) {
      throw new Error('Invalid managed.restore payload database')
    }
    payload.database = value.database
  }
  if (value.sizeBytes !== undefined) {
    if (
      typeof value.sizeBytes !== 'number' ||
      !Number.isInteger(value.sizeBytes) ||
      value.sizeBytes < 0
    ) {
      throw new Error('Invalid managed.restore payload sizeBytes')
    }
    payload.sizeBytes = value.sizeBytes
  }
  return payload
}

/** Lenient result parser. Never carries dump contents. */
export function parseManagedRestoreResult(
  value: unknown,
): ManagedRestoreCommandResult {
  if (!isRecord(value) || !isString(value.backupId) || value.backupId.length === 0) {
    return { backupId: '' }
  }
  const result: ManagedRestoreCommandResult = { backupId: value.backupId }
  if (isString(value.status)) result.status = value.status
  if (isString(value.restoredAt)) result.restoredAt = value.restoredAt
  if (isString(value.database)) result.database = value.database
  if (isString(value.summary)) result.summary = value.summary
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
  | EnvironmentStopCommandPayload
  | ManagedApplyCommandPayload
  | ManagedLifecycleCommandPayload
  | ManagedDestroyCommandPayload
  | ManagedBackupCommandPayload
  | ManagedRestoreCommandPayload {
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
    case 'managed.apply':
      return parseManagedApplyPayload(value)
    case 'managed.lifecycle':
      return parseManagedLifecyclePayload(value)
    case 'managed.destroy':
      return parseManagedDestroyPayload(value)
    case 'managed.backup':
      return parseManagedBackupPayload(value)
    case 'managed.restore':
      return parseManagedRestorePayload(value)
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
  | EnvironmentStopCommandResult
  | ManagedApplyCommandResult
  | ManagedLifecycleCommandResult
  | ManagedDestroyCommandResult
  | ManagedBackupCommandResult
  | ManagedRestoreCommandResult {
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
    case 'managed.apply':
      return parseManagedApplyResult(value)
    case 'managed.lifecycle':
      return parseManagedLifecycleResult(value)
    case 'managed.destroy':
      return parseManagedDestroyResult(value)
    case 'managed.backup':
      return parseManagedBackupResult(value)
    case 'managed.restore':
      return parseManagedRestoreResult(value)
  }
}
