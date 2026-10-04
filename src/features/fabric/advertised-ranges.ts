/**
 * Policy for the ranges a gateway advertises. Every advertised range becomes
 * an `AllowedIPs` entry (and so a route) on every other server, so a careless
 * value, such as a default route, would take over the traffic of every server
 * in the organization. The daemon enforces a matching policy before it applies
 * peers (`turbopaneld` `fabricAllowedIpsPolicyError`); keep the two in step.
 */
import { cidrContains, cidrsOverlap, parseCidr } from '../../lib/ip-address.ts'

/** Shortest accepted prefix: IPv4 `/8` (everything shorter is a default-ish route). */
export const ADVERTISED_MIN_PREFIX_V4 = 8
/** Shortest accepted IPv6 prefix. */
export const ADVERTISED_MIN_PREFIX_V6 = 48

/** Private address blocks a gateway may advertise (RFC 1918, RFC 6598, RFC 4193). */
const ADVERTISABLE_BLOCKS: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
]

export type AdvertisedRangeProblem = {
  code: 'too_broad' | 'not_private' | 'overlaps_fabric' | 'overlaps_fabric_pool' | 'overlaps_member'
  cidr: string
  conflictsWith?: string
}

/** Stateless checks: size and "private only". Input is a valid, aligned CIDR. */
export function checkAdvertisedRangeShape(cidr: string): AdvertisedRangeProblem | null {
  const parsed = parseCidr(cidr)
  if (!parsed) return { code: 'not_private', cidr }
  const min = parsed.version === 4 ? ADVERTISED_MIN_PREFIX_V4 : ADVERTISED_MIN_PREFIX_V6
  if (parsed.prefix < min) return { code: 'too_broad', cidr }
  if (!ADVERTISABLE_BLOCKS.some((block) => cidrContains(block, cidr))) {
    return { code: 'not_private', cidr }
  }
  return null
}

export type AdvertisedRangeContext = {
  fabricCidr: string
  containerPool: string
  /** Every relay's own container prefix (the gateway's included). */
  relayPrefixes: readonly string[]
}

/** Overlap checks against the fabric's own addressing and the other members' ranges. */
export function checkAdvertisedRangeOverlaps(
  cidrs: readonly string[],
  context: AdvertisedRangeContext
): AdvertisedRangeProblem | null {
  for (const cidr of cidrs) {
    if (cidrsOverlap(cidr, context.fabricCidr)) {
      return { code: 'overlaps_fabric', cidr, conflictsWith: context.fabricCidr }
    }
    if (cidrsOverlap(cidr, context.containerPool)) {
      return { code: 'overlaps_fabric_pool', cidr, conflictsWith: context.containerPool }
    }
    const prefix = context.relayPrefixes.find((entry) => cidrsOverlap(cidr, entry))
    if (prefix) return { code: 'overlaps_member', cidr, conflictsWith: prefix }
  }
  return null
}

/** Plain-words message for the API. */
export function advertisedRangeProblemMessage(problem: AdvertisedRangeProblem): string {
  switch (problem.code) {
    case 'too_broad':
      return `${problem.cidr} is too broad: a gateway cannot advertise a default route or a range shorter than /${ADVERTISED_MIN_PREFIX_V4} (IPv4) or /${ADVERTISED_MIN_PREFIX_V6} (IPv6)`
    case 'not_private':
      return `${problem.cidr} is not a private range: a gateway can only advertise private (RFC 1918, 100.64.0.0/10 or fc00::/7) ranges`
    case 'overlaps_fabric':
      return `${problem.cidr} overlaps the fabric address range ${problem.conflictsWith}`
    case 'overlaps_fabric_pool':
      return `${problem.cidr} overlaps the fabric container pool ${problem.conflictsWith}`
    case 'overlaps_member':
      return `${problem.cidr} overlaps another server's fabric range ${problem.conflictsWith}`
  }
}
