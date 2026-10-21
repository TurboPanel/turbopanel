/**
 * The folder fields a create or edit body may carry for a service or volume:
 * `slug` (a typed folder name), `directoryName` (`slug` or `uuid`, only when the
 * organization allows both) and `common` (place it in the shared scope).
 */
import type { DirectoryNameChoice } from './names.ts'

export type FolderOptions = {
  slug?: string
  directoryName?: DirectoryNameChoice
  common?: boolean
}

export type FolderOptionsResult = { ok: true; options: FolderOptions } | { ok: false }

/** Read the three fields from a body. Present-but-wrong-type fields fail; absent ones are skipped. */
export function parseFolderOptions(body: Record<string, unknown>): FolderOptionsResult {
  const options: FolderOptions = {}
  if (body.slug !== undefined) {
    if (typeof body.slug !== 'string') return { ok: false }
    options.slug = body.slug
  }
  if (body.directoryName !== undefined) {
    if (body.directoryName !== 'slug' && body.directoryName !== 'uuid') return { ok: false }
    options.directoryName = body.directoryName
  }
  if (body.common !== undefined) {
    if (typeof body.common !== 'boolean') return { ok: false }
    options.common = body.common
  }
  return { ok: true, options }
}

/** True when the body names any of the folder fields. */
export function hasFolderOptions(options: FolderOptions): boolean {
  return (
    options.slug !== undefined ||
    options.directoryName !== undefined ||
    options.common !== undefined
  )
}
