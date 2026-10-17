/**
 * Pure name helpers for the folder layout: the project slug, and how the
 * organization setting and a create request settle on a folder name.
 * The shape rules themselves live in `contracts/directory-names.ts`.
 */
import {
  COMMON_SCOPE,
  defaultFolderNameFromDomain,
  type FolderRefParts,
  FOLDER_NAME_MAX_LENGTH,
  firstFreeFolderName,
  isPathId,
  isValidEnvironmentName,
  isValidFolderName,
  isValidOwnerName,
  isValidProjectSlug,
  PROJECT_SLUG_MAX_LENGTH,
} from '../../contracts/directory-names.ts'
import type { DirectoryNameMode } from './vocabulary.ts'

/** Slug used when a project has no name to take one from. */
export const PROJECT_SLUG_FALLBACK = 'project'

/**
 * A project slug from a project name: accents folded to plain letters, every
 * other run of characters becomes one hyphen, cut to 40 characters with the
 * ends trimmed. A name with nothing usable gives `project`.
 */
export function projectSlugFromName(name: string | null | undefined): string {
  const folded = (name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
  const cut = trimHyphens(folded.slice(0, PROJECT_SLUG_MAX_LENGTH))
  return isValidProjectSlug(cut) ? cut : PROJECT_SLUG_FALLBACK
}

/** Strip hyphens from both ends (a loop, so a long run cannot cost more than one pass). */
export function trimHyphens(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '-') start += 1
  while (end > start && value[end - 1] === '-') end -= 1
  return value.slice(start, end)
}

/** The first free project slug: the base, then `-2`, `-3` and so on up to `-99`. Null when all are taken. */
export function nextFreeProjectSlug(
  base: string,
  isTaken: (slug: string) => boolean
): string | null {
  if (!isTaken(base)) return base
  for (let n = 2; n <= 99; n += 1) {
    const suffix = `-${n}`
    const candidate = `${trimHyphens(base.slice(0, PROJECT_SLUG_MAX_LENGTH - suffix.length))}${suffix}`
    if (!isTaken(candidate)) return candidate
  }
  return null
}

export type DirectoryNameChoice = 'slug' | 'uuid'

export type DirectoryNameResolution =
  { ok: true; choice: DirectoryNameChoice } | { ok: false; error: 'directory_name_mode_forbidden' }

/**
 * Which kind of name an asset gets. `slug` and `uuid` organizations decide it;
 * with `both` the person may ask, and the default is `slug`. Asking for the
 * other kind than the organization allows is refused.
 */
export function resolveDirectoryNameChoice(
  mode: DirectoryNameMode,
  requested: DirectoryNameChoice | undefined
): DirectoryNameResolution {
  if (mode === 'both') return { ok: true, choice: requested ?? 'slug' }
  if (requested !== undefined && requested !== mode) {
    return { ok: false, error: 'directory_name_mode_forbidden' }
  }
  return { ok: true, choice: mode }
}

export type FolderNameInput = {
  choice: DirectoryNameChoice
  /** The asset's own id (a lowercase canonical UUID). */
  assetId: string
  /** A name the person typed. Never suffixed on a clash. */
  typed?: string
  /** The name made when nothing was typed (from the domain or the display name). */
  defaultBase?: string | null
  isTaken: (name: string) => boolean
}

export type FolderNameResult =
  | { ok: true; slug: string }
  | {
      ok: false
      error: 'invalid_directory_name' | 'directory_name_taken' | 'directory_name_typed_in_uuid_mode'
    }

/**
 * Settle on a service or volume folder name at creation. In uuid mode the
 * name is the asset id and a typed name is refused. A typed name is checked
 * against the rule and refused when taken; a defaulted one gets `-2` to `-99`
 * on a clash, then `directory_name_taken` so the person types one.
 */
export function resolveFolderName(input: FolderNameInput): FolderNameResult {
  if (input.choice === 'uuid') {
    if (input.typed !== undefined) return { ok: false, error: 'directory_name_typed_in_uuid_mode' }
    if (!isPathId(input.assetId)) return { ok: false, error: 'invalid_directory_name' }
    return input.isTaken(input.assetId)
      ? { ok: false, error: 'directory_name_taken' }
      : { ok: true, slug: input.assetId }
  }
  if (input.typed !== undefined) {
    if (!isValidFolderName(input.typed)) return { ok: false, error: 'invalid_directory_name' }
    return input.isTaken(input.typed)
      ? { ok: false, error: 'directory_name_taken' }
      : { ok: true, slug: input.typed }
  }
  const base = input.defaultBase ?? null
  if (base === null || !isValidFolderName(base) || base.length > FOLDER_NAME_MAX_LENGTH) {
    return { ok: false, error: 'invalid_directory_name' }
  }
  const free = firstFreeFolderName(base, input.isTaken)
  return free === null ? { ok: false, error: 'directory_name_taken' } : { ok: true, slug: free }
}

/**
 * A folder name made from a display name or a compose key: accents folded to
 * plain letters, every other run of characters becomes one hyphen, dots and
 * underscores are kept, edges trimmed, cut to 63 characters. Null when nothing
 * usable is left (the caller then falls back to the asset id).
 */
export function folderNameFromLabel(label: string | null | undefined): string | null {
  const folded = (label ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/\.{2,}/g, '.')
  const cut = trimFolderEdges(folded.slice(0, FOLDER_NAME_MAX_LENGTH))
  return isValidFolderName(cut) ? cut : null
}

/** Trim `.`, `-` and `_` from both ends (a single pass, so a long run costs no more than one). */
function trimFolderEdges(value: string): string {
  const isEdge = (ch: string | undefined) => ch === '.' || ch === '-' || ch === '_'
  let start = 0
  let end = value.length
  while (start < end && isEdge(value[start])) start += 1
  while (end > start && isEdge(value[end - 1])) end -= 1
  return value.slice(start, end)
}

/**
 * The name a new asset gets when none was typed: the domain for web hosting
 * (when it has one), else the display name or compose key, else the asset id.
 * The asset id always fits the rule, so this never returns null.
 */
export function defaultFolderBase(input: {
  domain?: string | null
  label?: string | null
  assetId: string
}): string {
  if (input.domain) {
    const fromDomain = defaultFolderNameFromDomain(input.domain)
    if (fromDomain !== null) return fromDomain
  }
  return folderNameFromLabel(input.label) ?? input.assetId
}

/**
 * The folder reference of an asset from what its rows say, or undefined while
 * any part is missing or does not satisfy the rule (an environment named
 * before names became folder names, a slug not set yet). The wire then carries
 * no `folder` for it and the old fields stay authoritative.
 */
export function assetFolderRef(input: {
  owner: string | null | undefined
  isCommon: boolean
  environmentName: string | null | undefined
  slug: string | null | undefined
}): FolderRefParts | undefined {
  const scope = input.isCommon ? COMMON_SCOPE : input.environmentName
  if (
    !isValidOwnerName(input.owner) ||
    !isValidFolderName(input.slug) ||
    (!input.isCommon && !isValidEnvironmentName(scope))
  ) {
    return undefined
  }
  return { owner: input.owner as string, scope: scope as string, slug: input.slug as string }
}
