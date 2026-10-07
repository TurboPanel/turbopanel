/**
 * The `linkDown` marker on a datacenter membership pin (`ip.metadata`).
 *
 * Set by the repin apply pass when the daemon reports the pin's NIC link as
 * down, cleared when it comes back. Kept apart from `repin.ts` so the
 * membership loader can read it without importing the repin module (which
 * itself imports the loader).
 */

import { normalizeIpAddress, stripInetPrefixSuffix } from '../../lib/ip-address.ts'

export type IpPinLinkDownMetadata = {
  /** ISO timestamp the daemon first reported the pin's NIC link as down. */
  since: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The marker when `value` carries a valid one, otherwise `undefined`. */
export function parseLinkDownMarker(value: unknown): IpPinLinkDownMetadata | undefined {
  if (!isRecord(value)) return undefined
  const since = value.since
  if (typeof since !== 'string' || since.length === 0 || Number.isNaN(Date.parse(since))) {
    return undefined
  }
  return { since }
}

/** Whether an `ip.metadata` value flags the pin's NIC link as down. */
export function pinLinkIsDown(metadata: unknown): boolean {
  return isRecord(metadata) && parseLinkDownMarker(metadata.linkDown) !== undefined
}

/**
 * Canonical key for matching a pin to a reported address: IPv6 written in
 * another case or compression, with a prefix or zone, must still match, or a
 * down marker could be left stuck with its network stuck as a last resort.
 */
export function addressMatchKey(address: string): string {
  const valid = normalizeIpAddress(address)
  if (valid === null) return stripInetPrefixSuffix(address.trim())
  const normalized = valid
  if (!normalized.includes(':')) return normalized
  try {
    // The URL parser compresses and lower-cases IPv6 literals.
    return new URL(`http://[${normalized}]`).hostname
  } catch {
    return normalized
  }
}
