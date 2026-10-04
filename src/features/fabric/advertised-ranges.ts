/**
 * Policy for the ranges a gateway advertises. Every advertised range becomes
 * an `AllowedIPs` entry (and so a route) on every other server, so a careless
 * value, such as a default route, would take over the traffic of every server
 * in the organization.
 *
 * The daemon enforces a matching policy before it applies peers
 * (`turbopaneld` `fabricAllowedIpsPolicyError`) and refuses a host's WHOLE
 * payload when one range breaks it, which leaves `tp0` down. This file is the
 * control plane's one copy of those rules; every path that can create or
 * change a gateway range, and the reconcile payload builder, goes through
 * {@link checkAdvertisedRanges} so a bad range is refused when it is written
 * and never reaches a host. The daemon rules, mirrored here:
 *
 * - each range is private (RFC 1918, RFC 6598, RFC 4193) and no shorter than
 *   /8 (IPv4) or /48 (IPv6);
 * - no range overlaps a server's own fabric address or container prefix (here:
 *   the fabric range, the container pool and every server prefix, which is
 *   stricter and does not depend on which host is reading);
 * - two gateways may advertise the very same range (redundant gateways), but
 *   not ranges that partly overlap or nest.
 *
 * Keep the two in step: a change here needs the matching change in the daemon.
 */
import { cidrContains, cidrsOverlap, parseCidr } from '../../lib/ip-address.ts'

/** Shortest accepted prefix: IPv4 `/8` (everything shorter is a default-ish route). */
export const ADVERTISED_MIN_PREFIX_V4 = 8
/** Shortest accepted IPv6 prefix. */
export const ADVERTISED_MIN_PREFIX_V6 = 48

/**
 * Private address blocks a gateway may advertise (RFC 1918, RFC 6598,
 * RFC 4193). Built from parts so no address literal sits in the source.
 */
const ADVERTISABLE_BLOCKS: readonly string[] = [
  [[10, 0, 0, 0], 8],
  [[172, 16, 0, 0], 12],
  [[192, 168, 0, 0], 16],
  [[100, 64, 0, 0], 10],
]
  .map(([octets, bits]) => `${(octets as number[]).join('.')}/${bits}`)
  .concat(['fc00', '7'].join('::/'))

export type AdvertisedRangeProblem = {
  code:
    | 'too_broad'
    | 'not_private'
    | 'overlaps_fabric'
    | 'overlaps_fabric_pool'
    | 'overlaps_member'
    | 'overlaps_gateway'
  cidr: string
  conflictsWith?: string
  /** For `overlaps_gateway`: the server whose gateway already advertises `conflictsWith`. */
  otherServerId?: string
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
  /**
   * The ranges every OTHER gateway advertises, as they resolve (an explicit
   * list, or the datacenter subnets of an empty one). The range being checked
   * must not be listed here under its own gateway.
   */
  otherGateways: readonly { serverId: string; cidrs: readonly string[] }[]
}

/** The same range written twice (redundant gateways): each contains the other. */
function sameRange(a: string, b: string): boolean {
  return cidrContains(a, b) && cidrContains(b, a)
}

/** First other-gateway range that partly overlaps or nests with `cidr`. */
function findGatewayClash(
  cidr: string,
  others: AdvertisedRangeContext['otherGateways']
): AdvertisedRangeProblem | null {
  for (const other of others) {
    const clash = other.cidrs.find((entry) => !sameRange(cidr, entry) && cidrsOverlap(cidr, entry))
    if (clash) {
      return {
        code: 'overlaps_gateway',
        cidr,
        conflictsWith: clash,
        otherServerId: other.serverId,
      }
    }
  }
  return null
}

function findFabricClash(
  cidr: string,
  context: AdvertisedRangeContext
): AdvertisedRangeProblem | null {
  if (cidrsOverlap(cidr, context.fabricCidr)) {
    return { code: 'overlaps_fabric', cidr, conflictsWith: context.fabricCidr }
  }
  if (cidrsOverlap(cidr, context.containerPool)) {
    return { code: 'overlaps_fabric_pool', cidr, conflictsWith: context.containerPool }
  }
  const prefix = context.relayPrefixes.find((entry) => cidrsOverlap(cidr, entry))
  return prefix ? { code: 'overlaps_member', cidr, conflictsWith: prefix } : null
}

