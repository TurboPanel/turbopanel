/**
 * Org-level folder naming: request parsing, the options patch, the lock check
 * and the response shape for `GET/PUT /organizations/:id/directory-defaults`.
 *
 * Keys live on `organization.options`: `directoryNames` (`slug`, `uuid` or
 * `both`) and `directoryNamesLocked`. The lock is the flag or the existence of
 * any folder row for the organization's site owners: once something has a
 * folder the setting cannot change, so what the choice means never shifts under
 * folders that already exist. Existing folders are never renamed.
 */
import {
  DEFAULT_DIRECTORY_NAME_MODE,
  type DirectoryNameMode,
  isDirectoryNameMode,
} from '../folders/vocabulary.ts'
import { type OrganizationOptions, resolveDirectoryNames } from './organization-options.ts'

export type DirectoryDefaultsPatch = {
  /** `undefined` leaves the setting alone; `null` clears it to the default (`slug`). */
  names?: DirectoryNameMode | null
  locked?: boolean
}

type ParseResult = { ok: true; patch: DirectoryDefaultsPatch } | { ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a PUT body: at least one recognised field, each of the right type. */
export function parseDirectoryDefaultsPatch(body: unknown): ParseResult {
  if (!isRecord(body)) return { ok: false }
  const patch: DirectoryDefaultsPatch = {}
  if ('names' in body) {
    if (body.names !== null && !isDirectoryNameMode(body.names)) return { ok: false }
    patch.names = body.names
  }
  if ('locked' in body) {
    if (typeof body.locked !== 'boolean') return { ok: false }
    patch.locked = body.locked
  }
  if (patch.names === undefined && patch.locked === undefined) return { ok: false }
  return { ok: true, patch }
}

export type DirectoryDefaultsDecision =
  { ok: true } | { ok: false; error: 'directory_names_locked' }

/**
 * Whether the patch may apply. A change of the setting is refused while it is
 * locked by the flag (unless the same request clears the flag) or by an
 * existing folder; clearing the flag is refused while a folder exists. Writing
 * the value already in force is always fine.
 */
export function decideDirectoryDefaultsPatch(
  patch: DirectoryDefaultsPatch,
  options: OrganizationOptions,
  foldersExist: boolean
): DirectoryDefaultsDecision {
  const current = resolveDirectoryNames(options)
  if (patch.locked === false && foldersExist) return { ok: false, error: 'directory_names_locked' }
  const next =
    patch.names === undefined ? current.mode : (patch.names ?? DEFAULT_DIRECTORY_NAME_MODE)
  if (next === current.mode) return { ok: true }
  const unlockedByRequest = patch.locked === false
  if (foldersExist || (current.locked && !unlockedByRequest)) {
    return { ok: false, error: 'directory_names_locked' }
  }
  return { ok: true }
}

/** Option keys to delete and keys to set for a patch (applied atomically in SQL). */
export function directoryDefaultsOptionChanges(patch: DirectoryDefaultsPatch): {
  remove: string[]
  set: Record<string, unknown>
} {
  const remove: string[] = []
  const set: Record<string, unknown> = {}
  if (patch.names === null) remove.push('directoryNames')
  else if (patch.names !== undefined) set.directoryNames = patch.names
  if (patch.locked === true) set.directoryNamesLocked = true
  if (patch.locked === false) remove.push('directoryNamesLocked')
  return { remove, set }
}

/** Response body shared by GET and PUT. */
export function directoryDefaultsResponse(options: OrganizationOptions, foldersExist: boolean) {
  const policy = resolveDirectoryNames(options)
  return {
    names: options.directoryNames ?? null,
    effectiveNames: policy.mode,
    locked: policy.locked || foldersExist,
    lockedByFolders: foldersExist,
  }
}
