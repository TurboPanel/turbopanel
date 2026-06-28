import { TRUNK_MANIFEST_CACHE_MS } from './constants.ts'

export const DL_BASE_URL = 'https://dl.trbp.nl'

export type TrunkManifestTarget = {
  commit: string
  buildId: string
  builtAt: string
  channel: string
  manifestUrl: string
}

function requireHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

async function fetchTrunkManifestUncached(): Promise<TrunkManifestTarget | null> {
  try {
    if (!requireHttpsUrl(`${DL_BASE_URL}/channels.json`)) {
      return null
    }

    const channelsRes = await fetch(`${DL_BASE_URL}/channels.json`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!channelsRes.ok) return null

    const channelsJson = JSON.parse(await channelsRes.text()) as {
      channels?: { trunk?: { manifestUrl?: unknown } }
    }
    const manifestUrl = channelsJson.channels?.trunk?.manifestUrl
    if (typeof manifestUrl !== 'string' || !manifestUrl) return null
    if (!requireHttpsUrl(manifestUrl)) return null

    const manifestRes = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(8000),
    })
    if (!manifestRes.ok) return null

    const manifestJson = JSON.parse(await manifestRes.text()) as {
      commit?: unknown
      buildId?: unknown
      builtAt?: unknown
      channel?: unknown
    }

    const { commit, buildId, builtAt, channel } = manifestJson
    if (
      typeof commit !== 'string' || !commit ||
      typeof buildId !== 'string' || !buildId ||
      typeof builtAt !== 'string' || !builtAt ||
      typeof channel !== 'string' || !channel
    ) {
      return null
    }

    return { commit, buildId, builtAt, channel, manifestUrl }
  } catch {
    return null
  }
}

let cachedManifest: TrunkManifestTarget | null | undefined
let cacheExpiresAt = 0
let inflightManifest: Promise<TrunkManifestTarget | null> | null = null

/** Reset manifest cache — for tests only. */
export function resetTrunkManifestCacheForTests(): void {
  cachedManifest = undefined
  cacheExpiresAt = 0
  inflightManifest = null
}

export async function resolveTrunkManifest(): Promise<TrunkManifestTarget | null> {
  const now = Date.now()
  if (cachedManifest !== undefined && now < cacheExpiresAt) {
    return cachedManifest
  }

  if (inflightManifest) {
    return inflightManifest
  }

  inflightManifest = fetchTrunkManifestUncached()
    .then((manifest) => {
      cachedManifest = manifest
      cacheExpiresAt = Date.now() + TRUNK_MANIFEST_CACHE_MS
      inflightManifest = null
      return manifest
    })
    .catch(() => {
      inflightManifest = null
      cachedManifest = null
      cacheExpiresAt = Date.now() + TRUNK_MANIFEST_CACHE_MS
      return null
    })

  return inflightManifest
}
