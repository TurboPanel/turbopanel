/**
 * Where a forge may live, as far as this instance is willing to dial it.
 *
 * A forge's `baseUrl` / `apiUrl` / `webhookOrigin` are typed in by an
 * organization admin and later fetched server-side with the App's credentials
 * attached (`github-provider.ts`, `gitlab-api.ts`, `github-app-token.ts`). An
 * address that points back inside the box — the loopback, a link-local
 * metadata endpoint, an RFC 1918 neighbour — turns "connect a self-hosted
 * GitLab" into "make the control plane read its own Postgres/RabbitMQ/Redis on
 * my behalf". Nothing else on the write path looked at the value beyond
 * "non-empty string" before this module existed.
 *
 * Two layers, on purpose:
 *
 * - {@link validateForgeUrl} runs at write time (create, patch, the manifest
 *   flow) and is pure — scheme, no credentials, no reserved names, and an IP
 *   literal has to classify as `public` under `ipAddressScope`.
 * - {@link assertForgeUrlAllowed} re-runs the same check at the two fetch-time
 *   choke points (`githubApiBaseFor`, `gitlabApiBase`), so a row that predates
 *   this module, or one written by anything other than the routes, is still
 *   refused before a credential leaves the process.
 *
 * DNS is resolved at write time only, and only where a resolver exists (the
 * Deno instance — Workers has none, and Cloudflare's egress cannot reach
 * private ranges anyway). A name that later re-points to a private address
 * (rebinding) is therefore not caught at fetch time; the compiled instance's
 * `--allow-net` allowlist is the second wall there (`deno.json` `compile`).
 */
import { ipAddressScope, normalizeIpAddress } from '../ip-address.ts'

export type ForgeUrlField = 'baseUrl' | 'apiUrl' | 'webhookOrigin'

export type ForgeUrlRejection =
  | 'malformed'
  | 'scheme_not_https'
  | 'credentials_in_url'
  | 'reserved_host'
  | 'address_not_public'

export class ForgeUrlError extends Error {
  readonly field: ForgeUrlField
  readonly reason: ForgeUrlRejection
  constructor(field: ForgeUrlField, reason: ForgeUrlRejection) {
    super(`forge ${field} rejected: ${reason}`)
    this.name = 'ForgeUrlError'
    this.field = field
    this.reason = reason
  }
}

/**
 * Names that never denote a forge reachable by anyone but this host. `.local`
 * (mDNS), `.internal` (cloud metadata / service discovery), `.localhost`
 * (RFC 6761), `.arpa`, and bare single-label hosts (`intranet`, `postgres` —
 * Docker service names resolve on the daemon-host network).
 */
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.home.arpa'] as const

function hostIsReserved(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (!hostname.includes('.')) return true
  return RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

/** `[::1]` → `::1`; anything else unchanged. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Validate one forge URL field. Returns the reason it is refused, or `null`
 * when the URL is one this instance will dial.
 */
export function validateForgeUrl(raw: string): ForgeUrlRejection | null {
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
  const literal = normalizeIpAddress(hostname)
  if (literal !== null) {
    return ipAddressScope(literal) === 'public' ? null : 'address_not_public'
  }
  if (hostIsReserved(hostname)) return 'reserved_host'
  return null
}

/** Throwing form for the fetch-time choke points. */
export function assertForgeUrlAllowed(field: ForgeUrlField, raw: string): string {
  const reason = validateForgeUrl(raw)
  if (reason) throw new ForgeUrlError(field, reason)
  return raw
}

/**
 * Resolve the name and refuse it if any answer is not a public address —
 * the write-time half of the check that a literal-only validator cannot do.
 * Only the Deno instance has a resolver; elsewhere this is a no-op that
 * resolves to `null`. A name that does not resolve at all is left to the
 * fetch to fail on, not refused here (the admin may be mid-DNS-setup).
 */
export async function resolveForgeHostScope(
  raw: string,
): Promise<ForgeUrlRejection | null> {
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
