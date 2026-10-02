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
 * adds what the literal check cannot do at fetch time. What is possible
 * depends on the runtime:
 *
 * - **Deno instance** (has a resolver and raw sockets): the name is resolved
 *   once per hop, every answer must be public, and the request is then made
 *   over a connection pinned to one of those validated addresses with the
 *   host name kept for SNI, certificate check and `Host`
 *   (`lib/http/pinned-fetch.ts`). `fetch` never resolves the name, so there
 *   is no rebinding window. A name with no answers or a resolver failure
 *   refuses the request.
 * - **Workers** (no DNS API, `fetch` cannot be pinned to an address): the
 *   name is resolved once per hop over DNS-over-HTTPS (Cloudflare's 1.1.1.1
 *   JSON API, `lib/http/doh-resolve.ts`), A and AAAA, and every answer must
 *   be public — so `169.254.169.254.nip.io` is refused here rather than only
 *   by the network. A DoH failure, NXDOMAIN or a name with no address
 *   refuses the request. Residual gap (TOCTOU / DNS rebinding): `fetch` then
 *   resolves the name again itself, and a hostile zone can answer it
 *   differently from the check. Cloudflare's egress, which cannot reach
 *   private ranges, is the second layer for that window; redirects, time and
 *   size (below) bound what a hostile answer can do.
 *
 * On both runtimes:
 *
 * - Redirects are never followed blindly (`redirect: "manual"`). A redirect to
 *   the same origin is re-checked and followed (GitHub answers a renamed
 *   repository with one); a redirect anywhere else is refused, so the App's
 *   credentials never go to a host the admin did not name.
 * - The whole exchange, redirects included, is bounded by
 *   {@link FORGE_FETCH_TIMEOUT_MS}, and a response body larger than
 *   {@link FORGE_MAX_RESPONSE_BYTES} is refused (declared or streamed).
 */
import {
  type OutboundUrlRejection,
  resolveOutboundHost,
  resolveOutboundHostScope,
  validateOutboundUrl,
} from '../../lib/http/outbound-url.ts'
import { denoPinnedConnect, type PinnedConnect, pinnedFetch } from '../../lib/http/pinned-fetch.ts'

export type ForgeUrlField = 'baseUrl' | 'apiUrl' | 'webhookOrigin'

/** The forge fields' name for {@link OutboundUrlRejection}, plus the fetch-time refusals. */
export type ForgeUrlRejection =
  OutboundUrlRejection | 'cross_origin_redirect' | 'too_many_redirects' | 'response_too_large'

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
 * Deno's resolver on the Deno instance, DNS-over-HTTPS on Workers. A name
 * that does not resolve at all is left to the fetch to fail on, not refused
 * here (the admin may be mid-DNS-setup).
 */
export async function resolveForgeHostScope(raw: string): Promise<ForgeUrlRejection | null> {
  return await resolveOutboundHostScope(raw)
}

/** Same-origin redirects a single forge request may follow. */
export const FORGE_MAX_REDIRECTS = 3
/** Wall-clock budget for one `forgeFetch` call, redirects and body included. */
export const FORGE_FETCH_TIMEOUT_MS = 60_000
/** Largest response body a forge request may return. */
export const FORGE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** Seams for tests; production passes nothing. */
export type ForgeFetchDeps = {
  fetch?: typeof fetch
  /** `null` forces plain `fetch` (the Workers path); omitted = the runtime's own. */
  connect?: PinnedConnect | null
  timeoutMs?: number
  maxResponseBytes?: number
}

let connectOverride: PinnedConnect | null | undefined

/**
 * Test seam: suites that fake `globalThis.fetch` for a forge (and cannot
 * resolve its made-up host name) call this once to take the plain-`fetch`
 * path, which is the Workers path in production. Per-call `deps.connect`
 * still wins.
 */
export function useUnpinnedForgeFetchForTests(): void {
  connectOverride = null
}

