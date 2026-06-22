import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant, user } from '../../lib/db/schema.ts'
import { can } from './evaluator.ts'

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

async function hasOrganizationGrant(
  db: Db,
  userId: string,
  organizationId: string,
  permission: 'organization:own' | 'organization:manage',
): Promise<boolean> {
  const rows = await db
    .select({ id: grant.id })
    .from(grant)
    .where(
      and(
        eq(grant.subjectType, 'user'),
        eq(grant.subjectId, userId),
        eq(grant.entityType, 'organization'),
        eq(grant.entityId, organizationId),
        eq(grant.permission, permission),
        eq(grant.allowed, true),
      ),
    )
    .limit(1)
  return rows.length > 0
}

async function hasTeamGrant(
  db: Db,
  userId: string,
  teamId: string,
  permission: 'team:own' | 'team:manage',
): Promise<boolean> {
  const rows = await db
    .select({ id: grant.id })
    .from(grant)
    .where(
      and(
        eq(grant.subjectType, 'user'),
        eq(grant.subjectId, userId),
        eq(grant.entityType, 'team'),
        eq(grant.entityId, teamId),
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
  if (role !== null && isPlatformAdmin({ id: userId, role })) return true
  return hasOrganizationGrant(db, userId, organizationId, 'organization:own')
}

export async function canManageOrganization(
  db: Db,
  userId: string,
  organizationId: string,
  userRole?: string | null,
): Promise<boolean> {
  const role = await resolveUserRole(db, userId, userRole)
  if (role !== null && isPlatformAdmin({ id: userId, role })) return true
  const [isOwner, isManager] = await Promise.all([
    can(db, userId, 'organization:own', 'organization', organizationId),
    can(db, userId, 'organization:manage', 'organization', organizationId),
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
  if (role !== null && isPlatformAdmin({ id: userId, role })) return true
  return hasTeamGrant(db, userId, teamId, 'team:own')
}

export async function canManageTeam(
  db: Db,
  userId: string,
  teamId: string,
  userRole?: string | null,
): Promise<boolean> {
  const role = await resolveUserRole(db, userId, userRole)
  if (role !== null && isPlatformAdmin({ id: userId, role })) return true
  if (await can(db, userId, 'team:own', 'team', teamId)) return true
  if (await can(db, userId, 'team:manage', 'team', teamId)) return true
  return (
    (await hasTeamGrant(db, userId, teamId, 'team:own')) ||
    (await hasTeamGrant(db, userId, teamId, 'team:manage'))
  )
}

export async function canInviteToTeam(
  db: Db,
  userId: string,
  teamId: string,
): Promise<boolean> {
  return canManageTeam(db, userId, teamId)
}

export async function assertNotLastOrgOwner(
  db: Db,
  organizationId: string,
  subjectId: string,
): Promise<void> {
  const rows = await db
    .select({ subjectId: grant.subjectId })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, 'organization'),
        eq(grant.entityId, organizationId),
        eq(grant.permission, 'organization:own'),
        eq(grant.allowed, true),
      ),
    )

  if (rows.length === 1 && rows[0]?.subjectId === subjectId) {
    throw new Error('Cannot remove the last owner of an organization')
  }
}

export async function assertNotLastTeamOwner(
  db: Db,
  teamId: string,
  subjectId: string,
): Promise<void> {
  const rows = await db
    .select({ subjectId: grant.subjectId })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, 'team'),
        eq(grant.entityId, teamId),
        eq(grant.permission, 'team:own'),
        eq(grant.allowed, true),
      ),
    )

  if (rows.length === 1 && rows[0]?.subjectId === subjectId) {
    throw new Error('Cannot remove the last owner of a team')
  }
}
