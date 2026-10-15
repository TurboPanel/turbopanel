/**
 * "Addresses clients use": the pure half (validation, precedence, endpoints,
 * certificate names). The database half is `./client-addresses.ts`.
 *
 * A server has one public side and one side per datacenter it belongs to. The
 * operator may describe each side with an `address` row: a DNS name, an
 * address override (a router or 1:1 NAT in front of the server) and external
 * ports. Anything left blank falls back to what the panel already knows:
 *
 * - public: the oldest public `ip` row of each family, else the public
 *   interface address the daemon reports, classified by the control plane's
 *   own ranges (CGNAT, link-local and mesh addresses never count). The address
 *   the server connects out from is never used: behind a port forward or a
 *   multi-address host it is not where clients arrive.
 * - datacenter: the server's pin in that datacenter.
 *
 * The server's Linux hostname is a last resort for the public side only when
 * it contains a dot. A one-word name (`omega`) never reaches a connection
 * string: nothing outside the server's own network can resolve it. It always
 * stays on the database certificate, so clients that already use it keep
 * verifying.
 */

import { isValidHostname } from '../../contracts/commands/hostname.ts'
import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import { ipAddressScope, normalizeIpAddress, parseIpVersion } from '../../lib/ip-address.ts'

export const CLIENT_ADDRESS_SCOPES = ['public', 'datacenter'] as const
export type ClientAddressScope = (typeof CLIENT_ADDRESS_SCOPES)[number]

export const CLIENT_ADDRESS_PORT_KEYS = ['postgres', 'mysql', 'http', 'https'] as const
export type ClientAddressPortKey = (typeof CLIENT_ADDRESS_PORT_KEYS)[number]

/** Absent key: same as the listen port. `null`: not reachable through this address. */
export type ClientAddressPorts = Partial<Record<ClientAddressPortKey, number | null>>

/** What the operator saved for one side of a server. */
export type ClientAddressEntry = {
  scope: ClientAddressScope
  datacenterId: string | null
  hostname: string | null
  addressV4: string | null
  addressV6: string | null
  ports: ClientAddressPorts
  primary: boolean
}

/** Where an effective address came from. */
export type ClientAddressSource = 'entry' | 'ip' | 'reported' | 'pin'

/** What the host string clients type is made of. */
export type ClientAddressHostSource = 'hostname' | 'address' | 'linux-hostname'

/** One side of the server with the operator's values and what the panel will use. */
export type EffectiveClientAddress = ClientAddressEntry & {
  /** `Public`, or the datacenter's name. */
  label: string
  datacenterName: string | null
  /** An operator entry exists for this side. */
  saved: boolean
  effectiveV4: string | null
  effectiveV4Source: ClientAddressSource | null
  effectiveV6: string | null
  effectiveV6Source: ClientAddressSource | null
  /** The host clients type: the DNS name, else an address. `null` = nothing usable. */
  host: string | null
  hostSource: ClientAddressHostSource | null
}

export type ServerClientAddresses = {
  linuxHostname: string | null
  /** Public first, then each datacenter the server belongs to. */
  entries: EffectiveClientAddress[]
}

export type ClientAddressDatacenterPin = {
  datacenterId: string
  datacenterName: string
  addressPreference: 'ipv4' | 'ipv6'
  priority: number
  /** Oldest pin of each family in that datacenter. */
  v4: string | null
  v6: string | null
}

/** Everything the resolver reads, loaded by `./client-addresses.ts`. */
export type ClientAddressFacts = {
  linuxHostname: string | null
  saved: readonly ClientAddressEntry[]
  /** Oldest public `ip` row of each family. */
  publicIp: { v4: string | null; v6: string | null }
  reportedIps: readonly ServerReportedIp[]
  pins: readonly ClientAddressDatacenterPin[]
}

export const PUBLIC_CLIENT_ADDRESS_LABEL = 'Public'

/** Mesh and tunnel interfaces: their addresses are never where clients arrive. */
const MESH_INTERFACE_RE = /^(tp\d|wg)/

/** A DNS name with at least one dot, and not an IPv4 address in disguise. */
export function isQualifiedHostname(value: string): boolean {
  if (!isValidHostname(value) || !value.includes('.')) return false
  const last = value.slice(value.lastIndexOf('.') + 1)
  return !/^\d+$/.test(last)
}

/**
 * Public interface addresses the daemon reported, by the control plane's
 * classification: CGNAT, link-local, private and mesh addresses are dropped,
 * and the default-route interface wins.
 */
