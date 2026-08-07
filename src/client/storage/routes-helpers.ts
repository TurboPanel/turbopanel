import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { storage } from '../../lib/db/schema.ts'

export const STORAGE_KINDS = ['docker_volume', 'bind_mount', 'file', 'directory'] as const
export type StorageKind = typeof STORAGE_KINDS[number]

export const MOUNT_KINDS = new Set<StorageKind>(['bind_mount', 'file', 'directory'])

export const PARENT_FIELDS = [
  { bodyKey: 'projectId', column: 'projectId' as const, entityKind: 'project' as const },
  { bodyKey: 'environmentId', column: 'environmentId' as const, entityKind: 'environment' as const },
  { bodyKey: 'serviceId', column: 'serviceId' as const, entityKind: 'service' as const },
] as const

type StorageRow = typeof storage.$inferSelect
export type StorageParentEntityKind = 'project' | 'environment' | 'service'

export function isStorageKind(value: unknown): value is StorageKind {
  return typeof value === 'string' &&
    (STORAGE_KINDS as readonly string[]).includes(value)
}

export function optionalStringField(value: unknown): string | null {
  if (typeof value === 'string') return value
  return null
}

export function resolveStorageProjectId(parent: { column: string; id: string }): string | null {
  if (parent.column === 'projectId') return parent.id
  return null
}

export function resolvePatchKind(body: Record<string, unknown>, existing: StorageRow): StorageKind {
  if (isStorageKind(body.kind)) return body.kind
  return existing.kind as StorageKind
}

export function resolvePatchPrincipalId(
  body: Record<string, unknown>,
  existing: string | null,
): string | null {
  if (body.principalId === null) return null
  if (typeof body.principalId === 'string') return body.principalId
  return existing
}

export function resolvePatchStorageRefs(
  body: Record<string, unknown>,
  existing: StorageRow,
): {
  serverId: string
  kind: StorageKind
  destinationPath: string | null
  principalId: string | null
} {
  const destinationPath = optionalStringField(body.destinationPath)
  return {
    serverId: optionalStringField(body.serverId) ?? existing.serverId,
    kind: resolvePatchKind(body, existing),
    destinationPath: destinationPath ?? existing.destinationPath,
    principalId: resolvePatchPrincipalId(body, existing.principalId),
  }
}

export function resolveStorageParentContext(row: StorageRow | undefined): {
  parentId: string
  entityKind: StorageParentEntityKind
} | null {
  if (!row) return null
  if (row.serviceId) {
    return { parentId: row.serviceId, entityKind: 'service' }
  }
  if (row.environmentId) {
    return { parentId: row.environmentId, entityKind: 'environment' }
  }
  if (row.projectId) {
    return { parentId: row.projectId, entityKind: 'project' }
  }
  return null
}

export function parseStorageParent(c: Context<AppEnv>, body: Record<string, unknown>) {
  const specified = PARENT_FIELDS.filter(({ bodyKey }) => {
    const value = body[bodyKey]
    return value !== undefined && value !== null && value !== ''
  })
  if (specified.length !== 1) {
    return c.json({ error: 'Exactly one parent resource must be specified' }, 400)
  }
  const { bodyKey, column, entityKind } = specified[0]!
  const id = body[bodyKey]
  if (typeof id !== 'string' || !id) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return { column, id, entityKind }
}

export function mountKindRequiresDestination(
  kind: StorageKind,
  destinationPath: string | null | undefined,
): boolean {
  if (!MOUNT_KINDS.has(kind)) return false
  return !destinationPath?.trim()
}
