import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { getColocatedDaemonServerId } from '../daemon-hub.ts'
import {
  account,
  member,
  mate,
  organization,
  server,
  team,
  user,
} from '../db/schema.ts'
import { hashPassword } from './password.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'

const ORG_NAME_RE = /^[A-Za-z0-9 ._-]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const DEFAULT_ORGANIZATION_NAME = 'Default Organization'
export const DEFAULT_TEAM_NAME = 'Default Team'

export type InstallStatus = {
  needsInstall: boolean
}

function nowTs(): string {
  return new Date().toISOString()
}

/** True once an org has a name and at least one superadmin account exists. */
export async function isInstanceInstalled(db: Db): Promise<boolean> {
  const orgRows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(isNotNull(organization.displayName))
    .limit(1)

  if (orgRows.length === 0) return false

  const adminRows = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.role, SUPERADMIN_ROLE))
    .limit(1)

  if (adminRows.length === 0) return false

  return true
}

export async function getInstallStatus(db: Db): Promise<InstallStatus> {
  return {
    needsInstall: !(await isInstanceInstalled(db)),
  }
}

export async function getUserOrganizationId(
  db: Db,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1)

  return rows[0]?.organizationId ?? null
}

export function validateOrganizationName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 255) {
    return 'Organization name must be 1–255 characters'
  }
  if (!ORG_NAME_RE.test(trimmed)) {
    return 'Organization name may only contain letters, numbers, spaces, and . _ -'
  }
  return null
}

export function validateTeamName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 255) {
    return 'Team name must be 1–255 characters'
  }
  return null
}

export function validateSuperadminEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase()
  if (trimmed.length < 3 || trimmed.length > 255) {
    return 'Email must be 3–255 characters'
  }
  if (!EMAIL_RE.test(trimmed)) {
    return 'Enter a valid email address'
  }
  return null
}

export function validateSuperadminPassword(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters'
  }
  return null
}

/** Assign the co-located daemon to the first installed organization when possible. */
export async function tryAssignColocatedDaemonToInstalledOrganization(
  db: Db,
): Promise<void> {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(isNotNull(organization.displayName))
    .limit(1)

  const organizationId = rows[0]?.id
  if (!organizationId) return

  await assignColocatedDaemonToOrganization(db, organizationId)
}

export async function assignColocatedDaemonToOrganization(
  db: Db,
  organizationId: string,
): Promise<void> {
  const serverId = getColocatedDaemonServerId()
  if (!serverId) return

  await db
    .update(server)
    .set({ organizationId, updatedAt: nowTs() })
    .where(and(eq(server.id, serverId), isNull(server.organizationId)))
}

export type CompleteInstallInput = {
  superadminEmail: string
  superadminPassword: string
}

export async function completeInstanceInstall(
  db: Db,
  input: CompleteInstallInput,
): Promise<{ organizationId: string; userId: string }> {
  if (await isInstanceInstalled(db)) {
    throw new Error('Instance is already configured')
  }

  const emailError = validateSuperadminEmail(input.superadminEmail)
  if (emailError) throw new Error(emailError)

  const passwordError = validateSuperadminPassword(input.superadminPassword)
  if (passwordError) throw new Error(passwordError)

  const trimmedOrgName = DEFAULT_ORGANIZATION_NAME
  const trimmedTeamName = DEFAULT_TEAM_NAME
  const trimmedEmail = input.superadminEmail.trim().toLowerCase()
  const hashedPassword = await hashPassword(input.superadminPassword)
  const now = nowTs()

  const existingUser = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, trimmedEmail))
    .limit(1)

  if (existingUser.length > 0) {
    throw new Error('Email is already registered')
  }

  const result = await db.transaction(async (tx) => {
    const insertedOrg = await tx
      .insert(organization)
      .values({
        displayName: trimmedOrgName,
      })
      .returning({ id: organization.id })

    const organizationId = insertedOrg[0]?.id
    if (!organizationId) {
      throw new Error('Organization creation failed')
    }

    const insertedTeam = await tx
      .insert(team)
      .values({
        organizationId,
        displayName: trimmedTeamName,
      })
      .returning({ id: team.id })

    const teamId = insertedTeam[0]?.id
    if (!teamId) {
      throw new Error('Team creation failed')
    }

    const insertedUser = await tx
      .insert(user)
      .values({
        email: trimmedEmail,
        isEmailVerified: true,
        role: SUPERADMIN_ROLE,
      })
      .returning({ id: user.id })

    const userId = insertedUser[0]?.id
    if (!userId) {
      throw new Error('Superadmin creation failed')
    }

    await tx.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: hashedPassword,
    })

    await tx.insert(member).values({
      organizationId,
      userId,
      role: 'owner',
    })

    await tx.insert(mate).values({
      teamId,
      userId,
    })

    return { organizationId, userId }
  })

  await assignColocatedDaemonToOrganization(db, result.organizationId)

  return result
}
