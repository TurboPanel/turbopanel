/**
 * Where an app database login may be used from, and how many connections it
 * may hold open.
 *
 * Stored on `login.metadata` (no migration: jsonb keys):
 *  - `allowedSources`: a list of places. Absent means "anywhere", today's
 *    behaviour, and no ProxySQL rules are made for the login.
 *  - `maxConnections`: a whole number; absent means no per-login cap.
 *
 * A place is one of:
 *  - `internal`        this server (its loopback and its Docker networks)
 *  - `server:<id>`     one of the organization's servers (all its addresses,
 *                      looked up again on every reconcile)
 *  - `address:<value>` one IP address, or an address prefix ending in `%`
 *                      (`203.0.113.%`, `2001:db8:1:%`). A CIDR range is turned
 *                      into such a prefix on save when it can be said exactly.
 *
 * ProxySQL answers a refused login at the first query, not at sign-in, and it
 * can only match an exact address or a trailing `%` prefix. The daemon builds
 * the rules from the already-resolved list ({@link resolveLoginSourcesForWire}).
 */

import {
  bigIntToIp,
  ipToBigInt,
  normalizeIpAddress,
  parseCidr,
  parseIpVersion,
} from '../../lib/ip-address.ts'

/** Most places one login may list. */
export const MAX_LOGIN_SOURCE_ENTRIES = 100
/** Most resolved addresses sent to the daemon for one login. */
export const MAX_LOGIN_RESOLVED_SOURCES = 1024
/** ProxySQL's own default; a larger cap would do nothing. */
export const MAX_LOGIN_CONNECTIONS = 10_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IPV4_PREFIX_RE = /^((?:\d{1,3}\.){1,3})%$/
const IPV6_PREFIX_RE = /^((?:[0-9a-f]{1,4}:){1,7})%$/i

export type LoginSourcesError = { error: string; message: string }

const fail = (error: string, message: string): LoginSourcesError => ({ error, message })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stored places of a login; `undefined` means unrestricted. */
export function loginAllowedSources(metadata: unknown): string[] | undefined {
  if (!isRecord(metadata) || !Array.isArray(metadata.allowedSources)) return undefined
  const list = metadata.allowedSources.filter((entry): entry is string => typeof entry === 'string')
  return list.length === 0 ? undefined : list
}

/** Stored connection cap of a login; `undefined` means no cap. */
export function loginMaxConnections(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) return undefined
  const value = metadata.maxConnections
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

/** Server ids named by `server:<id>` places. */
export function loginSourceServerIds(sources: readonly string[] | undefined): string[] {
  return (sources ?? [])
    .filter((s) => s.startsWith('server:'))
    .map((s) => s.slice('server:'.length))
}

function ipv6Groups(base: bigint): number[] {
  return Array.from({ length: 8 }, (_, i) => Number((base >> BigInt(112 - 16 * i)) & 0xffffn))
}

const CIDR_HELP =
  'List the addresses one by one, or use a prefix such as 203.0.113.% (IPv4: whole /8, /16 or /24 ranges) or 2001:db8:1:% (IPv6: whole 16-bit groups, /16 to /112).'

/** A CIDR as the one address or prefix ProxySQL can match exactly, or a plain-words error. */
export function cidrToSourcePrefix(value: string): string | LoginSourcesError {
  const cidr = parseCidr(value)
  if (!cidr) return fail('managed_login_source_invalid', `'${value}' is not a valid address range.`)
  const hostBits = (cidr.version === 4 ? 32 : 128) - cidr.prefix
  if (hostBits === 0) return standardAddress(value.split('/')[0]!) ?? value.split('/')[0]!
  if (cidr.version === 4) {
    if (cidr.prefix % 8 !== 0 || cidr.prefix === 0) {
      return fail(
        'managed_login_source_range_not_exact',
        `${value} can't be matched exactly. The database proxy only matches one address or a prefix on a whole number boundary. ${CIDR_HELP}`
      )
    }
    const octets = [24, 16, 8, 0].map((shift) => Number((cidr.base >> BigInt(shift)) & 0xffn))
    return `${octets.slice(0, cidr.prefix / 8).join('.')}.%`
  }
  if (cidr.prefix % 16 !== 0 || cidr.prefix < 16) {
    return fail(
      'managed_login_source_range_not_exact',
      `${value} can't be matched exactly. The database proxy only matches one address or a prefix on a whole number boundary. ${CIDR_HELP}`
    )
  }
  const groups = ipv6Groups(cidr.base).slice(0, cidr.prefix / 16)
  if (groups.includes(0)) {
    return fail(
      'managed_login_source_range_not_exact',
      `${value} has an all-zero group in its fixed part, which the database proxy can't match reliably. ${CIDR_HELP}`
    )
  }
  return `${groups.map((g) => g.toString(16)).join(':')}:%`
}

