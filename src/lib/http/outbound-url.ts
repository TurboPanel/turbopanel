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
 *   validator cannot do: with Deno's resolver on the Deno instance, over
 *   DNS-over-HTTPS (`doh-resolve.ts`) on Workers, which has no DNS API. A
 *   name that later re-points to a private address (rebinding) is caught
 *   when the fetch-time check runs it again, and
 *   {@link resolveOutboundHost} returns the judged answers so `forgeFetch`
 *   (`git/forge-url.ts`) can connect to exactly those (`pinned-fetch.ts`)
 *   instead of letting `fetch` resolve the name a second time.
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
import { abortable } from './abortable.ts'
import { dohLookup } from './doh-resolve.ts'

export type OutboundUrlRejection =
  | 'malformed'
  | 'scheme_not_https'
  | 'credentials_in_url'
  | 'reserved_host'
  | 'address_not_public'
  | 'dns_lookup_failed'

/**
 * Names that never denote a host reachable by anyone but this box. `.local`
 * (mDNS), `.internal` (cloud metadata / service discovery), `.localhost`
 * (RFC 6761), `.arpa`, and bare single-label hosts (`intranet`, `postgres` —
 * Docker service names resolve on the daemon-host network).
 */
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.home.arpa'] as const

/** `localhost.` → `localhost`: a fully qualified name's trailing dot names the same host. */
export function stripTrailingDots(hostname: string): string {
  let host = hostname
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

export function hostIsReserved(rawHostname: string): boolean {
  const hostname = stripTrailingDots(rawHostname)
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
  opts: OutboundUrlOptions = {}
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

export type ResolveOutboundHostOptions = OutboundUrlOptions & {
  /**
   * Fetch time: a resolver failure other than "no such name" (SERVFAIL, a
   * timeout, a refused query) refuses the URL rather than letting the fetch
   * run unjudged — an attacker who controls the zone could fail the check's
   * lookup and answer the fetch's with a private address. A name that simply
   * does not exist is still left to the fetch, which cannot connect to it.
   */
  failClosed?: boolean
  /** The caller's deadline; a lookup still pending when it fires rejects with its reason. */
  signal?: AbortSignal
}

export type OutboundHostResolution = {
  rejection: OutboundUrlRejection | null
  /**
   * The public addresses the name resolved to (an IP-literal host yields
   * itself). Empty when the name does not exist (write time only on
   * Workers). A caller that can pin a connection connects to one of these and
   * never resolves the name again.
   */
  addresses: string[]
}

type RecordType = 'A' | 'AAAA'

/** The runtime's A/AAAA lookup, and how to read its failures. */
type HostResolver = {
  lookup: (
    query: string,
    recordType: RecordType,
    options?: { signal?: AbortSignal }
  ) => Promise<string[]>
  /** A failure that only says "no such name / no records of this type". */
  isNoSuchRecord: (error: unknown) => boolean
  /**
   * With `failClosed`, refuse a name that yields no address at all. Set where
   * the fetch cannot be pinned (Workers): `fetch` would resolve the name
   * itself, so an unjudged name must not reach it.
   */
  requiresAnswers: boolean
}

/**
 * Deno's own resolver where there is one (the Deno instance); otherwise
 * DNS-over-HTTPS (`doh-resolve.ts`), which is how the Workers runtime — no DNS
 * API — gets the same any-answer-private check. On Workers every DoH failure,
 * NXDOMAIN included, counts as a failure.
 */
function runtimeResolver(): HostResolver {
  const deno = (globalThis as { Deno?: { resolveDns?: unknown } }).Deno
  if (typeof deno?.resolveDns === 'function') {
    return {
      lookup: deno.resolveDns as HostResolver['lookup'],
      isNoSuchRecord,
      requiresAnswers: false,
    }
  }
  return {
    lookup: dohLookup,
    isNoSuchRecord: () => false,
    requiresAnswers: true,
  }
}

/**
 * Collect every answer; at fetch time (`failClosed`) a lookup failure that is
 * not "no such record" makes the name unjudged, returned as `null`.
 */
function answersOf(
  lookups: PromiseSettledResult<string[]>[],
  resolver: HostResolver,
  failClosed: boolean
): string[] | null {
  const answers: string[] = []
  for (const lookup of lookups) {
    if (lookup.status === 'fulfilled') answers.push(...lookup.value)
    // NXDOMAIN / no records of this type: nothing to judge. Anything else
    // (SERVFAIL, timeout, resolver unreachable) is unjudged at fetch time.
    else if (failClosed && !resolver.isNoSuchRecord(lookup.reason)) return null
  }
  if (failClosed && resolver.requiresAnswers && answers.length === 0) {
    return null
  }
  return answers
}

/**
 * Resolve the name, refuse it if any answer is not a public address, and
 * hand back the answers so the caller can pin the connection to them. At
 * write time a name that does not resolve is left to the fetch to fail on
 * (the admin may be mid-DNS-setup); with `failClosed` (fetch time) a resolver
 * error refuses it — on Workers so does a name with no address at all.
 */
export async function resolveOutboundHost(
  raw: string,
  opts: ResolveOutboundHostOptions = {}
): Promise<OutboundHostResolution> {
  if (opts.allowPrivate) return { rejection: null, addresses: [] }
  let hostname: string
  try {
    hostname = unbracket(new URL(raw.trim()).hostname.toLowerCase())
  } catch {
    return { rejection: 'malformed', addresses: [] }
  }
  const literal = normalizeIpAddress(hostname)
  if (literal !== null) return { rejection: null, addresses: [literal] }
  const resolver = runtimeResolver()
  const { signal } = opts
  const lookups = await Promise.allSettled(
    (['A', 'AAAA'] as const).map((recordType) =>
      abortable(resolver.lookup(hostname, recordType, { signal }), signal)
    )
  )
  // The caller's deadline is not a resolver failure: surface it as the abort it is.
  signal?.throwIfAborted()
  const answers = answersOf(lookups, resolver, opts.failClosed === true)
  if (answers === null) {
    return { rejection: 'dns_lookup_failed', addresses: [] }
  }
  if (answers.some((answer) => ipAddressScope(answer) !== 'public')) {
    return { rejection: 'address_not_public', addresses: [] }
  }
  return { rejection: null, addresses: answers }
}

/** {@link resolveOutboundHost} reduced to its verdict. */
export async function resolveOutboundHostScope(
  raw: string,
  opts: ResolveOutboundHostOptions = {}
): Promise<OutboundUrlRejection | null> {
  return (await resolveOutboundHost(raw, opts)).rejection
}

/** Deno reports NXDOMAIN and "no records of this type" as `NotFound`. */
function isNoSuchRecord(error: unknown): boolean {
  const notFound = (globalThis as { Deno?: { errors?: { NotFound?: unknown } } }).Deno?.errors
    ?.NotFound
  return typeof notFound === 'function' && error instanceof (notFound as new () => Error)
}
