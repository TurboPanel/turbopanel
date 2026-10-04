/**
 * Test oracle: a port of the daemon's `fabricAllowedIpsPolicyError`
 * (`turbopaneld` `src/commands/fabric-allowed-ips.ts`). It is written out here
 * from the daemon's rules, not from `advertised-ranges.ts`, so a test can
 * check a payload this control plane builds against the real refusal rules.
 * Keep it in step with the daemon.
 */
import { cidrContains, cidrsOverlap, parseCidr } from '../../lib/ip-address.ts'

const PRIVATE_BLOCKS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
]

type OraclePayload = {
  address: string
  prefix: string
  peers: readonly { allowedIPs: readonly string[] }[]
}

function sameRange(a: string, b: string): boolean {
  return cidrContains(a, b) && cidrContains(b, a)
}

function rangeProblem(cidr: string): string | null {
  const parsed = parseCidr(cidr)
  if (!parsed) return `${cidr} is not a valid range`
  if (parsed.prefix < (parsed.version === 4 ? 8 : 48)) return `${cidr} is too broad`
  if (!PRIVATE_BLOCKS.some((block) => cidrContains(block, cidr))) {
    return `${cidr} is not a private range`
  }
  return null
}

/** `null` when the daemon would accept the payload, else why it would refuse it. */
export function daemonAllowedIpsRefusal(payload: OraclePayload): string | null {
  const own = [payload.address, payload.prefix].map((value) =>
    value.includes('/') ? value : `${value}/32`
  )
  for (const [index, peer] of payload.peers.entries()) {
    for (const cidr of peer.allowedIPs) {
      const problem = rangeProblem(cidr)
      if (problem) return problem
      if (own.some((range) => cidrsOverlap(cidr, range))) {
        return `${cidr} overlaps this server's own fabric range`
      }
      for (const earlier of payload.peers.slice(0, index)) {
        const clash = earlier.allowedIPs.find(
          (range) => !sameRange(cidr, range) && cidrsOverlap(cidr, range)
        )
        if (clash) return `${cidr} overlaps another peer's range ${clash}`
      }
    }
  }
  return null
}
