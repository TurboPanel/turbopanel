/**
 * Defensive read-only parser for `project.options` jsonb fields used by
 * container naming and optional default server placement. Does not model or
 * round-trip `options.compose`.
 */

import { isPlacementServerId } from '../compose/placement.ts'

export type ContainerNamingMode = 'uuid' | 'custom'

export type ProjectOptions = {
  containerNaming?: ContainerNamingMode
  /**
   * Where this project's Base compose came from, and whether it follows it.
   *
   * A project created from a Git repository **tracks** the repository's compose
   * file (`mode: 'track'`, the default for a new one): every deploy reads
   * `path` at the exact commit it deploys and uses that as the Base, with the
   * environment's own changes layered on top as always. The stored Base is the
   * content of the last read, kept so the other readers of the Base (lint,
   * listings, a switch to `'seed'`) see what the last deploy used. While
   * tracking, the Base cannot be edited through the API.
   *
   * `'seed'` means the repository file was copied once and the operator owns
   * the Base from then on. A project with no `mode` stored is `'seed'`.
   *
   * `seededDigest` hashes the **repository bytes as seeded**; `lastReadDigest`
   * and `lastReadCommitSha` say what the latest deploy read, so drift means
   * "the repo moved", never "the operator edited".
   *
   * A service's own `x-turbopanel.source` still decides which repo a *build*
   * clones. Keep the two distinct.
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
  /** Commit the latest deploy read `path` at (track mode). */
  lastReadCommitSha?: string
  /** SHA-256 of the repository bytes the latest deploy read (track mode). */
  lastReadDigest?: string
}

/**
 * What a deploy recorded about the Base it used, as `composeBase` on the deploy
 * command's context and on each deployment history entry. The UI shows it as
 * "Base from <path> @ <commitSha>".
 */
export type ComposeBaseRecord = {
  sourceId: string
  ref: string
  path: string
  commitSha: string
  /** SHA-256 of the repository file's bytes: the Base that was used. */
  digest: string
}

/** Error codes a tracked read answers with (stable; the UI keys on them). */
export type TrackedBaseErrorCode =
  'compose_source_unavailable' | 'compose_file_missing' | 'compose_file_unparseable'

export type TrackedBaseError = {
  code: TrackedBaseErrorCode
  /** Plain sentence naming the file and the commit (or ref when no commit is known). */
  message: string
  sourceId: string
  ref: string
  path: string
  /** Commit the read was made at; absent when the repository could not be reached. */
  commitSha?: string
}

/** The project options a deploy works from, and what the tracked read contributed. */
export type DeployProjectOptions =
  | {
      ok: true
      options: unknown
      /** The Base that was used; `null` when the project does not track a file. */
      base: ComposeBaseRecord | null
      /**
       * Set when the commit came from a head read: services that build from this
       * repository and branch are pinned to it, so one deploy is one commit.
       */
      pin?: { sourceId: string; ref: string; commitSha: string }
      /** Set when a preview used the stored Base because the file could not be read. */
      unreadable?: TrackedBaseError
    }
  | { ok: false; error: TrackedBaseError }

/** The `composeBase` bag on a command context, or null when absent or malformed. */
export function readComposeBaseRecord(value: unknown): ComposeBaseRecord | null {
  if (!isRecord(value)) return null
  const { sourceId, ref, path, commitSha, digest } = value
  if (
    typeof sourceId !== 'string' ||
    typeof ref !== 'string' ||
    typeof path !== 'string' ||
    typeof commitSha !== 'string' ||
    typeof digest !== 'string'
  ) {
    return null
  }
  return { sourceId, ref, path, commitSha, digest }
}

/** True when this project's Base follows the repository's compose file. */
export function isTrackingComposeSource(
  source: ProjectComposeSource | null | undefined
): source is ProjectComposeSource & { mode: 'track' } {
  return source?.mode === 'track'
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
  value: unknown
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
  value: unknown
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isPlacementServerId(value)) {
    return { ok: false }
  }
  return { ok: true, value }
}

const SAFE_COMPOSE_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/

const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i
const SHA256_RE = /^[0-9a-f]{64}$/i

type ComposeSourceOptional = Pick<
  ProjectComposeSource,
  'ref' | 'mode' | 'lastReadCommitSha' | 'lastReadDigest'
>