function connectionFor(deps: ForgeFetchDeps): PinnedConnect | null {
  if (deps.connect !== undefined) return deps.connect
  if (connectOverride !== undefined) return connectOverride
  return denoPinnedConnect()
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 303 always becomes a GET; 301/302 do for anything but GET/HEAD. 307/308 keep both. */
function redirectDropsBody(status: number, method: string): boolean {
  if (status === 303) return true
  return (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD'
}

type HopRequest = {
  url: string
  init: RequestInit
  deps: ForgeFetchDeps
  signal: AbortSignal
}

/**
 * Judge the URL, then send it: pinned to the validated address where the
 * runtime can, plain `fetch` (checked by name only) where it cannot.
 */
async function sendHop({ url, init, deps, signal }: HopRequest): Promise<Response> {
  const literal = validateForgeUrl(url)
  if (literal) throw new ForgeUrlError('request', literal)
  const resolution = await resolveOutboundHost(url, { failClosed: true, signal })
  if (resolution.rejection) {
    throw new ForgeUrlError('request', resolution.rejection)
  }
  const connect = connectionFor(deps)
  if (connect) {
    // Pinned: with nothing validated to connect to there is nothing safe to do.
    if (resolution.addresses.length === 0) {
      throw new ForgeUrlError('request', 'dns_lookup_failed')
    }
    return await pinnedFetch(new Request(url, { ...init, signal }), {
      addresses: resolution.addresses,
      connect,
      signal,
    })
  }
  return await (deps.fetch ?? fetch)(url, { ...init, signal })
}

function capResponseBody(response: Response, max: number): Response {
  const declared = Number(response.headers.get('content-length'))
  if (declared > max) {
    void response.body?.cancel()
    throw new ForgeUrlError('request', 'response_too_large')
  }
  if (!response.body) return response
  let seen = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length
      if (seen > max) {
        controller.error(new ForgeUrlError('request', 'response_too_large'))
      } else controller.enqueue(chunk)
    },
  })
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * `fetch` for every server-side request to a forge. Re-checks the URL (literal
 * and DNS) before each request, pins the connection to the checked address
 * where the runtime allows, never lets the runtime follow a redirect, and
 * follows at most {@link FORGE_MAX_REDIRECTS} same-origin ones after checking
 * them again. Throws {@link ForgeUrlError} for a refused URL, redirect or
 * oversized body; the callers' existing `try { await fetch… } catch` maps it
 * like a network error.
 */
export async function forgeFetch(
  url: string,
  init: RequestInit = {},
  deps: ForgeFetchDeps = {}
): Promise<Response> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? FORGE_FETCH_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const max = deps.maxResponseBytes ?? FORGE_MAX_RESPONSE_BYTES
  // One hop per call; a redirect recurses into the next hop with the
  // already re-validated target, so every hop still passes the guard first.
  const followHop = async (
    hop: number,
    current: string,
    method: string,
    body: RequestInit['body']
  ): Promise<Response> => {
    const response = await sendHop({
      url: current,
      init: { ...init, method, body, redirect: 'manual' },
      deps,
      signal,
    })
    const location = response.headers.get('location')
    if (!isRedirect(response.status) || !location) {
      return capResponseBody(response, max)
    }
    await response.body?.cancel()
    if (hop >= FORGE_MAX_REDIRECTS) {
      throw new ForgeUrlError('request', 'too_many_redirects')
    }
    const next = new URL(location, current)
    if (next.origin !== new URL(current).origin) {
      throw new ForgeUrlError('request', 'cross_origin_redirect')
    }
    const dropsBody = redirectDropsBody(response.status, method)
    return followHop(
      hop + 1,
      next.toString(),
      dropsBody ? 'GET' : method,
      dropsBody ? undefined : body
    )
  }
  return followHop(0, url, (init.method ?? 'GET').toUpperCase(), init.body)
}