/** An IP address in the short form ProxySQL shows a client (lowercase, `::` compressed). */
function standardAddress(raw: string): string | null {
  const address = normalizeIpAddress(raw)
  if (address === null) return null
  if (parseIpVersion(address) !== 6) return address
  const big = ipToBigInt(address)
  return big === null ? null : bigIntToIp(big, 6)
}

function parseAddressEntry(raw: string): string | LoginSourcesError {
  const value = raw.trim()
  if (value.includes('/')) return cidrToSourcePrefix(value)
  if (value.endsWith('%')) {
    const v4 = IPV4_PREFIX_RE.exec(value)
    if (v4) {
      const octets = v4[1]!.split('.').filter(Boolean)
      const ok = octets.every((o) => Number(o) <= 255 && (o === '0' || !o.startsWith('0')))
      if (ok) return value
    } else if (IPV6_PREFIX_RE.test(value)) {
      const groups = value.slice(0, -2).split(':')
      if (groups.every((g) => Number.parseInt(g, 16) !== 0)) {
        return `${groups.map((g) => Number.parseInt(g, 16).toString(16)).join(':')}:%`
      }
    }
    return fail(
      'managed_login_source_invalid',
      `'${value}' is not a valid address prefix. Use something like 203.0.113.% or 2001:db8:1:% (no zero groups, no '::').`
    )
  }
  const address = standardAddress(value)
  if (address === null) {
    return fail('managed_login_source_invalid', `'${value}' is not a valid IP address.`)
  }
  return address
}

/**
 * Validate a requested list of places. `null` result means "anywhere" (the
 * caller stores no key). Server ids are only shape-checked here; the route
 * checks they belong to the organization.
 */
export function parseLoginAllowedSources(raw: unknown): string[] | null | LoginSourcesError {
  const list = normalizeSourceList(raw)
  if (list === null || isLoginSourcesError(list)) return list
  const out = new Set<string>()
  for (const entry of list) {
    const parsed = parseSourceEntry(entry)
    if (typeof parsed !== 'string') return parsed
    out.add(parsed)
  }
  return [...out]
}

const isLoginSourcesError = (value: unknown): value is LoginSourcesError =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The trimmed, de-duplicated list; `null` for `any`/`null` (anywhere); or the refusal. */
function normalizeSourceList(raw: unknown): string[] | null | LoginSourcesError {
  if (raw === null) return null
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
    return fail(
      'managed_login_sources_invalid',
      "allowedSources must be a list of places: 'any', 'internal', 'server:<id>' or 'address:<ip, prefix% or range>'."
    )
  }
  const list = [...new Set((raw as string[]).map((entry) => entry.trim()))]
  if (list.length === 0) {
    return fail(
      'managed_login_sources_empty',
      "allowedSources can't be empty: an empty list would refuse every connection. Choose at least one place, or 'any' to allow everywhere."
    )
  }
  if (list.length > MAX_LOGIN_SOURCE_ENTRIES) {
    return fail(
      'managed_login_sources_too_many',
      `A login can list at most ${MAX_LOGIN_SOURCE_ENTRIES} places. Use an address prefix such as 203.0.113.% to cover more.`
    )
  }
  if (!list.includes('any')) return list
  return list.length === 1
    ? null
    : fail(
        'managed_login_sources_any_alone',
        "'any' means everywhere, so it can't be combined with other places."
      )
}