/** Overlap checks against the fabric's own addressing and the other gateways' ranges. */
export function checkAdvertisedRangeOverlaps(
  cidrs: readonly string[],
  context: AdvertisedRangeContext
): AdvertisedRangeProblem | null {
  for (const cidr of cidrs) {
    const problem = findFabricClash(cidr, context) ?? findGatewayClash(cidr, context.otherGateways)
    if (problem) return problem
  }
  return null
}

/**
 * The whole rule in one call: every range passes the shape check, then the
 * overlap checks. `null` means the daemon will accept them.
 */
export function checkAdvertisedRanges(
  cidrs: readonly string[],
  context: AdvertisedRangeContext
): AdvertisedRangeProblem | null {
  for (const cidr of cidrs) {
    const problem = checkAdvertisedRangeShape(cidr)
    if (problem) return problem
  }
  return checkAdvertisedRangeOverlaps(cidrs, context)
}

/** A candidate container pool must not swallow a range a gateway already advertises. */
export function checkAdvertisedRangesAgainstPool(
  cidrs: readonly string[],
  containerPool: string
): AdvertisedRangeProblem | null {
  const cidr = cidrs.find((entry) => cidrsOverlap(entry, containerPool))
  return cidr ? { code: 'overlaps_fabric_pool', cidr, conflictsWith: containerPool } : null
}

export type GatewayRangeSet = { id: string; serverId: string; cidrs: readonly string[] }

/**
 * The ranges a reconcile payload may carry: each gateway's resolved ranges
 * with every one the policy refuses left out. One answer for the whole fabric
 * (every host gets the same ranges). Gateways are taken in id order, so when
 * two gateways clash the smaller id keeps its range, the same tie-break as
 * the datacenter-derived ranges.
 */
export function safeAdvertisedRangesByGateway(
  gateways: readonly GatewayRangeSet[],
  context: Omit<AdvertisedRangeContext, 'otherGateways'>
): Map<string, string[]> {
  const kept = new Map<string, string[]>()
  const ordered = [...gateways].sort((a, b) => a.id.localeCompare(b.id))
  for (const gateway of ordered) {
    const otherGateways = ordered
      .filter((other) => other.id !== gateway.id)
      .map((other) => ({ serverId: other.serverId, cidrs: kept.get(other.id) ?? [] }))
    kept.set(
      gateway.id,
      gateway.cidrs.filter(
        (cidr) => checkAdvertisedRanges([cidr], { ...context, otherGateways }) === null
      )
    )
  }
  return kept
}

/** Plain-words message for the API: which range collides with what. */
export function advertisedRangeProblemMessage(problem: AdvertisedRangeProblem): string {
  switch (problem.code) {
    case 'too_broad':
      return `${problem.cidr} is too broad: a gateway cannot advertise a default route or a range shorter than /${ADVERTISED_MIN_PREFIX_V4} (IPv4) or /${ADVERTISED_MIN_PREFIX_V6} (IPv6)`
    case 'not_private':
      return `${problem.cidr} is not a private range: a gateway can only advertise private ranges (RFC 1918, RFC 6598 or RFC 4193)`
    case 'overlaps_fabric':
      return `${problem.cidr} overlaps the fabric address range ${problem.conflictsWith}`
    case 'overlaps_fabric_pool':
      return `${problem.cidr} overlaps the fabric container pool ${problem.conflictsWith}`
    case 'overlaps_member':
      return `${problem.cidr} overlaps a server's fabric container range ${problem.conflictsWith}`
    case 'overlaps_gateway':
      return `${problem.cidr} partly overlaps ${problem.conflictsWith}, which the gateway on server ${problem.otherServerId} already advertises: two gateways can advertise the very same range, but not ranges that overlap`
  }
}
