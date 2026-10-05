import { MANIFEST_CACHE_MS } from './constants.ts'
import {
  ManifestRefusedError,
  RELEASE_SIGNING_PUBLIC_KEY_HEX,
  verifyManifestSignature,
  type ManifestRefusalCode,
} from './signing.ts'
import { compareSemver, parseSemver } from '../../lib/version-wire.ts'
import { logWarn } from '../../lib/logger.ts'
import {
  builtinChannelManifestUrl,
  DEFAULT_UPDATE_CHANNEL,
  type ReleaseArtifactKind,
  type UpdateChannel,
} from '../../contracts/update-channel.ts'

export { DL_BASE_URL } from '../../contracts/update-channel.ts'

export type UpdateManifestTarget = {
  commit: string
  buildId: string
  builtAt: string
  channel: string
  manifestUrl: string
  /** The release version the manifest names (rc/release manifests carry one; trunk drops do not). */
  version?: string
}

function requireHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** A manifest the control plane refused, with a stable code (see {@link ManifestRefusalCode}). */
export type UpdateManifestRefusal = {
  code: ManifestRefusalCode
  message: string
  at: string
}

let trustKeyHex = RELEASE_SIGNING_PUBLIC_KEY_HEX
const refusals = new Map<string, UpdateManifestRefusal>()
const accepted = new Map<string, UpdateManifestTarget>()

function manifestCacheKey(channel: UpdateChannel, kind: ReleaseArtifactKind): string {
  return `${kind}:${channel}`
}

/** The last refusal for one channel and kind, or null when its manifest was accepted. */
export function getUpdateManifestRefusal(
  channel: UpdateChannel,
  kind: ReleaseArtifactKind = 'daemon'
): UpdateManifestRefusal | null {
  return refusals.get(manifestCacheKey(channel, kind)) ?? null
}

function recordRefusal(channel: UpdateChannel, kind: ReleaseArtifactKind, error: unknown): void {
  const key = manifestCacheKey(channel, kind)
  if (!(error instanceof ManifestRefusedError)) return
  refusals.set(key, { code: error.code, message: error.message, at: new Date().toISOString() })
  logWarn('update-manifest', `refused ${key} manifest: ${error.code}: ${error.message}`)
}

/**
 * Same rule as the daemon's `isRollback` and `isDowngrade`: base versions
 * order builds across releases (the pre-release label is ignored), the same
 * base falls back to build time, and no evidence is never a refusal.
 */
function isOlderBuild(previous: UpdateManifestTarget, next: UpdateManifestTarget): boolean {
  if (previous.commit === next.commit) return false
  const have = parseSemver(previous.version)
  const want = parseSemver(next.version)
  if (have && want) {
    const base = compareSemver({ ...want, prerelease: [] }, { ...have, prerelease: [] })
    if (base !== 0) return base < 0
  }
  const previousAt = Date.parse(previous.builtAt)
  const nextAt = Date.parse(next.builtAt)
  return Number.isFinite(previousAt) && Number.isFinite(nextAt) && nextAt < previousAt
}

/**
 * A signature proves who made a manifest, not when. Refuse a validly signed
 * manifest that is older than one this process already accepted for the same
 * channel (a replayed stale release asset); the daemon refuses it again at
 * install time. In memory only: a restart forgets the high-water mark.
 */
function assertNotReplayed(key: string, target: UpdateManifestTarget): void {
  const previous = accepted.get(key)
  if (previous && isOlderBuild(previous, target)) {
    throw new ManifestRefusedError(
      'manifest_replayed',
      `signed manifest (${target.version ?? target.commit}, built ${target.builtAt}) is older than the one already accepted (${previous.version ?? previous.commit}, built ${previous.builtAt})`
    )
  }
  accepted.set(key, target)
  refusals.delete(key)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** The identity fields every channel manifest must carry; null when any is missing. */
function readTarget(
  manifestJson: Record<string, unknown>,
  manifestUrl: string
): UpdateManifestTarget | null {
  const commit = nonEmptyString(manifestJson.commit)
  const buildId = nonEmptyString(manifestJson.buildId)
  const builtAt = nonEmptyString(manifestJson.builtAt)
  const channel = nonEmptyString(manifestJson.channel)
  if (!commit || !buildId || !builtAt || !channel) return null
  const version = typeof manifestJson.version === 'string' ? manifestJson.version.trim() : ''
  return { commit, buildId, builtAt, channel, manifestUrl, ...(version ? { version } : {}) }
}

const MANIFEST_FETCH_TIMEOUT_MS = 8000
/** No new attempt starts once the lookups have taken this long (the routes wait on them). */
const MANIFEST_RETRY_BUDGET_MS = 10_000
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504])
const DEFAULT_RETRY_DELAYS_MS = [400, 1200]
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS

/** Wait between manifest attempts — for tests only (`[]` disables retries). */
export function setUpdateManifestRetryDelaysForTests(delays: number[]): void {
  retryDelaysMs = delays
}