export function detectedPublicAddresses(reported: readonly ServerReportedIp[]): {
  v4: string | null
  v6: string | null
} {
  const usable = reported.filter(
    (row) =>
      row.link !== 'down' &&
      !MESH_INTERFACE_RE.test(row.interface ?? '') &&
      ipAddressScope(row.address) === 'public'
  )
  const ordered = [...usable.filter((row) => row.preferred), ...usable.filter((r) => !r.preferred)]
  const pick = (version: 4 | 6) => {
    const row = ordered.find((r) => parseIpVersion(r.address) === version)
    return row ? normalizeIpAddress(row.address) : null
  }
  return { v4: pick(4), v6: pick(6) }
}

function pickFamily(
  override: string | null,
  fallback: string | null,
  fallbackSource: ClientAddressSource
): { address: string | null; source: ClientAddressSource | null } {
  if (override) return { address: override, source: 'entry' }
  if (fallback) return { address: fallback, source: fallbackSource }
  return { address: null, source: null }
}

function blankEntry(scope: ClientAddressScope, datacenterId: string | null): ClientAddressEntry {
  return {
    scope,
    datacenterId,
    hostname: null,
    addressV4: null,
    addressV6: null,
    ports: {},
    primary: false,
  }
}

function resolvePublic(facts: ClientAddressFacts): EffectiveClientAddress {
  const saved = facts.saved.find((entry) => entry.scope === 'public')
  const entry = saved ?? blankEntry('public', null)
  const detected = detectedPublicAddresses(facts.reportedIps)
  const v4 = pickFamily(
    entry.addressV4,
    facts.publicIp.v4 ?? detected.v4,
    facts.publicIp.v4 ? 'ip' : 'reported'
  )
  const v6 = pickFamily(
    entry.addressV6,
    facts.publicIp.v6 ?? detected.v6,
    facts.publicIp.v6 ? 'ip' : 'reported'
  )
  const linux = facts.linuxHostname
  // IPv4 first: IPv4-only clients are still common.
  let host: string | null = null
  let hostSource: ClientAddressHostSource | null = null
  if (entry.hostname) {
    host = entry.hostname
    hostSource = 'hostname'
  } else if (v4.address ?? v6.address) {
    host = (v4.address ?? v6.address)!
    hostSource = 'address'
  } else if (linux && isQualifiedHostname(linux)) {
    host = linux
    hostSource = 'linux-hostname'
  }
  return {
    ...entry,
    label: PUBLIC_CLIENT_ADDRESS_LABEL,
    datacenterName: null,
    saved: saved !== undefined,
    effectiveV4: v4.address,
    effectiveV4Source: v4.source,
    effectiveV6: v6.address,
    effectiveV6Source: v6.source,
    host,
    hostSource,
  }
}

function resolveDatacenter(
  facts: ClientAddressFacts,
  pin: ClientAddressDatacenterPin
): EffectiveClientAddress {
  const saved = facts.saved.find(
    (entry) => entry.scope === 'datacenter' && entry.datacenterId === pin.datacenterId
  )
  const entry = saved ?? blankEntry('datacenter', pin.datacenterId)
  const v4 = pickFamily(entry.addressV4, pin.v4, 'pin')
  const v6 = pickFamily(entry.addressV6, pin.v6, 'pin')
  const preferred =
    pin.addressPreference === 'ipv4' ? (v4.address ?? v6.address) : (v6.address ?? v4.address)
  let hostSource: ClientAddressHostSource | null = null
  if (entry.hostname) hostSource = 'hostname'
  else if (preferred) hostSource = 'address'
  return {
    ...entry,
    label: pin.datacenterName,
    datacenterName: pin.datacenterName,
    saved: saved !== undefined,
    effectiveV4: v4.address,
    effectiveV4Source: v4.source,
    effectiveV6: v6.address,
    effectiveV6Source: v6.source,
    host: entry.hostname ?? preferred,
    hostSource,
  }
}

/**
 * Every side of the server, operator entries over detection. Datacenter
 * entries for a datacenter the server no longer belongs to are left out: a
 * removed pin must not keep advertising.
 */
export function resolveClientAddresses(facts: ClientAddressFacts): ServerClientAddresses {
  const pins = [...facts.pins].sort(
    (a, b) => a.priority - b.priority || a.datacenterName.localeCompare(b.datacenterName)
  )
  return {
    linuxHostname: facts.linuxHostname,
    entries: [resolvePublic(facts), ...pins.map((pin) => resolveDatacenter(facts, pin))],
  }
}

/**
 * The main one of `candidates`: the entry marked primary, else the public
 * side, else the first. Callers pass only candidates that can be used.
 */
export function pickMainClientAddress<T>(
  candidates: readonly T[],
  entryOf: (candidate: T) => Pick<ClientAddressEntry, 'primary' | 'scope'>
): T | undefined {
  return (
    candidates.find((c) => entryOf(c).primary) ??
    candidates.find((c) => entryOf(c).scope === 'public') ??
    candidates[0]
  )
}

