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

export async function resolveTrunkManifest(): Promise<TrunkManifestTarget | null> {
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
