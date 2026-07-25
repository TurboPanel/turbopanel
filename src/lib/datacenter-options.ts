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
  return options
}
