/**
 * Defensive read-only parser for `project.options` jsonb fields used by
 * container naming and optional default server placement. Does not model or
 * round-trip `options.compose`.
 */

import { isPlacementServerId } from './compose/placement.ts'

export type ContainerNamingMode = 'uuid' | 'custom'

export type ProjectOptions = {
  containerNaming?: ContainerNamingMode
  /**
   * Optional default placement server. Environments without their own
   * `server_id` inherit this at deploy / lifecycle / stop time.
   */
  defaultServerId?: string
  /**
   * Where this project's compose came from, and where it can be re-read.
   *
   * **Seed, not tracking.** The repository's `docker-compose.yml` is read once
   * and becomes the project compose, which the operator then owns. Tracking it
   * live would either drop the `x-turbopanel` block TurboPanel writes (which
   * the repository cannot know about) or need an invisible side-car patch — a
   * second source of truth, strictly worse than letting the operator own the
   * merged document. A repo's compose is also authored for a laptop:
   * `ports: "5432:5432"`, bind mounts, `container_name`.
   *
   * `seededDigest` hashes the **repository bytes as seeded**, not the current
   * project compose, so drift means "the repo moved", never "the operator
   * edited". `mode` is the seam for adding live tracking later; absent means
   * `'seed'`.
   *
   * Nothing reads this at build time — a service's own
   * `x-turbopanel.source` is what decides which repo a *build* clones. Keep the
   * two distinct.
   */
  composeSource?: ProjectComposeSource
}

export type ProjectComposeSource = {
  /** `source.id`, resolved against the org's sources at the write boundary. */
  sourceId: string
  /** Absent means the source's own `defaultBranch`. */
  ref?: string
  path: string
  seededCommitSha: string
  /** SHA-256 of the repository bytes as seeded. */
  seededDigest: string
  mode?: 'seed' | 'track'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContainerNamingMode(value: unknown): value is ContainerNamingMode {
  return value === 'uuid' || value === 'custom'
}

/**
 * Parse a containerNaming value from JSON. Returns `{ ok: true, value }` for
 * a valid mode, or `{ ok: false }` for invalid input.
 */
export function parseContainerNamingInput(
  value: unknown,
): { ok: true; value: ContainerNamingMode } | { ok: false } {
  if (!isContainerNamingMode(value)) return { ok: false }
  return { ok: true, value }
}

/**
 * Parse a defaultServerId PATCH/options value.
 * `null` → clear (`{ ok: true, value: null }`). Valid UUID → keep.
 * Invalid → `{ ok: false }`.
 */
export function parseDefaultServerIdInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isPlacementServerId(value)) {
    return { ok: false }
  }
  return { ok: true, value }
}

const SAFE_COMPOSE_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/

/**
 * Parse a `composeSource` block. Returns `{ ok: false }` for anything
 * malformed so a write boundary can reject rather than silently drop — losing
 * the provenance of a project's compose is not a recoverable mistake.
 */
export function parseComposeSourceInput(
  value: unknown,
  knownSourceIds?: ReadonlySet<string>,
): { ok: true; value: ProjectComposeSource | null } | { ok: false; reason: string } {
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) return { ok: false, reason: 'composeSource must be an object' }
  const { sourceId, path, seededCommitSha, seededDigest, ref, mode } = value
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return { ok: false, reason: 'composeSource.sourceId is required' }
  }
  if (knownSourceIds && !knownSourceIds.has(sourceId)) {
    return { ok: false, reason: `source '${sourceId}' was not found for this organization` }
  }
  // Relative only: `/` is a separator here, never a root. An absolute path
  // would escape the repository, and `..` would walk out of it. Mirrors
  // `isSafeRepoPath` in the daemon's read-remote-files.ts.
  if (
    typeof path !== 'string' ||
    !SAFE_COMPOSE_PATH_RE.test(path) ||
    path.startsWith('/') ||
    path.includes('..')
  ) {
    return { ok: false, reason: 'composeSource.path is not a safe repository path' }
  }
  if (typeof seededCommitSha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(seededCommitSha)) {
    return { ok: false, reason: 'composeSource.seededCommitSha is not a commit sha' }
  }
  if (typeof seededDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(seededDigest)) {
    return { ok: false, reason: 'composeSource.seededDigest is not a sha-256 digest' }
  }
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > 255)) {
    return { ok: false, reason: 'composeSource.ref is invalid' }
  }
  if (mode !== undefined && mode !== 'seed' && mode !== 'track') {
    return { ok: false, reason: 'composeSource.mode must be seed or track' }
  }
  return {
    ok: true,
    value: {
      sourceId,
      path,
      seededCommitSha,
      seededDigest,
      ...(ref === undefined ? {} : { ref }),
      ...(mode === undefined ? {} : { mode }),
    },
  }
}

/** SHA-256 of the repository bytes, as the digest `composeSource` records. */
export async function composeSourceDigest(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Parse project.options jsonb (missing/invalid keys → omitted). */
export function parseProjectOptions(value: unknown): ProjectOptions {
  if (!isRecord(value)) return {}
  const options: ProjectOptions = {}
  if ('containerNaming' in value) {
    const parsed = parseContainerNamingInput(value.containerNaming)
    if (parsed.ok) options.containerNaming = parsed.value
  }
  if ('composeSource' in value) {
    const parsed = parseComposeSourceInput(value.composeSource)
    if (parsed.ok && parsed.value !== null) options.composeSource = parsed.value
  }
  if ('defaultServerId' in value) {
    const parsed = parseDefaultServerIdInput(value.defaultServerId)
    if (parsed.ok && parsed.value !== null) {
      options.defaultServerId = parsed.value
    }
  }
  return options
}

/** Default container naming mode when unset. */
export function resolveContainerNaming(
  options: ProjectOptions | null | undefined,
): ContainerNamingMode {
  return options?.containerNaming ?? 'uuid'
}

/** Project-level default placement when set. */
export function resolveDefaultServerId(
  options: ProjectOptions | null | undefined,
): string | null {
  return options?.defaultServerId ?? null
}

/**
 * Effective placement for an environment: its own pin wins; otherwise the
 * project default. Compose never carries placement.
 */
export function resolveEffectivePlacementServerId(
  environmentServerId: string | null | undefined,
  projectOptions: ProjectOptions | null | undefined,
): string | null {
  if (environmentServerId) return environmentServerId
  return resolveDefaultServerId(projectOptions)
}