/** The engine-independent main host clients dial, or `null` when there is none. */
export function mainClientAddressHost(addresses: ServerClientAddresses): string | null {
  const withHost = addresses.entries.filter((entry) => entry.host !== null)
  return pickMainClientAddress(withHost, (entry) => entry)?.host ?? null
}

/** One address a client outside the server can dial for one listener. */
export type ClientEndpoint = {
  label: string
  scope: ClientAddressScope
  datacenterId: string | null
  host: string
  port: number
  /** The endpoint that fills the main connection string. */
  primary: boolean
}

/**
 * One endpoint per side that can reach `portKey`, main one first. The main one
 * is the entry marked primary, else the public side, else the first
 * datacenter, each only when it has a host and the port is reachable there.
 */
export function clientEndpointsForListener(
  addresses: ServerClientAddresses,
  portKey: ClientAddressPortKey,
  listenPort: number
): ClientEndpoint[] {
  const reachable: Array<{ entry: EffectiveClientAddress; endpoint: ClientEndpoint }> = []
  for (const entry of addresses.entries) {
    if (!entry.host) continue
    const override = entry.ports[portKey]
    if (override === null) continue
    reachable.push({
      entry,
      endpoint: {
        label: entry.label,
        scope: entry.scope,
        datacenterId: entry.datacenterId,
        host: entry.host,
        port: override ?? listenPort,
        primary: false,
      },
    })
  }
  const main = pickMainClientAddress(reachable, (r) => r.entry)
  if (!main) return []
  main.endpoint.primary = true
  return [main.endpoint, ...reachable.filter((r) => r !== main).map((r) => r.endpoint)]
}

/**
 * Names and addresses the database listener certificate must carry for the
 * addresses clients use: the Linux hostname always (a compatibility name, even
 * a one-word one; never a connection string), plus every entry's DNS name and
 * effective addresses while the server allows external access.
 */
export function clientAddressCertificateNames(
  addresses: ServerClientAddresses,
  externalAccess: boolean
): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames = new Set<string>()
  const ipAddresses = new Set<string>()
  const linux = addresses.linuxHostname?.trim().toLowerCase()
  if (linux && isValidHostname(linux)) dnsNames.add(linux)
  if (externalAccess) {
    for (const entry of addresses.entries) {
      if (entry.hostname) dnsNames.add(entry.hostname)
      if (entry.effectiveV4) ipAddresses.add(entry.effectiveV4)
      if (entry.effectiveV6) ipAddresses.add(entry.effectiveV6)
    }
  }
  return { dnsNames: [...dnsNames], ipAddresses: [...ipAddresses] }
}

/** The external access setting is on and no side has anything to give out. */
export function clientAddressNeeded(
  externalAccess: boolean,
  endpoints: readonly ClientEndpoint[]
): boolean {
  return externalAccess && endpoints.length === 0
}

// ---------------------------------------------------------------------------
// PUT body validation
// ---------------------------------------------------------------------------

export type ClientAddressValidationError = {
  error:
    | 'invalid_addresses'
    | 'address_scope_invalid'
    | 'address_datacenter_not_member'
    | 'address_duplicate'
    | 'address_hostname_invalid'
    | 'address_hostname_single_label'
    | 'address_v4_invalid'
    | 'address_v6_invalid'
    | 'address_ports_invalid'
    | 'address_primary_multiple'
  message: string
  /** Index of the offending entry in `addresses`, when there is one. */
  index?: number
}

/** More entries than any server has sides is a malformed body. */
const MAX_CLIENT_ADDRESS_ENTRIES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blankToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

function fail(
  error: ClientAddressValidationError['error'],
  message: string,
  index?: number
): ClientAddressValidationError {
  return index === undefined ? { error, message } : { error, message, index }
}

function parseHostname(raw: unknown, index: number): string | null | ClientAddressValidationError {
  const value = blankToNull(raw)
  if (value === null) return null
  if (typeof value !== 'string') {
    return fail('address_hostname_invalid', 'The DNS name must be text.', index)
  }
  const name = value.trim().toLowerCase().replace(/\.$/, '')
  if (isValidHostname(name) && !name.includes('.')) {
    return fail(
      'address_hostname_single_label',
      'Use the full DNS name with a dot (for example db.example.com); a one-word name only works inside its own network.',
      index
    )
  }
  if (!isQualifiedHostname(name)) {
    return fail('address_hostname_invalid', `${name} is not a valid DNS name.`, index)
  }
  return name
}

