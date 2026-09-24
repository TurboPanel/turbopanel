/**
 * Which update channel this instance follows, and where each channel's
 * daemon manifest lives — the control plane's mirror of the daemon's
 * `src/update/config.ts` + `src/update/urls.ts` (turbopaneld). The instance
 * resolves daemon updates for the servers it manages (`POST /servers/:id/update`
 * and the fleet-wide updates view), so it has to read the channel those
 * servers should follow, not a literal `trunk`.
 *
 * Workers and Deno both import this module — no Deno-only APIs at the top
 * level; the env record comes from the caller (`c.get('platformEnv')`).
 */

/** Same vocabulary as turbopaneld's `UpdateChannel`. */
export const UPDATE_CHANNELS = [
  "trunk",
  "edge",
  "canary",
  "rc",
  "release",
] as const;

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "trunk";

/** The repository whose GitHub Releases carry the daemon's canary/rc/release packages. */
export const DAEMON_GITHUB_RELEASES_REPO = "TurboPanel/turbopaneld";

/** Control-plane packages (compiled instance). GitHub Releases only — no CDN drop. */
export const INSTANCE_GITHUB_RELEASES_REPO = "TurboPanel/turbopanel";

/** Web export packages. GitHub Releases only — no CDN drop. */
export const UI_GITHUB_RELEASES_REPO = "TurboPanel/ui";

export const RELEASE_ARTIFACT_KINDS = ["daemon", "instance", "ui"] as const;

export type ReleaseArtifactKind = (typeof RELEASE_ARTIFACT_KINDS)[number];

export function githubReleasesRepo(
  kind: ReleaseArtifactKind = "daemon",
): string {
  switch (kind) {
    case "instance":
      return INSTANCE_GITHUB_RELEASES_REPO;
    case "ui":
      return UI_GITHUB_RELEASES_REPO;
    case "daemon":
      return DAEMON_GITHUB_RELEASES_REPO;
  }
}

/** The per-merge CDN drop — kept as the trunk rail and as the manual override catalog. */
export const DL_BASE_URL = "https://dl.trbp.nl";

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === "string" &&
    (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/**
 * `TURBOPANEL_UPDATE_CHANNEL` from the platform env, defaulting to `trunk`.
 * Mirrors the daemon's `resolveUpdateChannelConfig`; like the daemon, an
 * invalid value is a startup error (see `assertValidUpdateChannelEnv`) rather
 * than a silent fallback, so a typo can't quietly keep a fleet on trunk.
 */
export function resolveInstanceUpdateChannel(
  env: Readonly<Record<string, string | undefined>> | undefined,
): UpdateChannel {
  const raw = env?.TURBOPANEL_UPDATE_CHANNEL?.trim();
  if (!raw) return DEFAULT_UPDATE_CHANNEL;
  return isUpdateChannel(raw) ? raw : DEFAULT_UPDATE_CHANNEL;
}

/** Throws the daemon's own wording when the env names a channel that doesn't exist. */
export function assertValidUpdateChannelEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): void {
  const raw = env?.TURBOPANEL_UPDATE_CHANNEL?.trim();
  if (!raw || isUpdateChannel(raw)) return;
  throw new Error(
    `Invalid TURBOPANEL_UPDATE_CHANNEL: "${raw}". Valid values: ${
      UPDATE_CHANNELS.join(", ")
    }`,
  );
}

/**
 * Where each advertised channel's manifest lives — the built-in rail, byte
 * for byte the daemon's `builtinChannelManifestUrl` (turbopaneld
 * src/update/urls.ts) and run.sh's `tp_builtin_channel_manifest_url`.
 *
 * `trunk` is the per-merge CDN drop. `canary`, `rc` and `release` are GitHub
 * Releases: `release` follows the platform's own `releases/latest` pointer
 * (skips pre-releases, so promotion is `gh release edit --prerelease=false`),
 * `rc` a rolling pre-release tagged `rc` that points at a versioned
 * pre-release, `canary` a rolling pre-release tagged `canary` carrying the
 * newest green trunk build's own bytes, replaced on every merge. `edge` is
 * reserved and unadvertised: no built-in location, so the target is unknown.
 *
 * `kind` selects the package. Daemon `trunk` stays the CDN drop. Instance
 * and UI have no CDN drop, so their `trunk` is `null`. The default kind is
 * `daemon` so existing call sites stay on the daemon rail.
 */
export function builtinChannelManifestUrl(
  channel: UpdateChannel,
  kind: ReleaseArtifactKind = "daemon",
): string | null {
  const repo = githubReleasesRepo(kind);
  switch (channel) {
    case "trunk":
      return trunkManifestUrl(kind);
    case "canary":
      return `https://github.com/${repo}/releases/download/canary/manifest.json`;
    case "rc":
      return `https://github.com/${repo}/releases/download/rc/manifest.json`;
    case "release":
      return `https://github.com/${repo}/releases/latest/download/manifest.json`;
    default:
      return null;
  }
}

function trunkManifestUrl(kind: ReleaseArtifactKind): string | null {
  if (kind !== "daemon") return null;
  return `${DL_BASE_URL}/channels/trunk/manifest.json`;
}

/**
 * A version token safe to place in one GitHub release path segment.
 * The tag is `v<version>`, so the token itself starts with a digit.
 */
const PINNED_VERSION_RE = /^[0-9][0-9A-Za-z._+-]*$/;

/**
 * Manifest URL for one published build, beside {@link builtinChannelManifestUrl}.
 *
 * `canary` keeps `manifest-<version>.json` on the rolling `canary` release
 * (gh-canary.yml). `rc` and `release` use the tag `v<version>` and
 * `manifest.json` (gh-release.yml). `trunk` and `edge` have no pin.
 */
export function pinnedChannelManifestUrl(
  kind: ReleaseArtifactKind,
  channel: UpdateChannel,
  version: string,
): string | null {
  if (!PINNED_VERSION_RE.test(version)) return null;
  const repo = githubReleasesRepo(kind);
  switch (channel) {
    case "canary":
      return `https://github.com/${repo}/releases/download/canary/manifest-${version}.json`;
    case "rc":
    case "release":
      return `https://github.com/${repo}/releases/download/v${version}/manifest.json`;
    default:
      return null;
  }
}
