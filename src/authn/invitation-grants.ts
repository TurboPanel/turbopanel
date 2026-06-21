import { sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { access } from '../db/schema.ts'
import { isAccessProfileKey, isPermissionKey } from '../authz/catalog.ts'
import { getResourceId } from '../authz/resource-registry.ts'

/** Intended access grant stored on an invitation row (`invitation.grants` JSONB). */
export type InvitationGrantSpec = {
  resourceKind: string
  itemId: string
  effect?: 'allow' | 'deny'
  accessProfileKey?: string
  permissionKey?: string
}

export function defaultInvitationGrants(
  organizationId: string,
): InvitationGrantSpec[] {
  return [
    {
      resourceKind: 'organization',
      itemId: organizationId,
      accessProfileKey: 'member',
      effect: 'allow',
    },
  ]
}

function parseGrantTarget(
  record: Record<string, unknown>,
): Pick<InvitationGrantSpec, 'accessProfileKey' | 'permissionKey'> | null {
  const accessProfileKeyFromRecord =
    typeof record.accessProfileKey === 'string' ? record.accessProfileKey : undefined
  const roleKeyFromRecord =
    typeof record.roleKey === 'string' ? record.roleKey : undefined
  if (
    accessProfileKeyFromRecord &&
    roleKeyFromRecord &&
    accessProfileKeyFromRecord !== roleKeyFromRecord
  ) {
    return null
  }

  const accessProfileKey = accessProfileKeyFromRecord ?? roleKeyFromRecord
  const permissionKey =
    typeof record.permissionKey === 'string' ? record.permissionKey : undefined

  const hasRoleId = typeof record.roleId === 'string' && record.roleId.length > 0
  const hasPermissionId =
    typeof record.permissionId === 'string' && record.permissionId.length > 0

  if (hasRoleId && !accessProfileKey) return null
  if (hasPermissionId && !permissionKey) return null
  if (accessProfileKey && permissionKey) return null
  if (!accessProfileKey && !permissionKey) return null

  if (accessProfileKey && !isAccessProfileKey(accessProfileKey)) return null
  if (permissionKey && !isPermissionKey(permissionKey)) return null

  return {
    ...(accessProfileKey ? { accessProfileKey } : {}),
    ...(permissionKey ? { permissionKey } : {}),
  }
}

export function parseInvitationGrants(
  raw: unknown,
): InvitationGrantSpec[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) return null

  const grants: InvitationGrantSpec[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return null
    }
    const record = entry as Record<string, unknown>
    if (
      typeof record.resourceKind !== 'string' ||
      typeof record.itemId !== 'string'
    ) {
      return null
    }

    const target = parseGrantTarget(record)
    if (!target) return null

    const grant: InvitationGrantSpec = {
      resourceKind: record.resourceKind,
      itemId: record.itemId,
      ...target,
    }
    if (record.effect === 'allow' || record.effect === 'deny') {
      grant.effect = record.effect
    }
    grants.push(grant)
  }

  return grants.length > 0 ? grants : null
}

export function resolveInvitationGrants(
  raw: unknown,
  organizationId: string,
): InvitationGrantSpec[] {
  return parseInvitationGrants(raw) ?? defaultInvitationGrants(organizationId)
}

/** Materialize invitation grant specs into user-scoped `access` rows (idempotent). */
export async function materializeInvitationGrants(
  db: Db,
  userId: string,
  grants: InvitationGrantSpec[],
): Promise<void> {
  for (const grant of grants) {
    const resourceId = await getResourceId(db, grant.resourceKind, grant.itemId)
    if (!resourceId) {
      throw new Error(
        `RESOURCE_NOT_REGISTERED:${grant.resourceKind}:${grant.itemId}`,
      )
    }

    const accessProfileKey = grant.accessProfileKey ?? null
    const permissionKey = grant.permissionKey ?? null
    if (accessProfileKey && permissionKey) {
      throw new Error('GRANT_AMBIGUOUS_TARGET')
    }
    if (!accessProfileKey && !permissionKey) {
      throw new Error('GRANT_MISSING_TARGET')
    }

    const values = {
      subjectKind: 'user' as const,
      subjectId: userId,
      resourceId,
      effect: grant.effect ?? ('allow' as const),
      accessProfileKey,
      permissionKey,
    }

    if (accessProfileKey) {
      await db
        .insert(access)
        .values({ ...values, permissionKey: null })
        .onConflictDoNothing({
          target: [
            access.subjectKind,
            access.subjectId,
            access.resourceId,
            access.accessProfileKey,
          ],
          where: sql`${access.accessProfileKey} IS NOT NULL`,
        })
    } else {
      await db
        .insert(access)
        .values({ ...values, accessProfileKey: null })
        .onConflictDoNothing({
          target: [
            access.subjectKind,
            access.subjectId,
            access.resourceId,
            access.permissionKey,
          ],
          where: sql`${access.permissionKey} IS NOT NULL`,
        })
    }
  }
}
