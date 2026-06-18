import { eq } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { access, permission, role } from '../db/schema.ts'
import { getResourceId } from '../authz/resource-registry.ts'

/** Intended access grant stored on an invitation row (`invitation.grants` JSONB). */
export type InvitationGrantSpec = {
  resourceKind: string
  itemId: string
  effect?: 'allow' | 'deny'
  roleId?: string
  roleKey?: string
  permissionId?: string
  permissionKey?: string
}

export function defaultInvitationGrants(
  organizationId: string,
): InvitationGrantSpec[] {
  return [
    {
      resourceKind: 'organization',
      itemId: organizationId,
      roleKey: 'member',
      effect: 'allow',
    },
  ]
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
    const grant: InvitationGrantSpec = {
      resourceKind: record.resourceKind,
      itemId: record.itemId,
    }
    if (record.effect === 'allow' || record.effect === 'deny') {
      grant.effect = record.effect
    }
    if (typeof record.roleId === 'string') grant.roleId = record.roleId
    if (typeof record.roleKey === 'string') grant.roleKey = record.roleKey
    if (typeof record.permissionId === 'string') {
      grant.permissionId = record.permissionId
    }
    if (typeof record.permissionKey === 'string') {
      grant.permissionKey = record.permissionKey
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

async function resolveRoleId(
  db: Db,
  grant: InvitationGrantSpec,
): Promise<string | null> {
  if (grant.roleId) return grant.roleId
  if (!grant.roleKey) return null
  const rows = await db
    .select({ id: role.id })
    .from(role)
    .where(eq(role.key, grant.roleKey))
    .limit(1)
  return rows[0]?.id ?? null
}

async function resolvePermissionId(
  db: Db,
  grant: InvitationGrantSpec,
): Promise<string | null> {
  if (grant.permissionId) return grant.permissionId
  if (!grant.permissionKey) return null
  const rows = await db
    .select({ id: permission.id })
    .from(permission)
    .where(eq(permission.key, grant.permissionKey))
    .limit(1)
  return rows[0]?.id ?? null
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

    const roleId = await resolveRoleId(db, grant)
    const permissionId = await resolvePermissionId(db, grant)
    if (roleId && permissionId) {
      throw new Error('GRANT_AMBIGUOUS_TARGET')
    }
    if (!roleId && !permissionId) {
      throw new Error('GRANT_MISSING_TARGET')
    }

    const values = {
      subjectKind: 'user' as const,
      subjectId: userId,
      resourceId,
      effect: grant.effect ?? ('allow' as const),
      roleId,
      permissionId,
    }

    if (roleId) {
      await db
        .insert(access)
        .values({ ...values, permissionId: null })
        .onConflictDoNothing({
          target: [
            access.subjectKind,
            access.subjectId,
            access.resourceId,
            access.roleId,
          ],
        })
    } else {
      await db
        .insert(access)
        .values({ ...values, roleId: null })
        .onConflictDoNothing({
          target: [
            access.subjectKind,
            access.subjectId,
            access.resourceId,
            access.permissionId,
          ],
        })
    }
  }
}
