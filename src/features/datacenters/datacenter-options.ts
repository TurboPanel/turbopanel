/**
 * Defensive parsers for `datacenter.options` jsonb fields used by the
 * client timezone, host-defaults, and routing-policy APIs. The routing policy
 * (`priority`, `trusted`, `addressPreference`) is stored in real columns; the
 * request-side parser still accepts those keys inside `options` (the wire
 * shape) and the helpers below move them to and from the columns.
 */

import { parseNtpDefaults, parseSshPort, type NtpDefaults } from '../servers/host-defaults.ts'
import { type LocationFields, parseLocationOverride } from '../geo/location-override.ts'

export type DatacenterOptions = {
  /** Datacenter-wide default timezone applied when a server has no override. */
  defaultServerTimezone?: string
  /**
   * When true, the datacenter default wins over org and per-server overrides
   * (unless another tier also enforces — datacenter is most specific).
   */
  enforceServerTimezone?: boolean
  /**
   * Preferred address family when choosing among a server's pins in this
   * datacenter. Absence implies default `'ipv6'` (RFC 6724 / RFC 8305). The
   * parser only returns the field when it was explicitly set to `'ipv6'` or
   * `'ipv4'`.
   */
  addressPreference?: 'ipv6' | 'ipv4'
  /**
   * Desired SSH listen port for member hosts that do not set a server override.
   * Omitted → inherit the organization default (then 22).
   */
  sshPort?: number
  /** Desired NTP client settings inherited by member servers. */
  ntp?: NtpDefaults
  /**
   * Routing-ladder rank among a server's datacenters — an integer in
   * `DATACENTER_PRIORITY_MIN`..`DATACENTER_PRIORITY_MAX`, **lower wins**.
   * Absence implies `DEFAULT_DATACENTER_PRIORITY`. The parser only returns the
   * field when it was explicitly set to an in-range integer.
   */
  priority?: number
  /**
   * Whether the datacenter's L2 is under the operator's control. Absence
   * implies `DEFAULT_DATACENTER_TRUSTED` (`true`); an untrusted datacenter is
   * one whose L2 the operator does not control (shared or provider-owned
   * segments). The parser only returns the field when it was explicitly set.
   */
  trusted?: boolean
  /**
   * Operator overrides for the datacenter's location (city, state, country,
   * ASN). The seeded `metadata.geo` supplies the defaults — see
   * `resolveLocation` (`../geo/location-override.ts`).
   */
  location?: LocationFields
}

/** What a datacenter network is, as stored in `datacenter.kind` (NULL = never said). */
export const DATACENTER_KINDS = ['lan', 'backplane', 'provider_private'] as const
export type DatacenterKind = (typeof DATACENTER_KINDS)[number]
/** Address families `datacenter.address_preference` may hold. */
export const DATACENTER_ADDRESS_PREFERENCES = ['ipv6', 'ipv4'] as const

/** A request's `kind`: absent stays `undefined`, `null` clears, anything but a listed value is invalid. */
export function parseDatacenterKind(
  value: unknown
): { ok: true; value: DatacenterKind | null | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value }
  const kind = DATACENTER_KINDS.find((candidate) => candidate === value)
  return kind ? { ok: true, value: kind } : { ok: false }
}

/** Default `datacenter.priority` column value. */
export const DEFAULT_DATACENTER_PRIORITY = 100
export const DATACENTER_PRIORITY_MIN = 0
export const DATACENTER_PRIORITY_MAX = 1000
/** Default `datacenter.trusted` column value. */
export const DEFAULT_DATACENTER_TRUSTED = true

/** Integer in range → the value; anything else → undefined (never clamps). */
export function parseDatacenterPriority(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < DATACENTER_PRIORITY_MIN || value > DATACENTER_PRIORITY_MAX) {
    return undefined
  }
  return value
}

