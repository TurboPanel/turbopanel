import type { principal } from '../../lib/db/schema.ts'

type PrincipalRow = typeof principal.$inferSelect

export type SerializedProjectPrincipal = {
  id: string
  kind: string
  provider: string
  username: string
  projectId: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export function serializeProjectPrincipal(row: PrincipalRow): SerializedProjectPrincipal {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    username: row.username,
    projectId: row.projectId,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