/** One place in its stored form, or the refusal. */
function parseSourceEntry(entry: string): string | LoginSourcesError {
  if (entry === 'internal') return entry
  if (entry.startsWith('server:')) {
    const id = entry.slice('server:'.length)
    return UUID_RE.test(id)
      ? `server:${id.toLowerCase()}`
      : fail('managed_login_source_invalid', `'${entry}' does not name a server.`)
  }
  if (entry.startsWith('address:')) {
    const parsed = parseAddressEntry(entry.slice('address:'.length))
    return typeof parsed === 'string' ? `address:${parsed}` : parsed
  }
  return fail(
    'managed_login_source_invalid',
    `'${entry}' is not a place. Use 'any', 'internal', 'server:<id>' or 'address:<ip, prefix% or range>'.`
  )
}

/** Validate a connection cap; `null` clears it. */
export function parseLoginMaxConnections(raw: unknown): number | null | LoginSourcesError {
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_LOGIN_CONNECTIONS) {
    return fail(
      'managed_login_max_connections_invalid',
      `maxConnections must be a whole number from 1 to ${MAX_LOGIN_CONNECTIONS}, or null to remove the cap.`
    )
  }
  return raw
}

/**
 * The daemon's view: plain addresses and `%` prefixes, plus whether the server
 * itself counts. `serverAddresses` maps a server id to all its addresses.
 */
export function resolveLoginSourcesForWire(
  sources: readonly string[],
  serverAddresses: ReadonlyMap<string, readonly string[]>
): { allowedSources: string[]; allowLocalSources: boolean } {
  const out = new Set<string>()
  let allowLocalSources = false
  for (const entry of sources) {
    if (entry === 'internal') allowLocalSources = true
    else if (entry.startsWith('address:')) out.add(entry.slice('address:'.length))
    else if (entry.startsWith('server:')) {
      for (const address of serverAddresses.get(entry.slice('server:'.length)) ?? [])
        out.add(address)
    }
  }
  const sorted = [...out].sort((a, b) => a.localeCompare(b)).slice(0, MAX_LOGIN_RESOLVED_SOURCES)
  return { allowedSources: sorted, allowLocalSources }
}

function describePlace(place: string): string {
  if (place === 'internal') return 'this server only (its own programs and containers)'
  if (place.startsWith('server:')) return `server ${place.slice('server:'.length)}`
  return place.slice('address:'.length)
}

/** Plain-words lines for a dry run. */
export function describeLoginLimits(
  sources: readonly string[] | undefined,
  maxConnections: number | undefined
): string[] {
  const lines: string[] = []
  if (sources === undefined) {
    lines.push('Allow this login from anywhere (no source limit)')
  } else {
    const places = sources.map(describePlace)
    lines.push(
      `Limit this login to: ${places.join(', ')}. The login still connects from anywhere, but the database proxy refuses every query from other addresses`
    )
  }
  lines.push(
    maxConnections === undefined
      ? 'Set no cap on this login’s connections'
      : `Allow at most ${maxConnections} connections at once for this login`
  )
  return lines
}

export type LoginWireLimits =
  | { omit: true }
  | {
      omit: false
      fields: { allowedSources?: string[]; allowLocalSources?: boolean; maxConnections?: number }
    }

/**
 * The fields to send for one app login. A daemon that lacks
 * `managed-login-limits-v1` would ignore a source limit and leave the login
 * open, so such a login is left out of its payload (it cannot sign in there)
 * rather than sent unlimited. A bare connection cap is only dropped.
 */
export function loginWireLimits(
  metadata: unknown,
  options: {
    daemonSupportsLimits: boolean
    serverAddresses: ReadonlyMap<string, readonly string[]>
    /** The server this payload is for: naming it also lets its own programs in. */
    serverId?: string
  }
): LoginWireLimits {
  const sources = loginAllowedSources(metadata)
  const cap = loginMaxConnections(metadata)
  if (!options.daemonSupportsLimits)
    return sources === undefined ? { omit: false, fields: {} } : { omit: true }
  const fields: {
    allowedSources?: string[]
    allowLocalSources?: boolean
    maxConnections?: number
  } = {}
  if (sources !== undefined) {
    const resolved = resolveLoginSourcesForWire(sources, options.serverAddresses)
    fields.allowedSources = resolved.allowedSources
    // Programs on a server reach its proxy as the Docker gateway, never as the server's own address.
    const namesThisServer =
      options.serverId !== undefined && sources.includes(`server:${options.serverId}`)
    if (resolved.allowLocalSources || namesThisServer) fields.allowLocalSources = true
  }
  if (cap !== undefined) fields.maxConnections = cap
  return { omit: false, fields }
}
