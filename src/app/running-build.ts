/**
 * The running build's full label for `GET /api/health` on TurboPanel High
 * Availability.
 *
 * A hosted control plane is deployed from a branch, not installed from a
 * package, so nothing hands it `TURBOPANEL_BUILD_LABEL` and its deno.json
 * number is only the version trunk is working towards. The channel's
 * control-plane manifest names the build it published (`0.1.21-canary.3`,
 * `0.1.21-rc.1`) and the commit it was built from: when that commit is the one
 * deployed here, that label is this build's. Any other case reports no label
 * and the plain version stands: a commit newer than the newest channel build
 * (testing deploys before its canary is published), or a merge commit on a
 * promotion branch.
 *
 * Self-hosted, and any control plane outside a hosted environment, never
 * fetches: the installer's label (or none) is the answer.
 */

import { builtinChannelManifestUrl } from '../contracts/update-channel.ts'
import { resolveUpdateManifest, type UpdateManifestTarget } from '../features/update/manifest.ts'
import { type HealthPayload, healthPayload, normalizeBuildLabel } from './build-info.ts'

/** How long the health answer waits for the channel manifest before it goes without a label. */
export const RUNNING_BUILD_LOOKUP_TIMEOUT_MS = 1_500

const FULL_COMMIT = /^[0-9a-f]{40}$/i

export type InstanceManifestLookup = (
  channel: HealthPayload['channel'],
  kind: 'instance'
) => Promise<UpdateManifestTarget | null>

/** The manifest's label when it was built from `commit`, else null. */
export function buildLabelFromManifest(
  manifest: Pick<UpdateManifestTarget, 'commit' | 'version'> | null | undefined,
  commit: string
): string | null {
  const deployed = commit.trim().toLowerCase()
  if (!FULL_COMMIT.test(deployed)) return null
  if (manifest?.commit?.trim().toLowerCase() !== deployed) return null
  return normalizeBuildLabel(manifest.version)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer))
}

/**
 * {@link healthPayload} with `build` filled in from the channel manifest on a
 * hosted environment (see the module note). The manifest read is the cached
 * one the update screens use, and it is bounded by `timeoutMs` so the health
 * answer never waits on GitHub for long.
 */
export async function resolveHealthPayload(
  env: Readonly<Record<string, string | undefined>> | undefined,
  lookup: InstanceManifestLookup = resolveUpdateManifest,
  timeoutMs: number = RUNNING_BUILD_LOOKUP_TIMEOUT_MS
): Promise<HealthPayload> {
  const payload = healthPayload(env)
  if (payload.build !== null || payload.environment === null) return payload
  if (builtinChannelManifestUrl(payload.channel, 'instance') === null) return payload
  if (!FULL_COMMIT.test(payload.revision.commit)) return payload
  const manifest = await withTimeout(lookup(payload.channel, 'instance'), timeoutMs)
  const build = buildLabelFromManifest(manifest, payload.revision.commit)
  return build === null ? payload : { ...payload, build }
}
