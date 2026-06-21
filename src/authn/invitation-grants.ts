import type { Db } from '../db.ts'
import { accessGrant } from '../db/schema.ts'
import { ACCESS_PROFILES, isAccessProfileKey, isPermissionKey, type AccessProfileKey } from '../authz/catalog.ts'
import { validateGrantEntityTarget } from '../authz/create-access-grant.ts'

/** Thrown when an invitation grant target fails validation before insert. */
export class InvitationGrantValidationError extends Error {
  readonly status: 400 | 404

  constructor(message: string, status: 400 | 404 = 404) {
    super(message)
    this.name = 'InvitationGrantValidationError'
    this.status = status
  }
}

/** Intended access grant stored on an invitation row (`invitation.grants` JSONB). */
export type InvitationGrantSpec = {
  entityType: string
  entityId: string
  allowed?: boolean
  accessProfileKey?: string
  permissionKey?: string
}

export function defaultInvitationGrants(
  organizationId: string,
): InvitationGrantSpec[] {
  return [
    {
      entityType: 'organization',
      entityId: organizationId,
      accessProfileKey: 'member',
      allowed: true,
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
    const entityType =
      typeof record.entityType === 'string'
        ? record.entityType
        : typeof record.resourceKind === 'string'
          ? record.resourceKind
          : null
    const entityId =
      typeof record.entityId === 'string'
        ? record.entityId
        : typeof record.itemId === 'string'
          ? record.itemId
          : null

    if (!entityType || !entityId) {
      return null
    }

    const target = parseGrantTarget(record)
    if (!target) return null

    const allowed = record.allowed
    const effect = record.effect
    if (allowed !== undefined && typeof allowed !== 'boolean') {
      return null
    }
    if (
      effect !== undefined &&
      effect !== 'allow' &&
      effect !== 'deny'
    ) {
      return null
    }

    const resolvedAllowed =
      typeof allowed === 'boolean'
        ? allowed
        : effect === 'deny'
          ? false
          : undefined

    const grant: InvitationGrantSpec = {
      entityType,
      entityId,
      ...target,
      ...(resolvedAllowed !== undefined ? { allowed: resolvedAllowed } : {}),
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

/** Materialize invitation grant specs into user-scoped `grant` rows (idempotent). */
export async function materializeInvitationGrants(
  db: Db,
  userId: string,
  grants: InvitationGrantSpec[],
  organizationId: string,
): Promise<void> {
  for (const grant of grants) {
    const targetResult = await validateGrantEntityTarget(
      db,
      grant.entityType,
      grant.entityId,
      organizationId,
    )
    if (!targetResult.ok) {
      throw new InvitationGrantValidationError(targetResult.error, targetResult.status)
    }

    const accessProfileKey = grant.accessProfileKey ?? null
    const permissionKey = grant.permissionKey ?? null
    if (accessProfileKey && permissionKey) {
      throw new Error('GRANT_AMBIGUOUS_TARGET')
    }
    if (!accessProfileKey && !permissionKey) {
      throw new Error('GRANT_MISSING_TARGET')
    }

    const allowed = grant.allowed ?? true

    if (accessProfileKey) {
      const profileKey = accessProfileKey as AccessProfileKey
      const permissions = ACCESS_PROFILES[profileKey]
      for (const permission of permissions) {
        await db
          .insert(accessGrant)
          .values({
            entityType: grant.entityType,
            entityId: grant.entityId,
            subjectType: 'user',
            subjectId: userId,
            permission,
            allowed,
          })
          .onConflictDoNothing({
            target: [
              accessGrant.entityType,
              accessGrant.entityId,
              accessGrant.subjectType,
              accessGrant.subjectId,
              accessGrant.permission,
            ],
          })
      }
    } else {
      await db
        .insert(accessGrant)
        .values({
          entityType: grant.entityType,
          entityId: grant.entityId,
          subjectType: 'user',
          subjectId: userId,
          permission: permissionKey!,
          allowed,
        })
        .onConflictDoNothing({
          target: [
            accessGrant.entityType,
            accessGrant.entityId,
            accessGrant.subjectType,
            accessGrant.subjectId,
            accessGrant.permission,
          ],
        })
    }
  }
}
