import type { principal } from '../../db/schema.ts'
import type { PrincipalAccessLevel } from '../../features/principals/principal-access.ts'
import { type PrincipalNameScheme, principalNameSchemeOf } from '../../lib/principal-name-scheme.ts'

/**
 * Only the columns the serializer reads — deliberately excludes `password` so
 * callers can (and do) select a password-free projection.
 */
type PrincipalRow = Pick<
  typeof principal.$inferSelect,
  | 'id'
  | 'username'
  | 'appliedUsername'
  | 'projectId'
  | 'metadata'
  | 'options'
  | 'access'
  | 'createdAt'
  | 'updatedAt'
>

export type SerializedProjectPrincipal = {
  id: string
  username: string
  /**
   * Login actually created on the host — the short `username` plus a random
   * `_<11>` suffix when the org randomized-usernames default was on at create.
   * This is the name to SSH/SFTP in with; `username` is the panel identity.
   */
  appliedUsername: string
  /**
   * Scheme the system name (`appliedUsername`) was derived with: `plain`
   * (same as `username`), `partial` (`username` + random suffix) or `random`
   * (no trace of `username`). Older rows are derived from their names.
   */
  nameScheme: PrincipalNameScheme
  projectId: string | null
  metadata: unknown
  options: unknown
  /** Services this principal runs as / owns storage for (via `tenancy`). */
  serviceIds: string[]
  /**
   * How this account may log in: the stored `principal.access` level. The shell
   * the host sees is derived from it, never stored beside it, so the two cannot
   * disagree. See `features/principals/principal-access.ts`.
   *
   * This is what the operator asked for. What actually happens also depends on
   * `sshKeyCount` — an account set to `shell` with no keys cannot log in at all,
   * because password authentication is off for these accounts. The UI renders
   * both, so "Shell (no keys yet)" is distinguishable from "No access".
   */
  access: PrincipalAccessLevel
  /** Keys on file. Zero means no login is possible at any access level. */
  sshKeyCount: number
  /**
   * Whether password sign-in is enabled — presence of a stored hash, never the
   * hash itself. With neither this nor a key, no login is possible at any
   * access level.
   */
  passwordAuth: boolean
  createdAt: string
  updatedAt: string
}

export function serializeProjectPrincipal(
  row: PrincipalRow,
  serviceIds: readonly string[] = [],
  sshKeyCount = 0,
  passwordAuth = false
): SerializedProjectPrincipal {
  return {
    id: row.id,
    username: row.username,
    appliedUsername: row.appliedUsername,
    nameScheme: principalNameSchemeOf(row),
    projectId: row.projectId,
    metadata: row.metadata,
    options: row.options,
    serviceIds: [...serviceIds].sort((a, b) => a.localeCompare(b)),
    access: row.access as PrincipalAccessLevel,
    sshKeyCount,
    passwordAuth,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
