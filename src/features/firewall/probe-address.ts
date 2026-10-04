/**
 * The address guard for the outside reachability probe.
 *
 * The probe opens TCP connections from the control plane, so it must never be
 * a way to reach somewhere else. Every address it may connect to is one the
 * control plane already stores for an enrolled server of the same organization
 * (`ip` rows); this module decides, from the address alone, whether the control
 * plane may dial it at all:
 *
 * - `forbidden`: never, whoever owns it. Loopback, link-local (cloud metadata
 *   lives at 169.254.169.254), "this network", multicast, reserved and
 *   documentation ranges, IPv6 unspecified/loopback/link-local/multicast, NAT64,
 *   and anything that does not parse.
 * - `private`: RFC 1918, CGNAT (100.64/10) and IPv6 ULA (fc00::/7). Dialled only
 *   when the platform adapter says the control plane can sit on the same
 *   network (self-hosted Deno). A hosted Worker cannot, so these are skipped
 *   there instead of attempted.
 * - `public`: everything else.
 */

export type ProbeAddressClass = 'public' | 'private' | 'forbidden'

function parseIpv4(text: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!match) return null
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10))
  return parts.every((part) => part <= 255) ? parts : null
}

function expandIpv6Groups(text: string): string[] | null {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0]!.split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : []
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - tail.length
  return missing < 1 ? null : [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
}

/** Eight 16-bit groups, or null. An embedded dotted IPv4 tail is folded into two groups. */
function parseIpv6(text: string): number[] | null {
  if (text.includes('%') || !text.includes(':')) return null
  let source = text
  const lastColon = text.lastIndexOf(':')
  const dotted = parseIpv4(text.slice(lastColon + 1))
  if (dotted !== null) {
    const high = ((dotted[0]! << 8) | dotted[1]!).toString(16)
    const low = ((dotted[2]! << 8) | dotted[3]!).toString(16)
    source = `${text.slice(0, lastColon + 1)}${high}:${low}`
  }
  const groups = expandIpv6Groups(source)
  if (groups === null) return null
  const values = groups.map((group) =>
    /^[0-9a-fA-F]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1
  )
  return values.every((value) => value >= 0) ? values : null
}

function isForbiddenIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 127 || a >= 224) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  return a === 203 && b === 0 && c === 113
}

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 10 || (a === 192 && b === 168)) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 100 && b >= 64 && b <= 127
}

function classifyIpv4(parts: number[]): ProbeAddressClass {
  const [a, b, c] = [parts[0]!, parts[1]!, parts[2]!]
  if (isForbiddenIpv4(a, b, c)) return 'forbidden'
  return isPrivateIpv4(a, b) ? 'private' : 'public'
}

function isIpv4Mapped(groups: number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
}

function isForbiddenIpv6(groups: number[]): boolean {
  const first = groups[0]!
  if (groups.slice(0, 6).every((group) => group === 0)) return true
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true
  if (first >> 8 === 0xff) return true
  if (first === 0x2001 && groups[1] === 0x0db8) return true
  return first === 0x64 && groups[1] === 0xff9b
}

function classifyIpv6(groups: number[]): ProbeAddressClass {
  if (isIpv4Mapped(groups)) {
    const low = groups[7]!
    const high = groups[6]!
    return classifyIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff])
  }
  if (isForbiddenIpv6(groups)) return 'forbidden'
  return (groups[0]! & 0xfe00) === 0xfc00 ? 'private' : 'public'
}

/** Which kind of address this is; anything that does not parse is `forbidden`. */
export function classifyProbeAddress(address: string): ProbeAddressClass {
  const text = address.trim()
  const v4 = parseIpv4(text)
  if (v4 !== null) return classifyIpv4(v4)
  const v6 = parseIpv6(text)
  return v6 === null ? 'forbidden' : classifyIpv6(v6)
}

/** True when the control plane may dial `address`, given whether it can reach private networks. */
export function mayProbeAddress(address: string, canReachPrivate: boolean): boolean {
  const kind = classifyProbeAddress(address)
  if (kind === 'forbidden') return false
  return kind === 'public' || canReachPrivate
}
