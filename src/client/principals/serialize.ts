import type { principal } from '../../lib/db/schema.ts'

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
  createdAt: string
  updatedAt: string
}

export function serializeProjectPrincipal(
  row: PrincipalRow,
  serviceIds: readonly string[] = [],
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