/**
 * Fetch a manifest, retrying a transient failure: a request that throws (a
 * resolver blip, a refused or reset connection, a timeout) or an answer of
 * 429/502/503/504. Any other answer is returned as-is, and when the attempts
 * run out the last answer or error is handed back. Only the transport is
 * retried; the signature is checked on whatever comes back.
 */
async function fetchManifestResponse(url: string): Promise<Response> {
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt++) {
    const delay = retryDelaysMs[attempt]
    const canRetry = delay !== undefined && Date.now() - startedAt < MANIFEST_RETRY_BUDGET_MS
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) })
      if (!canRetry || !TRANSIENT_STATUSES.has(response.status)) return response
      await response.body?.cancel()
    } catch (error) {
      if (!canRetry) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

/**
 * One fetch, straight to the channel's built-in manifest location — no
 * catalog hop. `rc` / `release` resolve through GitHub's own redirects, which
 * is why the compile allow-net lists the release-asset hosts alongside
 * github.com. A reserved channel with no location resolves to null, the same
 * "target unknown" the routes already render for an unreachable manifest.
 */
async function fetchManifestUncached(
  channel: UpdateChannel,
  kind: ReleaseArtifactKind
): Promise<UpdateManifestTarget | null> {
  try {
    const manifestUrl = builtinChannelManifestUrl(channel, kind)
    if (manifestUrl === null || !requireHttpsUrl(manifestUrl)) return null

    const manifestRes = await fetchManifestResponse(manifestUrl)
    if (!manifestRes.ok) return null

    const manifestJson = JSON.parse(await manifestRes.text()) as Record<string, unknown>
    // Verify before any field is used (audit M6): an unsigned, foreign-signed
    // or tampered manifest is "target unknown", never a target.
    await verifyManifestSignature(manifestJson, trustKeyHex)

    const target = readTarget(manifestJson, manifestUrl)
    if (!target) return null
    assertNotReplayed(manifestCacheKey(channel, kind), target)
    return target
  } catch (error) {
    recordRefusal(channel, kind, error)
    return null
  }
}

/**
 * Alternate source for the update target, whatever channel the instance is
 * configured to follow. The dev instance points this at the local daemon
 * checkout's overlay catalog (see src/developer/dev-update-overlay.ts) so
 * "update available" tracks local daemon changes instead of the public rail.
 * Never set in production; the provider does its own caching. It skips signature
 * verification on purpose: it is the explicit dev opt-in (registered only by
 * `deno-dev.ts`), the control-plane twin of the daemon's dev unsigned bypass.
 */
export type UpdateManifestProvider = () => Promise<UpdateManifestTarget | null>

let updateManifestProvider: UpdateManifestProvider | null = null

export function setUpdateManifestProvider(provider: UpdateManifestProvider | null): void {
  updateManifestProvider = provider
}

type CacheEntry = {
  manifest: UpdateManifestTarget | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<UpdateManifestTarget | null>>()

/** Reset manifest cache — for tests only. */
export function resetUpdateManifestCacheForTests(): void {
  cache.clear()
  inflight.clear()
  refusals.clear()
  accepted.clear()
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS
  trustKeyHex = RELEASE_SIGNING_PUBLIC_KEY_HEX
}

/** Trust a test key instead of the pinned release key — for tests only. */
export function setUpdateManifestTrustKeyForTests(publicKeyHex: string): void {
  trustKeyHex = publicKeyHex
}

/** Seed manifest cache — for tests only. */
export function seedUpdateManifestCacheForTests(
  manifest: UpdateManifestTarget | null,
  channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL,
  kind: ReleaseArtifactKind = 'daemon'
): void {
  const key = manifestCacheKey(channel, kind)
  cache.set(key, { manifest, expiresAt: Date.now() + MANIFEST_CACHE_MS })
  inflight.delete(key)
}

/**
 * Resolve one channel's manifest.
 *
 * The dev overlay provider applies only to the daemon kind, so a local
 * daemon checkout still drives the fleet-update view. Instance and UI
 * always read their own rail.
 */
export async function resolveUpdateManifest(
  channel: UpdateChannel,
  kind: ReleaseArtifactKind = 'daemon'
): Promise<UpdateManifestTarget | null> {
  if (kind === 'daemon' && updateManifestProvider) {
    return await updateManifestProvider()
  }

  const key = manifestCacheKey(channel, kind)
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && now < cached.expiresAt) {
    return cached.manifest
  }

  const pending = inflight.get(key)
  if (pending) {
    return pending
  }

  const lookup = fetchManifestUncached(channel, kind)
    .then((manifest) => {
      cache.set(key, {
        manifest,
        expiresAt: Date.now() + MANIFEST_CACHE_MS,
      })
      inflight.delete(key)
      return manifest
    })
    .catch(() => {
      inflight.delete(key)
      cache.set(key, {
        manifest: null,
        expiresAt: Date.now() + MANIFEST_CACHE_MS,
      })
      return null
    })
  inflight.set(key, lookup)

  return lookup
}
