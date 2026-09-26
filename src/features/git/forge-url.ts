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
 * The rule itself now lives in `http/outbound-url.ts`, because it is not
 * forge-specific: every operator-supplied URL this instance fetches gets the
 * same treatment. What stays here is the forge vocabulary — which field was
 * refused, and the error type the forge routes catch.
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
 * Every server-side request to a forge goes through {@link forgeFetch}, which
 * adds what the literal check cannot do at fetch time:
 *
 * - DNS is resolved again before each request, where a resolver exists (the
 *   Deno instance — Workers has none, and Cloudflare's egress cannot reach
 *   private ranges anyway), and a private answer or a resolver failure other
 *   than "no such name" refuses it. A rebind between that lookup and the
 *   connection itself is not caught; the compiled instance runs with
 *   unrestricted `--allow-net` since 2026-09-18, so nothing inside the
 *   process is a second wall.
 * - Redirects are never followed blindly (`redirect: "manual"`). A redirect to
 *   the same origin is re-checked and followed (GitHub answers a renamed
 *   repository with one); a redirect anywhere else is refused, so the App's
 *   credentials never go to a host the admin did not name.
 */
import {
  type OutboundUrlRejection,
  resolveOutboundHostScope,
  validateOutboundUrl,
} from '../../lib/http/outbound-url.ts'

export type ForgeUrlField = 'baseUrl' | 'apiUrl' | 'webhookOrigin'

/** The forge fields' name for {@link OutboundUrlRejection}, plus the fetch-time refusals. */
export type ForgeUrlRejection =
  | OutboundUrlRejection
  | 'cross_origin_redirect'
  | 'too_many_redirects'

export class ForgeUrlError extends Error {
  /** The stored field refused, or `request` for a URL built from one at fetch time. */
  readonly field: ForgeUrlField | 'request'
  readonly reason: ForgeUrlRejection
  constructor(field: ForgeUrlField | 'request', reason: ForgeUrlRejection) {
    super(`forge ${field} rejected: ${reason}`)
    this.name = 'ForgeUrlError'
    this.field = field
    this.reason = reason
  }
}

/**
 * Validate one forge URL field. Returns the reason it is refused, or `null`
 * when the URL is one this instance will dial.
 */
export function validateForgeUrl(raw: string): ForgeUrlRejection | null {
  return validateOutboundUrl(raw)
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
  return await resolveOutboundHostScope(raw)
}

/** Same-origin redirects a single forge request may follow. */
export const FORGE_MAX_REDIRECTS = 3

async function assertForgeRequestAllowed(url: string): Promise<void> {
  const literal = validateForgeUrl(url)
  if (literal) throw new ForgeUrlError('request', literal)
  const resolved = await resolveOutboundHostScope(url, { failClosed: true })
  if (resolved) throw new ForgeUrlError('request', resolved)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 303 always becomes a GET; 301/302 do for anything but GET/HEAD. 307/308 keep both. */
function redirectDropsBody(status: number, method: string): boolean {
  if (status === 303) return true
  return (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD'
}

/**
 * `fetch` for every server-side request to a forge. Re-checks the URL (literal
 * and DNS) before each request, never lets the runtime follow a redirect, and
 * follows at most {@link FORGE_MAX_REDIRECTS} same-origin ones after checking
 * them again. Throws {@link ForgeUrlError} for a refused URL or redirect; the
 * callers' existing `try { await fetch… } catch` maps it like a network error.
 */
export async function forgeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  for (let hop = 0; ; hop += 1) {
    await assertForgeRequestAllowed(current)
    const response = await fetch(current, { ...init, method, body, redirect: 'manual' })
    const location = response.headers.get('location')
    if (!isRedirect(response.status) || !location) return response
    await response.body?.cancel()
    if (hop >= FORGE_MAX_REDIRECTS) throw new ForgeUrlError('request', 'too_many_redirects')
    const next = new URL(location, current)
    if (next.origin !== new URL(current).origin) {
      throw new ForgeUrlError('request', 'cross_origin_redirect')
    }
    if (redirectDropsBody(response.status, method)) {
      method = 'GET'
      body = undefined
    }
    current = next.toString()
  }
}
