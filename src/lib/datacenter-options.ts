/**
 * Defensive parsers for `datacenter.options` jsonb fields used by the
 * client timezone APIs.
 */

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
  return options
}
