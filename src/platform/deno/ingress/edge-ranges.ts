import type { Db } from '../../../db/connection.ts'
import {
  edgeTrustForModes,
  emptyEdgeTrustHash,
  loadEdgeTrustState,
  providersForModes,
  saveEdgeTrustState,
  type EdgeRangeSet,
  type EdgeTrustState,
} from '../../../features/install/edge-trust.ts'
import { listInstanceHostnames } from '../../../features/install/instance-hostnames.ts'
import type { IngressProviderId } from '../../../features/install/ingress-modes.ts'
import { isValidCidr } from '../../../lib/ip-address.ts'

/**
 * Self-hosted only. Fetches the published edge address lists the control
 * plane's Caddy trusts for forwarded visitor addresses, keeps them in the
 * `EDGE_TRUST` setting and tells the co-located daemon when the set changes.
 */

const CLOUDFLARE_IPS_URL = 'https://api.cloudflare.com/client/v4/ips'
const BUNNY_EDGE_URL = 'https://api.bunny.net/system/edgeserverlist'
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

type FetchFn = typeof fetch

function validCidrs(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(isValidCidr)
}

/** Cloudflare's list; `'unchanged'` when the stored etag still matches. */
export async function fetchCloudflareRanges(
  fetchFn: FetchFn,
  previous: EdgeRangeSet | undefined,
  now: Date
): Promise<EdgeRangeSet | 'unchanged'> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (previous?.etag) headers['if-none-match'] = previous.etag
  const response = await fetchFn(CLOUDFLARE_IPS_URL, { headers })
  if (response.status === 304) return 'unchanged'
  if (!response.ok) throw new Error(`Cloudflare address list answered ${response.status}`)
  const body = (await response.json()) as {
    result?: { ipv4_cidrs?: unknown; ipv6_cidrs?: unknown; etag?: unknown }
  }
  const v4 = validCidrs(body.result?.ipv4_cidrs)
  const v6 = validCidrs(body.result?.ipv6_cidrs)
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
  const response = await fetchFn(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Bunny address list answered ${response.status}`)
  const body: unknown = await response.json()
  const addresses = Array.isArray(body) ? body : []
  return validCidrs(
    addresses.filter((a): a is string => typeof a === 'string').map((a) => `${a.trim()}${suffix}`)
  )
}

/** Bunny's edge server addresses, stored as host ranges. */
export async function fetchBunnyRanges(fetchFn: FetchFn, now: Date): Promise<EdgeRangeSet> {
  const [v4, v6] = await Promise.all([
    fetchBunnyList(fetchFn, BUNNY_EDGE_URL, '/32'),
    fetchBunnyList(fetchFn, `${BUNNY_EDGE_URL}/ipv6`, '/128'),
  ])
  if (v4.length === 0 && v6.length === 0) throw new Error('Bunny address list was empty')
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
