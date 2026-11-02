import type { Db } from '../../../db/connection.ts'
import {
  edgeTrustForModes,
  isSafeEdgeRange,
  MAX_EDGE_RANGES,
  emptyEdgeTrustHash,
  loadEdgeTrustState,
  providersForModes,
  saveEdgeTrustState,
  type EdgeRangeSet,
  type EdgeTrustState,
} from '../../../features/install/edge-trust.ts'
import { listInstanceHostnames } from '../../../features/install/instance-hostnames.ts'
import type { IngressProviderId } from '../../../features/install/ingress-modes.ts'

/**
 * Self-hosted only. Fetches the published edge address lists the control
 * plane's Caddy trusts for forwarded visitor addresses, keeps them in the
 * `EDGE_TRUST` setting and tells the co-located daemon when the set changes.
 */

const CLOUDFLARE_IPS_URL = 'https://api.cloudflare.com/client/v4/ips'
const BUNNY_EDGE_URL = 'https://api.bunny.net/system/edgeserverlist'
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

type FetchFn = typeof fetch

const FETCH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Every entry must be a safe edge range; one bad entry refuses the whole
 * answer (the caller keeps the last good list) instead of dropping it.
 */
function safeCidrs(values: unknown, label: string): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new Error(`${label} address list was malformed`)
  const out = values.map((v) => (typeof v === 'string' ? v.trim() : ''))
  const bad = out.find((v) => !isSafeEdgeRange(v))
  if (bad !== undefined) throw new Error(`${label} address list had an unusable range`)
  return out
}

