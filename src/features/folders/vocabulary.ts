/**
 * Folder value sets, pinned to the `folder` CHECK constraints by
 * `src/db/enum-checks.test.ts`. Kept import-free so that test stays light.
 */
export const FOLDER_KINDS = ['service', 'volume'] as const
export type FolderKindValue = (typeof FOLDER_KINDS)[number]

export const FOLDER_STATES = ['planned', 'present', 'removing', 'orphan', 'missing'] as const
export type FolderState = (typeof FOLDER_STATES)[number]

/** How a service or volume folder is named: a typed slug, the asset id, or the person's choice. */
export const DIRECTORY_NAME_MODES = ['slug', 'uuid', 'both'] as const
export type DirectoryNameMode = (typeof DIRECTORY_NAME_MODES)[number]

export const DEFAULT_DIRECTORY_NAME_MODE: DirectoryNameMode = 'slug'

export function isDirectoryNameMode(value: unknown): value is DirectoryNameMode {
  return typeof value === 'string' && (DIRECTORY_NAME_MODES as readonly string[]).includes(value)
}