/**
 * True when a request's `options` carries a `priority` that is not a whole
 * number in range. The stored-value parser drops such a value silently (it
 * must never throw on old rows); a request should say so instead. `null` and
 * absent both mean "not set".
 */
export function hasInvalidPriority(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const priority = (value as Record<string, unknown>).priority
  if (priority === undefined || priority === null) return false
  return parseDatacenterPriority(priority) === undefined
}

/** Resolved policy fields the API surfaces beside the raw `options`. */
export type DatacenterPolicy = {
  priority: number
  trusted: boolean
}

/** The routing policy as stored: the real `datacenter` columns (all NOT NULL, defaults applied). */
export type DatacenterPolicyColumns = {
  priority: number
  isTrusted: boolean
  addressPreference: 'ipv6' | 'ipv4'
}

/** Effective `addressPreference` when the request carries none (RFC 6724). */
export const DEFAULT_DATACENTER_ADDRESS_PREFERENCE = 'ipv6'

/** The three policy columns a datacenter row carries, taken from a row. */
export function resolveDatacenterPolicy(
  row: Pick<DatacenterPolicyColumns, 'priority' | 'isTrusted'>
): DatacenterPolicy {
  return { priority: row.priority, trusted: row.isTrusted }
}

/**
 * The column values a request's parsed `options` stands for: a key the request
 * left out resets its column to the documented default (`options` is
 * replace-all), and `null` (cleared options) resets all three.
 */
export function policyColumnsFromOptions(
  options: DatacenterOptions | null | undefined
): DatacenterPolicyColumns {
  return {
    priority: options?.priority ?? DEFAULT_DATACENTER_PRIORITY,
    isTrusted: options?.trusted ?? DEFAULT_DATACENTER_TRUSTED,
    addressPreference: options?.addressPreference ?? DEFAULT_DATACENTER_ADDRESS_PREFERENCE,
  }
}

/** `options` as stored in the jsonb column: the three policy keys live in columns, never here. */
export function storedDatacenterOptions(
  options: DatacenterOptions | null | undefined
): Omit<DatacenterOptions, 'priority' | 'trusted' | 'addressPreference'> | null {
  if (!options) return null
  const { priority: _p, trusted: _t, addressPreference: _a, ...rest } = options
  return Object.keys(rest).length > 0 ? rest : null
}

/**
 * The `options` object the API returns: the stored jsonb with the three policy
 * columns laid over it, so the wire shape (`options.priority`, `.trusted`,
 * `.addressPreference`) is what it was before they became columns.
 */
export function datacenterWireOptions(
  row: DatacenterPolicyColumns & { options: unknown }
): DatacenterOptions {
  return {
    ...parseDatacenterOptions(row.options),
    priority: row.priority,
    trusted: row.isTrusted,
    addressPreference: row.addressPreference,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse datacenter.options jsonb (missing/invalid keys → omitted). */
export function parseDatacenterOptions(value: unknown): DatacenterOptions {
  if (!isRecord(value)) return {}
  const options: DatacenterOptions = {}
  if (typeof value.defaultServerTimezone === 'string') {
    const trimmed = value.defaultServerTimezone.trim()
    if (trimmed.length > 0) options.defaultServerTimezone = trimmed
  }
  if (typeof value.enforceServerTimezone === 'boolean') {
    options.enforceServerTimezone = value.enforceServerTimezone
  }
  if (value.addressPreference === 'ipv6' || value.addressPreference === 'ipv4') {
    options.addressPreference = value.addressPreference
  }
  const sshPort = parseSshPort(value.sshPort)
  if (sshPort !== undefined) options.sshPort = sshPort
  const ntp = parseNtpDefaults(value.ntp)
  if (ntp) options.ntp = ntp
  const priority = parseDatacenterPriority(value.priority)
  if (priority !== undefined) options.priority = priority
  if (typeof value.trusted === 'boolean') options.trusted = value.trusted
  const location = parseLocationOverride(value.location)
  if (location) options.location = location
  return options
}
