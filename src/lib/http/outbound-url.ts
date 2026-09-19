/**
 * Where this instance is willing to dial, for any operator-supplied URL.
 *
 * Extracted from `git/forge-url.ts`, which was the first caller and still
 * owns the forge-specific error type. The rule is not forge-specific at all:
 * an address an admin types into the panel that points back inside the box —
 * the loopback, a link-local metadata endpoint, an RFC 1918 neighbour — turns
 * "connect a thing" into "make the control plane read its own
 * Postgres/RabbitMQ/Redis on my behalf". Every field that becomes a
 * server-side fetch goes through this.
 *
 * Two layers, on purpose:
 *
 * - {@link validateOutboundUrl} is pure and runs at write time — scheme, no
 *   credentials, no reserved names, and an IP literal has to classify as
 *   `public` under `ipAddressScope`.
 * - {@link resolveOutboundHostScope} resolves the name, which a literal-only
 *   validator cannot do. Only the Deno instance has a resolver; elsewhere it
 *   is a no-op. A name that later re-points to a private address (rebinding)
 *   is therefore not caught at fetch time; the host firewall is the second
 *   wall there (the compiled instance runs with unrestricted `--allow-net`
 *   since 2026-09-18).
 *
 * `allowPrivate` lifts the address and reserved-name rules. Scheme and
 * credential rules stay. Who passes it is a per-caller decision:
 *
 * - **Notification and alert targets pass it on every runtime** (decided
 *   2026-09-18, "allow everywhere, no exceptions"). Those fetches carry no
 *   credential of ours and their response goes nowhere, so a private
 *   address buys an attacker only a blind POST at the LAN — and the common
 *   self-hosted shape is exactly an Alertmanager on the LAN. It first
 *   followed the runtime (hosted refused, self-hosted allowed); a hosted
 *   instance cannot reach a private address anyway, so the split bought
 *   nothing but a second rule to explain.
 * - **A forge URL never passes it** — that fetch carries the App's
 *   credentials, and the response is parsed and acted on.
 */
import { ipAddressScope, normalizeIpAddress } from '../ip-address.ts'

export type OutboundUrlRejection =
  | 'malformed'
  | 'scheme_not_https'
  | 'credentials_in_url'
  | 'reserved_host'
  | 'address_not_public'

/**
 * Names that never denote a host reachable by anyone but this box. `.local`
 * (mDNS), `.internal` (cloud metadata / service discovery), `.localhost`
 * (RFC 6761), `.arpa`, and bare single-label hosts (`intranet`, `postgres` —
 * Docker service names resolve on the daemon-host network).
 */
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.home.arpa'] as const

export function hostIsReserved(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (!hostname.includes('.')) return true
  return RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

/** `[::1]` → `::1`; anything else unchanged. */
export function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

export type OutboundUrlOptions = {
  /** Accept loopback, link-local, RFC 1918 and reserved names — self-hosted LAN targets. */
  allowPrivate?: boolean
}

/** Returns the reason the URL is refused, or `null` when it is dialable. */
export function validateOutboundUrl(
  raw: string,
  opts: OutboundUrlOptions = {},
): OutboundUrlRejection | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return 'malformed'
  }
  if (url.protocol !== 'https:') return 'scheme_not_https'
  if (url.username !== '' || url.password !== '') return 'credentials_in_url'
  const hostname = unbracket(url.hostname.toLowerCase())
  if (hostname.length === 0) return 'malformed'
  if (opts.allowPrivate) return null
  const literal = normalizeIpAddress(hostname)
  if (literal !== null) {
    return ipAddressScope(literal) === 'public' ? null : 'address_not_public'
  }
  if (hostIsReserved(hostname)) return 'reserved_host'
  return null
}

/**
 * Resolve the name and refuse it if any answer is not a public address — the
 * write-time half of the check a literal-only validator cannot do. A name
 * that does not resolve at all is left to the fetch to fail on, not refused
 * here (the admin may be mid-DNS-setup).
 */
export async function resolveOutboundHostScope(
  raw: string,
  opts: OutboundUrlOptions = {},
): Promise<OutboundUrlRejection | null> {
  if (opts.allowPrivate) return null
  const deno = (globalThis as { Deno?: { resolveDns?: unknown } }).Deno
  if (typeof deno?.resolveDns !== 'function') return null
  const resolveDns = deno.resolveDns as (
    query: string,
    recordType: 'A' | 'AAAA',
  ) => Promise<string[]>
  let hostname: string
  try {
    hostname = unbracket(new URL(raw.trim()).hostname.toLowerCase())
  } catch {
    return 'malformed'
  }
  if (normalizeIpAddress(hostname) !== null) return null
  const answers: string[] = []
  for (const recordType of ['A', 'AAAA'] as const) {
    try {
      answers.push(...(await resolveDns(hostname, recordType)))
    } catch {
      // NXDOMAIN / no records of this type / resolver unavailable: nothing to judge.
    }
  }
  for (const answer of answers) {
    if (ipAddressScope(answer) !== 'public') return 'address_not_public'
  }
  return null
}
