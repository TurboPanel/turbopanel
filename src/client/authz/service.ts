import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant, team, user } from '../../lib/db/schema.ts'
import { can } from './evaluator.ts'
import { type PermissionKey } from './catalog.ts'
import { resolveEntityOrganizationId } from './create-access-grant.ts'

export type PlatformUser = { id: string; role: string }

export function isSuperAdmin(u: PlatformUser): boolean {
  return u.role === 'superadmin'
}

export function isPlatformAdmin(u: PlatformUser): boolean {
  return u.role === 'admin' || u.role === 'superadmin'
}

async function fetchUserRole(db: Db, userId: string): Promise<string | null> {
  const rows = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return rows[0]?.role ?? null
}

async function resolveUserRole(
  db: Db,
  userId: string,
  userRole?: string | null,
): Promise<string | null> {
  return userRole === undefined ? fetchUserRole(db, userId) : userRole
}

async function fetchTeamOrganizationId(
  db: Db,
  teamId: string,
): Promise<string | null> {
  const rows = await db
    .select({ organizationId: team.organizationId })
    .from(team)
    .where(eq(team.id, teamId))
    .limit(1)
  return rows[0]?.organizationId ?? null
}

export async function hasGrant(
  db: Db,
  userId: string,
  permission: PermissionKey,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: grant.id })
    .from(grant)
    .where(
      and(
        eq(grant.subjectType, 'user'),
        eq(grant.subjectId, userId),
        eq(grant.entityType, entityType),
        eq(grant.entityId, entityId),
        eq(grant.permission, permission),
        eq(grant.allowed, true),
      ),
    )
    .limit(1)
  return rows.length > 0
}

export async function canOwnOrganization(
  db: Db,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const role = await fetchUserRole(db, userId)
  if (role !== null && isSuperAdmin({ id: userId, role })) return true
  return can(db, userId, 'organization:owner', 'organization', organizationId)
}

export async function canManageOrganization(
  db: Db,
  userId: string,
  organizationId: string,
  userRole?: string | null,
): Promise<boolean> {
  const role = await resolveUserRole(db, userId, userRole)
  if (role !== null && isSuperAdmin({ id: userId, role })) return true
  const [isOwner, isManager] = await Promise.all([
    can(db, userId, 'organization:owner', 'organization', organizationId),
    can(db, userId, 'organization:manager', 'organization', organizationId),
  ])
  return isOwner || isManager
}

export async function canInviteToOrganization(
  db: Db,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  return canManageOrganization(db, userId, organizationId)
}

export async function canOwnTeam(
  db: Db,
  userId: string,
  teamId: string,
  userRole?: string | null,
): Promise<boolean> {
  const role = await resolveUserRole(db, userId, userRole)
  if (role !== null && isSuperAdmin({ id: userId, role })) return true
  const orgId = await fetchTeamOrganizationId(db, teamId)
  if (!orgId) return false
  const [isTeamOwner, canManageOrg] = await Promise.all([
    can(db, userId, 'team:owner', 'team', teamId),
    canManageOrganization(db, userId, orgId, role),
  ])
  return isTeamOwner || canManageOrg
}

export async function canManageTeam(
  db: Db,
  userId: string,
  teamId: string,
  userRole?: string | null,
): Promise<boolean> {
  const role = await resolveUserRole(db, userId, userRole)
  if (role !== null && isSuperAdmin({ id: userId, role })) return true
  const orgId = await fetchTeamOrganizationId(db, teamId)
  if (!orgId) return false
  const [isTeamOwner, isTeamManager, canManageOrg] = await Promise.all([
    can(db, userId, 'team:owner', 'team', teamId),
    can(db, userId, 'team:manager', 'team', teamId),
    canManageOrganization(db, userId, orgId, role),
  ])
  return isTeamOwner || isTeamManager || canManageOrg
}

export async function canInviteToTeam(
  db: Db,
  userId: string,
  teamId: string,
): Promise<boolean> {
  return canManageTeam(db, userId, teamId)
}

export type GrantSpec = {
  entityType: string
  entityId: string
  permission: PermissionKey
}

export async function canAssignGrant(
  db: Db,
  userId: string,
  grantSpec: GrantSpec,
  userRole?: string | null,
): Promise<boolean> {
  const role = await resolveUserRole(db, userId, userRole)
  if (role !== null && isSuperAdmin({ id: userId, role })) return true

  if (grantSpec.entityType === 'organization') {
    return canManageOrganization(db, userId, grantSpec.entityId, role)
  }

  if (grantSpec.entityType === 'team') {
    return canManageTeam(db, userId, grantSpec.entityId, role)
  }

  const orgId = await resolveEntityOrganizationId(
    db,
    grantSpec.entityType,
    grantSpec.entityId,
  )
  if (!orgId) return false

  const rwKey = `${grantSpec.entityType}:rw` as PermissionKey
  const [canManageOrg, canRw] = await Promise.all([
    canManageOrganization(db, userId, orgId, role),
    can(db, userId, rwKey, grantSpec.entityType, grantSpec.entityId),
  ])
  return canManageOrg || canRw
}

export async function assertNotLastOrgOwner(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<void> {
  const rows = await db
    .select({ subjectId: grant.subjectId })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, 'organization'),
        eq(grant.entityId, organizationId),
        eq(grant.permission, 'organization:owner'),
        eq(grant.allowed, true),
      ),
    )

  if (rows.length === 1 && rows[0]?.subjectId === userId) {
    throw new Error('Cannot remove the last owner of an organization')
  }
}