function parseAddress(
  raw: unknown,
  version: 4 | 6,
  index: number
): string | null | ClientAddressValidationError {
  const value = blankToNull(raw)
  if (value === null) return null
  const error = version === 4 ? 'address_v4_invalid' : 'address_v6_invalid'
  const message = `Enter a single IPv${version} address clients can reach.`
  if (typeof value !== 'string' || value.includes('/')) return fail(error, message, index)
  const address = normalizeIpAddress(value.trim())
  if (!address || parseIpVersion(address) !== version) return fail(error, message, index)
  const scope = ipAddressScope(address)
  if (scope !== 'public' && scope !== 'private') return fail(error, message, index)
  return address
}

function isPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function parsePorts(
  raw: unknown,
  index: number
): ClientAddressPorts | ClientAddressValidationError {
  if (raw === undefined || raw === null) return {}
  const invalid = fail(
    'address_ports_invalid',
    'Ports are numbers from 1 to 65535, or empty when this address does not reach that service.',
    index
  )
  if (!isRecord(raw)) return invalid
  const ports: ClientAddressPorts = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!(CLIENT_ADDRESS_PORT_KEYS as readonly string[]).includes(key)) return invalid
    if (value === undefined) continue
    if (value !== null && !isPortNumber(value)) {
      return invalid
    }
    ports[key as ClientAddressPortKey] = value as number | null
  }
  return ports
}

function parseOneEntry(
  raw: unknown,
  index: number,
  memberDatacenterIds: ReadonlySet<string>
): ClientAddressEntry | ClientAddressValidationError {
  if (!isRecord(raw)) return fail('invalid_addresses', 'Each address must be an object.', index)
  const scope = raw.scope
  if (scope !== 'public' && scope !== 'datacenter') {
    return fail('address_scope_invalid', '`scope` is `public` or `datacenter`.', index)
  }
  const datacenterId = blankToNull(raw.datacenterId)
  if (scope === 'public' && datacenterId !== null) {
    return fail('address_scope_invalid', 'The public address names no datacenter.', index)
  }
  if (
    scope === 'datacenter' &&
    (typeof datacenterId !== 'string' || !memberDatacenterIds.has(datacenterId))
  ) {
    return fail(
      'address_datacenter_not_member',
      'This server does not belong to that datacenter.',
      index
    )
  }
  const hostname = parseHostname(raw.hostname, index)
  if (isRecord(hostname)) return hostname
  const addressV4 = parseAddress(raw.addressV4, 4, index)
  if (isRecord(addressV4)) return addressV4
  const addressV6 = parseAddress(raw.addressV6, 6, index)
  if (isRecord(addressV6)) return addressV6
  const ports = parsePorts(raw.ports, index)
  if ('error' in ports) return ports as ClientAddressValidationError
  if (raw.primary !== undefined && typeof raw.primary !== 'boolean') {
    return fail('invalid_addresses', '`primary` is true or false.', index)
  }
  return {
    scope,
    datacenterId: scope === 'datacenter' ? (datacenterId as string) : null,
    hostname,
    addressV4,
    addressV6,
    ports,
    primary: raw.primary === true,
  }
}

/**
 * Validate a PUT body `{ addresses: [...] }` against the datacenters the server
 * belongs to. The list replaces every saved entry of the server.
 */
export function parseClientAddressesBody(
  body: unknown,
  memberDatacenterIds: ReadonlySet<string>
): ClientAddressEntry[] | ClientAddressValidationError {
  if (!isRecord(body) || !Array.isArray(body.addresses)) {
    return fail('invalid_addresses', 'Send `addresses` as a list.')
  }
  if (body.addresses.length > MAX_CLIENT_ADDRESS_ENTRIES) {
    return fail('invalid_addresses', 'Too many addresses.')
  }
  const entries: ClientAddressEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of body.addresses.entries()) {
    const entry = parseOneEntry(raw, index, memberDatacenterIds)
    if ('error' in entry) return entry
    const key = entry.scope === 'public' ? 'public' : `datacenter:${entry.datacenterId}`
    if (seen.has(key)) {
      return fail('address_duplicate', 'Each side of the server is listed once.', index)
    }
    seen.add(key)
    entries.push(entry)
  }
  if (entries.filter((entry) => entry.primary).length > 1) {
    return fail('address_primary_multiple', 'Only one address can fill the main connection string.')
  }
  return entries
}

/** Parse `address.options` jsonb into the ports map (unknown keys dropped; an unreadable map reads as empty). */
export function parseClientAddressOptions(value: unknown): { ports: ClientAddressPorts } {
  if (!isRecord(value) || !isRecord(value.ports)) return { ports: {} }
  const parsed = parsePorts(
    Object.fromEntries(
      Object.entries(value.ports).filter(([key]) =>
        (CLIENT_ADDRESS_PORT_KEYS as readonly string[]).includes(key)
      )
    ),
    0
  )
  return { ports: 'error' in parsed ? {} : (parsed as ClientAddressPorts) }
}
