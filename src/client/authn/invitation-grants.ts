import type { Db } from '../../db.ts'
import { grant } from '../../lib/db/schema.ts'
import { isPermissionKey, type PermissionKey } from '../authz/catalog.ts'
import {
  validateGrantEntityTarget,
  validatePermissionEntityCompatibility,
} from '../authz/create-access-grant.ts'

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
  permissionKey: string
}

export function defaultInvitationGrants(
  organizationId: string,
): InvitationGrantSpec[] {
  return [
    {
      entityType: 'organization',
      entityId: organizationId,
      permissionKey: 'organization:manage',
      allowed: true,
    },
  ]
}

function parseGrantTarget(
  record: Record<string, unknown>,
): Pick<InvitationGrantSpec, 'permissionKey'> | null {
  const permissionKey =
    typeof record.permissionKey === 'string' ? record.permissionKey : undefined

  if (!permissionKey) return null
  if (!isPermissionKey(permissionKey)) return null

  return { permissionKey }
}

function parseInvitationGrantEntry(
  entry: unknown,
): InvitationGrantSpec | null | 'invalid' {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'invalid'
  }
  const record = entry as Record<string, unknown>
  const entityType =
    typeof record.entityType === 'string' ? record.entityType : null
  const entityId =
    typeof record.entityId === 'string' ? record.entityId : null

  if (!entityType || !entityId) {
    return 'invalid'
  }

  const target = parseGrantTarget(record)
  if (!target) return 'invalid'

  if (record.allowed !== undefined && typeof record.allowed !== 'boolean') {
    return 'invalid'
  }

  return {
    entityType,
    entityId,
    permissionKey: target.permissionKey,
    ...(typeof record.allowed === 'boolean' ? { allowed: record.allowed } : {}),
  }
}

export function parseInvitationGrants(
  raw: unknown,
): InvitationGrantSpec[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) return null

  const grants: InvitationGrantSpec[] = []
  for (const entry of raw) {
    const parsed = parseInvitationGrantEntry(entry)
    if (parsed === 'invalid') return null
    if (parsed) grants.push(parsed)
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
  for (const grantSpec of grants) {
    const targetResult = await validateGrantEntityTarget(
      db,
      grantSpec.entityType,
      grantSpec.entityId,
      organizationId,
    )
    if (!targetResult.ok) {
      throw new InvitationGrantValidationError(targetResult.error, targetResult.status)
    }

    const permissionCompat = validatePermissionEntityCompatibility(
      grantSpec.permissionKey as PermissionKey,
      grantSpec.entityType,
    )
    if (!permissionCompat.ok) {
      throw new InvitationGrantValidationError(permissionCompat.error, 400)
    }

    const allow = grantSpec.allow ?? grantSpec.allowed ?? true

    await db
      .insert(grant)
      .values({
        entityType: grantSpec.entityType,
        entityId: grantSpec.entityId,
        actorType: 'user',
        actorId: userId,
        permission: grantSpec.permissionKey,
        allow,
      })
      .onConflictDoNothing({
        target: [
          grant.entityType,
          grant.entityId,
          grant.actorType,
          grant.actorId,
          grant.permission,
        ],
      })
  }
}