/** Read a JSON body without trusting its length: stop at the byte ceiling. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw new Error('address list was too large')
  if (!response.body) throw new Error('address list had no body')
  const chunks: Uint8Array[] = []
  let total = 0
  // Leaving the loop by throwing cancels the stream.
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('address list was too large')
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** One bounded GET: timeout, no redirects, capped body. */
function boundedGet(fetchFn: FetchFn, url: string, headers: Record<string, string>) {
  return fetchFn(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** Cloudflare's list; `'unchanged'` when the stored etag still matches. */
export async function fetchCloudflareRanges(
  fetchFn: FetchFn,
  previous: EdgeRangeSet | undefined,
  now: Date
): Promise<EdgeRangeSet | 'unchanged'> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (previous?.etag) headers['if-none-match'] = previous.etag
  const response = await boundedGet(fetchFn, CLOUDFLARE_IPS_URL, headers)
  if (response.status === 304) return 'unchanged'
  if (!response.ok) throw new Error(`Cloudflare address list answered ${response.status}`)
  const body = (await readBoundedJson(response)) as {
    result?: { ipv4_cidrs?: unknown; ipv6_cidrs?: unknown; etag?: unknown }
  }
  const v4 = safeCidrs(body.result?.ipv4_cidrs, 'Cloudflare')
  const v6 = safeCidrs(body.result?.ipv6_cidrs, 'Cloudflare')
  if (v4.length + v6.length > MAX_EDGE_RANGES)
    throw new Error('Cloudflare address list was too long')
  if (v4.length === 0 && v6.length === 0) throw new Error('Cloudflare address list was empty')
  const etag = body.result?.etag
  return {
    v4,
    v6,
    fetchedAt: now.toISOString(),
    ...(typeof etag === 'string' ? { etag } : {}),
  }
}

async function fetchBunnyList(fetchFn: FetchFn, url: string, suffix: string): Promise<string[]> {
  const response = await boundedGet(fetchFn, url, { accept: 'application/json' })
  if (!response.ok) throw new Error(`Bunny address list answered ${response.status}`)
  const body = await readBoundedJson(response)
  if (!Array.isArray(body)) throw new Error('Bunny address list was malformed')
  return safeCidrs(
    body.map((a) => (typeof a === 'string' ? `${a.trim()}${suffix}` : '')),
    'Bunny'
  )
}

/** Bunny's edge server addresses, stored as host ranges. */
export async function fetchBunnyRanges(fetchFn: FetchFn, now: Date): Promise<EdgeRangeSet> {
  const [v4, v6] = await Promise.all([
    fetchBunnyList(fetchFn, BUNNY_EDGE_URL, '/32'),
    fetchBunnyList(fetchFn, `${BUNNY_EDGE_URL}/ipv6`, '/128'),
  ])
  if (v4.length === 0 && v6.length === 0) throw new Error('Bunny address list was empty')
  if (v4.length + v6.length > MAX_EDGE_RANGES) throw new Error('Bunny address list was too long')
  return { v4, v6, fetchedAt: now.toISOString() }
}

async function fetchProvider(
  provider: IngressProviderId,
  state: EdgeTrustState,
  fetchFn: FetchFn,
  now: Date
): Promise<EdgeRangeSet | 'unchanged'> {
  return provider === 'cloudflare'
    ? fetchCloudflareRanges(fetchFn, state.cloudflare, now)
    : fetchBunnyRanges(fetchFn, now)
}

export type EdgeRefreshDeps = { fetch?: FetchFn; now?: () => Date }

/**
 * Fetch the lists the enabled modes need into a copy of `state`. A failed
 * fetch keeps the previous list and is recorded; the set never shrinks
 * because of an error.
 */
export async function refreshedEdgeState(
  state: EdgeTrustState,
  modes: readonly string[],
  fetchFn: FetchFn,
  now: Date
): Promise<EdgeTrustState> {
  const next: EdgeTrustState = { ...state, lastCheckedAt: now.toISOString() }
  delete next.lastError
  const results = await Promise.all(
    providersForModes(modes).map(async (provider) => {
      try {
        return { provider, set: await fetchProvider(provider, next, fetchFn, now) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { provider, error: { provider, message, at: now.toISOString() } }
      }
    })
  )
  for (const result of results) {
    if ('error' in result) next.lastError = result.error
    else if (result.set !== 'unchanged') next[result.provider] = result.set
    else if (next[result.provider]) {
      next[result.provider] = { ...next[result.provider]!, fetchedAt: now.toISOString() }
    }
  }
  return next
}

export async function refreshEdgeRanges(db: Db, deps: EdgeRefreshDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  const modes = (await listInstanceHostnames(db)).map((row) => row.mode)
  const state = await loadEdgeTrustState(db)
  await saveEdgeTrustState(db, await refreshedEdgeState(state, modes, deps.fetch ?? fetch, now))
}

/** Whether the daily refresh is due, or a needed provider has no list yet. */
export function edgeRefreshDue(
  state: EdgeTrustState,
  modes: readonly string[],
  now: Date,
  force = false
): boolean {
  const last = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0
  const missing = providersForModes(modes).some((provider) => !state[provider])
  return force || missing || now.getTime() - last >= REFRESH_INTERVAL_MS
}

/**
 * The scheduled pass: refresh at most once a day, then send the daemon the
 * set only when it differs from the one it last rendered.
 */
export async function runEdgeTrustTick(
  db: Db,
  apply: () => Promise<void>,
  deps: EdgeRefreshDeps & { force?: boolean } = {}
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  const state = await loadEdgeTrustState(db)
  const modes = (await listInstanceHostnames(db)).map((row) => row.mode)
  if (edgeRefreshDue(state, modes, now, deps.force)) await refreshEdgeRanges(db, deps)
  const fresh = await loadEdgeTrustState(db)
  const wanted = (await edgeTrustForModes(fresh, modes)).hash
  const applied = fresh.appliedHash ?? (await emptyEdgeTrustHash())
  if (wanted !== applied) await apply()
}

/** The read model the admin route returns: counts and times, never the lists. */
export function describeEdgeTrust(state: EdgeTrustState, modes: readonly string[]) {
  const describe = (set: EdgeRangeSet | undefined) =>
    set ? { count: set.v4.length + set.v6.length, etag: set.etag, fetchedAt: set.fetchedAt } : null
  return {
    ok: true,
    enabledProviders: providersForModes(modes),
    cloudflare: describe(state.cloudflare),
    bunny: describe(state.bunny),
    appliedHash: state.appliedHash ?? null,
    appliedAt: state.appliedAt ?? null,
    lastError: state.lastError ?? null,
  }
}
