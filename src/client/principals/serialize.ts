import type { principal } from '../../db/schema.ts'
import {
  accessLevelForShell,
  type PrincipalAccessLevel,
} from '../../features/principals/principal-access.ts'
import { type PrincipalNameScheme, principalNameSchemeOf } from '../../lib/principal-name-scheme.ts'
import {
  parsePrincipalOptions,
  resolvePrincipalShell,
} from '../../features/principals/principal-options.ts'

/**
 * Only the columns the serializer reads — deliberately excludes `password` so
 * callers can (and do) select a password-free projection.
 */
type PrincipalRow = Pick<
  typeof principal.$inferSelect,
  | 'id'
  | 'kind'
  | 'provider'
  | 'username'
  | 'appliedUsername'
  | 'projectId'
  | 'managedId'
  | 'metadata'
  | 'options'
  | 'createdAt'
  | 'updatedAt'
>

export type SerializedProjectPrincipal = {
  id: string
  kind: string
  provider: string
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
  managedId: string | null
  metadata: unknown
  options: unknown
  /** Services this principal runs as / owns storage for (via `tenancy`). */
  serviceIds: string[]
  /**
   * How this account may log in, decoded from `options.shell`.
   *
   * Derived rather than stored: the shell **is** the access level, so exposing
   * both a level and a shell as independent fields would let the two disagree.
   * See `lib/principal-access.ts`.
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
    kind: row.kind,
    provider: row.provider,
    username: row.username,
    appliedUsername: row.appliedUsername,
    nameScheme: principalNameSchemeOf(row),
    projectId: row.projectId,
    managedId: row.managedId,
    metadata: row.metadata,
    options: row.options,
    serviceIds: [...serviceIds].sort((a, b) => a.localeCompare(b)),
    access: accessLevelForShell(resolvePrincipalShell(parsePrincipalOptions(row.options))),
    sshKeyCount,
    passwordAuth,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
