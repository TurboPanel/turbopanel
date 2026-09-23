import { MANIFEST_CACHE_MS } from "./constants.ts";
import {
  builtinChannelManifestUrl,
  type ReleaseArtifactKind,
  type UpdateChannel,
} from "../../contracts/update-channel.ts";

export { DL_BASE_URL } from "../../contracts/update-channel.ts";

export type UpdateManifestTarget = {
  commit: string;
  buildId: string;
  builtAt: string;
  channel: string;
  manifestUrl: string;
  /** The release version the manifest names (rc/release manifests carry one; trunk drops do not). */
  version?: string;
};

function requireHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
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
  kind: ReleaseArtifactKind,
): Promise<UpdateManifestTarget | null> {
  try {
    const manifestUrl = builtinChannelManifestUrl(channel, kind);
    if (manifestUrl === null || !requireHttpsUrl(manifestUrl)) return null;

    const manifestRes = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(8000),
    });
    if (!manifestRes.ok) return null;

    const manifestJson = JSON.parse(await manifestRes.text()) as {
      commit?: unknown;
      buildId?: unknown;
      builtAt?: unknown;
      channel?: unknown;
      version?: unknown;
    };

    const { commit, buildId, builtAt, channel: manifestChannel } = manifestJson;
    const version =
      typeof manifestJson.version === "string" && manifestJson.version.trim()
        ? manifestJson.version.trim()
        : undefined;
    if (
      typeof commit !== "string" || !commit ||
      typeof buildId !== "string" || !buildId ||
      typeof builtAt !== "string" || !builtAt ||
      typeof manifestChannel !== "string" || !manifestChannel
    ) {
      return null;
    }

    return {
      commit,
      buildId,
      builtAt,
      channel: manifestChannel,
      manifestUrl,
      ...(version ? { version } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Alternate source for the update target, whatever channel the instance is
 * configured to follow. The dev instance points this at the local daemon
 * checkout's overlay catalog (see src/developer/dev-update-overlay.ts) so
 * "update available" tracks local daemon changes instead of the public rail.
 * Never set in production; the provider does its own caching.
 */
export type UpdateManifestProvider = () => Promise<UpdateManifestTarget | null>;

let updateManifestProvider: UpdateManifestProvider | null = null;

export function setUpdateManifestProvider(
  provider: UpdateManifestProvider | null,
): void {
  updateManifestProvider = provider;
}

type CacheEntry = {
  manifest: UpdateManifestTarget | null;
  expiresAt: number;
};

function manifestCacheKey(
  channel: UpdateChannel,
  kind: ReleaseArtifactKind,
): string {
  return `${kind}:${channel}`;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<UpdateManifestTarget | null>>();

/** Reset manifest cache — for tests only. */
export function resetUpdateManifestCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Seed manifest cache — for tests only. */
export function seedUpdateManifestCacheForTests(
  manifest: UpdateManifestTarget | null,
  channel: UpdateChannel = "trunk",
  kind: ReleaseArtifactKind = "daemon",
): void {
  const key = manifestCacheKey(channel, kind);
  cache.set(key, { manifest, expiresAt: Date.now() + MANIFEST_CACHE_MS });
  inflight.delete(key);
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
  kind: ReleaseArtifactKind = "daemon",
): Promise<UpdateManifestTarget | null> {
  if (kind === "daemon" && updateManifestProvider) {
    return await updateManifestProvider();
  }

  const key = manifestCacheKey(channel, kind);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.manifest;
  }

  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }

  const lookup = fetchManifestUncached(channel, kind)
    .then((manifest) => {
      cache.set(key, {
        manifest,
        expiresAt: Date.now() + MANIFEST_CACHE_MS,
      });
      inflight.delete(key);
      return manifest;
    })
    .catch(() => {
      inflight.delete(key);
      cache.set(key, {
        manifest: null,
        expiresAt: Date.now() + MANIFEST_CACHE_MS,
      });
      return null;
    });
  inflight.set(key, lookup);

  return lookup;
}
