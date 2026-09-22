/**
 * Shared values for the repository-read surface.
 *
 * A leaf module on purpose. `git-provider.ts` imports every provider to build
 * its registry, so a provider importing *values* back from it closes a cycle
 * and the registry hits the temporal dead zone at module init. Types are
 * erased and cause no cycle; runtime constants do. Keep these here.
 */

/** Default per-file cap. Larger files are reported `too_large`, not truncated. */
export const MAX_REPOSITORY_FILE_BYTES = 256 * 1024

/** Cap on how many paths one read may ask for. */
export const MAX_REPOSITORY_READ_PATHS = 8

/**
 * A per-file miss is an **answer**, not a failure: "this repository has no
 * `docker-compose.yml`" is exactly what the wizard renders.
 */
export type RepositoryFileEntry =
  | { path: string; found: true; content: string; bytes: number }
  | {
    path: string
    found: false
    reason: 'not_found' | 'too_large' | 'not_a_file' | 'binary'
  }

export type RepositoryFileSet = {
  /** Commit every entry was read at — one read, one commit, no torn view. */
  commitSha: string
  files: RepositoryFileEntry[]
}

export type RepositoryEntry = {
  path: string
  kind: 'file' | 'dir'
  bytes?: number
}

/** This provider has no read API for this source — fall back to the daemon. */
export type RepositoryReadUnsupported = { unsupported: true }

export function isRepositoryReadUnsupported(
  value: unknown,
): value is RepositoryReadUnsupported {
  return typeof value === 'object' && value !== null && 'unsupported' in value
}
