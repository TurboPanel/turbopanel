import type { principal } from '../../lib/db/schema.ts'
import {
  accessLevelForShell,
  type PrincipalAccessLevel,
} from '../../lib/principal-access.ts'
import { parsePrincipalOptions, resolvePrincipalShell } from '../../lib/principal-options.ts'

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
  projectId: string | null
  managedId: string | null
  metadata: unknown
  options: unknown
  /** Services this principal runs as / owns storage for (via `steward`). */
  serviceIds: string[]
  /**
   * Runtime series this principal may execute on the host. `grantedBy` says
   * whether an operator granted it or a deploy inserted it because a service
   * declared the runtime — both are real, revocable grants.
   */
  entitlements: { runtime: string; series: string; grantedBy: string }[]
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
  createdAt: string
  updatedAt: string
}

export function serializeProjectPrincipal(
  row: PrincipalRow,
  serviceIds: readonly string[] = [],
  entitlements: readonly {
    runtime: string
    series: string
    grantedBy: string
  }[] = [],
  sshKeyCount = 0,
): SerializedProjectPrincipal {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    username: row.username,
    projectId: row.projectId,
    managedId: row.managedId,
    metadata: row.metadata,
    options: row.options,
    serviceIds: [...serviceIds].sort((a, b) => a.localeCompare(b)),
    entitlements: [...entitlements].sort((a, b) =>
      `${a.runtime}@${a.series}`.localeCompare(`${b.runtime}@${b.series}`)
    ),
    access: accessLevelForShell(
      resolvePrincipalShell(parsePrincipalOptions(row.options)),
    ),
    sshKeyCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