/** The optional `composeSource` fields, validated, or the reason one is invalid. */
function parseComposeSourceOptional(
  value: Record<string, unknown>
): { ok: true; fields: ComposeSourceOptional } | { ok: false; reason: string } {
  const { ref, mode, lastReadCommitSha, lastReadDigest } = value
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > 255)) {
    return { ok: false, reason: 'composeSource.ref is invalid' }
  }
  if (mode !== undefined && mode !== 'seed' && mode !== 'track') {
    return { ok: false, reason: 'composeSource.mode must be seed or track' }
  }
  if (
    lastReadCommitSha !== undefined &&
    (typeof lastReadCommitSha !== 'string' || !COMMIT_SHA_RE.test(lastReadCommitSha))
  ) {
    return { ok: false, reason: 'composeSource.lastReadCommitSha is not a commit sha' }
  }
  if (
    lastReadDigest !== undefined &&
    (typeof lastReadDigest !== 'string' || !SHA256_RE.test(lastReadDigest))
  ) {
    return { ok: false, reason: 'composeSource.lastReadDigest is not a sha-256 digest' }
  }
  return {
    ok: true,
    fields: {
      ...(ref === undefined ? {} : { ref }),
      ...(mode === undefined ? {} : { mode }),
      ...(lastReadCommitSha === undefined ? {} : { lastReadCommitSha }),
      ...(lastReadDigest === undefined ? {} : { lastReadDigest }),
    },
  }
}

/**
 * Parse a `composeSource` block. Returns `{ ok: false }` for anything
 * malformed so a write boundary can reject rather than silently drop — losing
 * the provenance of a project's compose is not a recoverable mistake.
 */
export function parseComposeSourceInput(
  value: unknown,
  knownSourceIds?: ReadonlySet<string>
): { ok: true; value: ProjectComposeSource | null } | { ok: false; reason: string } {
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) return { ok: false, reason: 'composeSource must be an object' }
  const { sourceId, path, seededCommitSha, seededDigest } = value
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
  const optional = parseComposeSourceOptional(value)
  if (!optional.ok) return optional
  return { ok: true, value: { sourceId, path, seededCommitSha, seededDigest, ...optional.fields } }
}

/** SHA-256 of the repository bytes as seeded. */
  seededDigest: string
  mode?: 'seed' | 'track'
  /** Commit the latest deploy read `path` at (track mode). */
  lastReadCommitSha?: string
  /** SHA-256 of the repository bytes the latest deploy read (track mode). */
  lastReadDigest?: string
}

/**
 * What a deploy recorded about the Base it used, as `composeBase` on the deploy
 * command's context and on each deployment history entry. The UI shows it as
 * "Base from <path> @ <commitSha>".
 */
export type ComposeBaseRecord = {
  sourceId: string
  ref: string
  path: string
  commitSha: string
  /** SHA-256 of the repository file's bytes: the Base that was used. */
  digest: string
}

/** Error codes a tracked read answers with (stable; the UI keys on them). */
export type TrackedBaseErrorCode =
  'compose_source_unavailable' | 'compose_file_missing' | 'compose_file_unparseable'

export type TrackedBaseError = {
  code: TrackedBaseErrorCode
  /** Plain sentence naming the file and the commit (or ref when no commit is known). */
  message: string
  sourceId: string
  ref: string
  path: string
  /** Commit the read was made at; absent when the repository could not be reached. */
  commitSha?: string
}

/** The project options a deploy works from, and what the tracked read contributed. */
export type DeployProjectOptions =
  | {
      ok: true
      options: unknown
      /** The Base that was used; `null` when the project does not track a file. */
      base: ComposeBaseRecord | null
      /**
       * Set when the commit came from a head read: services that build from this
       * repository and branch are pinned to it, so one deploy is one commit.
       */
      pin?: { sourceId: string; ref: string; commitSha: string }
      /** Set when a preview used the stored Base because the file could not be read. */
      unreadable?: TrackedBaseError
    }
  | { ok: false; error: TrackedBaseError }

/** The `composeBase` bag on a command context, or null when absent or malformed. */
export function readComposeBaseRecord(value: unknown): ComposeBaseRecord | null {
  if (!isRecord(value)) return null
  const { sourceId, ref, path, commitSha, digest } = value
  if (
    typeof sourceId !== 'string' ||
    typeof ref !== 'string' ||
    typeof path !== 'string' ||
    typeof commitSha !== 'string' ||
    typeof digest !== 'string'
  ) {
    return null
  }
  return { sourceId, ref, path, commitSha, digest }
}

/** True when this project's Base follows the repository's compose file. */
export function isTrackingComposeSource(
  source: ProjectComposeSource | null | undefined
): source is ProjectComposeSource & { mode: 'track' } {
  return source?.mode === 'track'
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
  value: unknown
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
  value: unknown
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isPlacementServerId(value)) {
    return { ok: false }
  }
  return { ok: true, value }
}

