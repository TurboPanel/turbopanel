/**
 * Edge address ranges the control plane's own Caddy believes forwarded
 * visitor addresses from. Pure helpers plus the `EDGE_TRUST` setting; the
 * network fetches live in `src/platform/deno/ingress/edge-ranges.ts`.
 *
 * Workers-safe: no I/O at module load, no Deno-only specifiers. High
 * Availability never sends the result anywhere (the apply route answers 422
 * there), so the ranges are inert on that runtime.
 */

import type { Db } from '../../db/connection.ts'
import { isValidCidr } from '../../lib/ip-address.ts'
import { loadSettingValues, upsertSettingValue } from '../settings/resolver.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import type { InstanceEdgeTrustWire } from '../../contracts/cell-protocol.ts'
import type { IngressMode, IngressProviderId } from './ingress-modes.ts'

export const EDGE_TRUST_SETTING_KEY = 'EDGE_TRUST'

/** Wire feature a daemon advertises once its Caddyfile template reads the ranges. */
export const EDGE_TRUST_FEATURE = 'instance-edge-trust-v1'

/** Modes whose visitors arrive from a published edge range, and whose list they use. */
const MODE_PROVIDER: Partial<Record<IngressMode, IngressProviderId>> = {
  'cloudflare-proxy': 'cloudflare',
  'bunny-proxy': 'bunny',
}

export type EdgeRangeSet = {
  /** IPv4 CIDRs. */
  v4: string[]
  /** IPv6 CIDRs. */
  v6: string[]
  etag?: string
  fetchedAt: string
}

export type EdgeTrustError = { provider: IngressProviderId; message: string; at: string }

export type EdgeTrustState = {
  cloudflare?: EdgeRangeSet
  bunny?: EdgeRangeSet
  appliedHash?: string
  appliedAt?: string
  lastError?: EdgeTrustError
  lastCheckedAt?: string
}

/** Providers whose lists the enabled modes need, in a stable order. */
export function providersForModes(modes: Iterable<string>): IngressProviderId[] {
  const wanted = new Set<IngressProviderId>()
  for (const mode of modes) {
    const provider = MODE_PROVIDER[mode as IngressMode]
    if (provider) wanted.add(provider)
  }
  return (['cloudflare', 'bunny'] as const).filter((provider) => wanted.has(provider))
}

const byText = (a: string, b: string): number => a.localeCompare(b)

function rangeList(set: EdgeRangeSet | undefined): string[] {
  if (!set) return []
  return [...new Set([...set.v4, ...set.v6].filter(isValidCidr))].sort(byText)
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The wire body for the enabled modes: per-provider lists, their union and a hash of both. */
export async function edgeTrustForModes(
  state: EdgeTrustState,
  modes: Iterable<string>
): Promise<InstanceEdgeTrustWire> {
  const providers = providersForModes(modes)
  const cloudflare = providers.includes('cloudflare') ? rangeList(state.cloudflare) : []
  const bunny = providers.includes('bunny') ? rangeList(state.bunny) : []
  const cidrs = [...new Set([...cloudflare, ...bunny])].sort(byText)
  const hash = await sha256Hex(JSON.stringify([cloudflare, bunny]))
  return { cidrs, hash, cloudflare, bunny }
}

function isRangeSet(value: unknown): value is EdgeRangeSet {
  if (!value || typeof value !== 'object') return false
  const set = value as Partial<EdgeRangeSet>
  return Array.isArray(set.v4) && Array.isArray(set.v6) && typeof set.fetchedAt === 'string'
}

export async function loadEdgeTrustState(db: Db): Promise<EdgeTrustState> {
  const stored = (await loadSettingValues(db, [EDGE_TRUST_SETTING_KEY])).get(EDGE_TRUST_SETTING_KEY)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const raw = stored as Record<string, unknown>
  const state: EdgeTrustState = {}
  if (isRangeSet(raw.cloudflare)) state.cloudflare = raw.cloudflare
  if (isRangeSet(raw.bunny)) state.bunny = raw.bunny
  if (typeof raw.appliedHash === 'string') state.appliedHash = raw.appliedHash
  if (typeof raw.appliedAt === 'string') state.appliedAt = raw.appliedAt
  if (typeof raw.lastCheckedAt === 'string') state.lastCheckedAt = raw.lastCheckedAt
  if (raw.lastError && typeof raw.lastError === 'object') {
    state.lastError = raw.lastError as EdgeTrustError
  }
  return state
}

export async function saveEdgeTrustState(db: Db, state: EdgeTrustState): Promise<void> {
  await upsertSettingValue(
    db,
    EDGE_TRUST_SETTING_KEY,
    structuredClone(state) as Record<string, never>
  )
}

/** Hash of "no edge modes", the baseline before anything was ever applied. */
export async function emptyEdgeTrustHash(): Promise<string> {
  return (await edgeTrustForModes({}, [])).hash
}

/** Remember which set the daemon last rendered, so an unchanged set is never sent twice. */
export async function markEdgeTrustApplied(db: Db, hash: string, now: Date): Promise<void> {
  const state = await loadEdgeTrustState(db)
  await saveEdgeTrustState(db, { ...state, appliedHash: hash, appliedAt: now.toISOString() })
}

/**
 * The body to put on `public-urls-update`, or null when the co-located daemon
 * does not advertise the feature (an older daemon never sees the field).
 */
export async function resolveEdgeTrustForServer(
  db: Db,
  serverId: string,
  modes: Iterable<string>
): Promise<InstanceEdgeTrustWire | null> {
  const daemon = await getServerDaemonStateByServerId(db, serverId)
  if (!daemon?.projection?.features?.includes(EDGE_TRUST_FEATURE)) return null
  return edgeTrustForModes(await loadEdgeTrustState(db), modes)
}