const SAFE_COMPOSE_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/

const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i
const SHA256_RE = /^[0-9a-f]{64}$/i

type ComposeSourceOptional = Pick<
  ProjectComposeSource,
  'ref' | 'mode' | 'lastReadCommitSha' | 'lastReadDigest'
>

/** The optional `composeSource` fields, validated, or the reason one is invalid. */
function parseComposeSourceOptional(
  value: Record<string, unknown>
): { ok: true; fields: ComposeSourceOptional } | { ok: false; reason: string } {
  const { ref, mode, lastReadCommitSha, lastReadDigest } = value
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > 255)) {
    return { ok: false, reason: 'composeSource.ref is invalid' }
  }
  if (mode !== undefined && mode !== 'seed' && mode !== 'track') {
    return { ok: false, reason: 'composeSource.mode must be seed or track' }
  }
  if (
    lastReadCommitSha !== undefined &&
    (typeof lastReadCommitSha !== 'string' || !COMMIT_SHA_RE.test(lastReadCommitSha))
  ) {
    return { ok: false, reason: 'composeSource.lastReadCommitSha is not a commit sha' }
  }
  if (
    lastReadDigest !== undefined &&
    (typeof lastReadDigest !== 'string' || !SHA256_RE.test(lastReadDigest))
  ) {
    return { ok: false, reason: 'composeSource.lastReadDigest is not a sha-256 digest' }
  }
  return {
    ok: true,
    fields: {
      ...(ref === undefined ? {} : { ref }),
      ...(mode === undefined ? {} : { mode }),
      ...(lastReadCommitSha === undefined ? {} : { lastReadCommitSha }),
      ...(lastReadDigest === undefined ? {} : { lastReadDigest }),
    },
  }
}

/**
 * Parse a `composeSource` block. Returns `{ ok: false }` for anything
 * malformed so a write boundary can reject rather than silently drop — losing
 * the provenance of a project's compose is not a recoverable mistake.
 */
export function parseComposeSourceInput(
  value: unknown,
  knownSourceIds?: ReadonlySet<string>
): { ok: true; value: ProjectComposeSource | null } | { ok: false; reason: string } {
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) return { ok: false, reason: 'composeSource must be an object' }
  const { sourceId, path, seededCommitSha, seededDigest } = value
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
  const optionalError = composeSourceOptionalError(value)
  if (optionalError) return { ok: false, reason: optionalError }
  return {
    ok: true,
    value: {
      sourceId,
      path,
      seededCommitSha,
      seededDigest,
      ...(ref === undefined ? {} : { ref }),
      ...(mode === undefined ? {} : { mode }),
      ...(lastReadCommitSha === undefined ? {} : { lastReadCommitSha }),
      ...(lastReadDigest === undefined ? {} : { lastReadDigest }),
    },
  }
}

/** SHA-256 of the repository bytes, as the digest `composeSource` records. */
export async function composeSourceDigest(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
  return options
}

/**
 * The default placement server lives in `project.default_server_id`, but the
 * API still carries it as `options.defaultServerId`. Takes it out of an
 * options object a client sent: `options` without the key, and the column
 * value (`null` clears it). Options sent as `null` clear it too.
 */
export function splitProjectDefaultServer(options: Record<string, unknown> | null): {
  options: Record<string, unknown> | null
  defaultServerId: string | null
} {
  if (options === null) return { options, defaultServerId: null }
  const { defaultServerId, ...rest } = options
  const parsed = parseDefaultServerIdInput(defaultServerId ?? null)
  return { options: rest, defaultServerId: parsed.ok ? parsed.value : null }
}

/** The options an API response shows: the stored options plus `defaultServerId` from its column. */
export function mergeProjectDefaultServer<T>(
  options: T,
  defaultServerId: string | null | undefined
): T | (Record<string, unknown> & { defaultServerId: string }) {
  if (!defaultServerId) return options
  const base = isRecord(options) ? options : {}
  return { ...base, defaultServerId }
}

/** Default container naming mode when unset. */
export function resolveContainerNaming(
  options: ProjectOptions | null | undefined
): ContainerNamingMode {
  return options?.containerNaming ?? 'uuid'
}

/**
 * Effective placement for an environment: its own pin wins; otherwise the
 * project default. Compose never carries placement.
 */
export function resolveEffectivePlacementServerId(
  environmentServerId: string | null | undefined,
  projectDefaultServerId: string | null | undefined
): string | null {
  if (environmentServerId) return environmentServerId
  return projectDefaultServerId ?? null
}
