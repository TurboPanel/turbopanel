import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import {
  getColocatedDaemonHostname,
  getColocatedDaemonServerId,
} from '../daemon-hub.ts'
import {
  access,
  account,
  member,
  teammate,
  organization,
  role,
  server,
  setting,
  team,
  user,
} from '../db/schema.ts'
import { registerResource } from '../authz/resource-registry.ts'
import { ensureServerResource } from '../server-registry.ts'
import { createLicense } from './license.ts'
import { hashPassword } from './password.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'

const ORG_NAME_RE = /^[A-Za-z0-9 ._-]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const DEFAULT_ORGANIZATION_NAME = 'Default Organization'
export const DEFAULT_TEAM_NAME = 'Default Team'

export const IS_SIGNUP_ENABLED_CONFIG_KEY = 'IS_SIGNUP_ENABLED'

/** Env override wins; otherwise true only when the DB setting is `'1'`. */
export function resolveIsSignupEnabled(
  dbValue: string | null | undefined,
  envOverride: string | undefined,
): boolean {
  if (envOverride !== undefined) {
    const normalized = envOverride.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true') return true
  }
  return dbValue === '1'
}

export type InstallStatus = {
  needsInstall: boolean
  isInstallMode: boolean
  isSignupEnabled: boolean
}

function nowTs(): string {
  return new Date().toISOString()
}

function resolveColocatedDaemonStateDir(): string {
  if (typeof Deno === 'undefined') return '/etc/turbopanel/platform/daemon'
  const fromEnv = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')?.trim()
  return fromEnv && fromEnv.length > 0
    ? fromEnv
    : '/etc/turbopanel/platform/daemon'
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

export async function isSignupEnabled(
  db: Db,
  envOverride?: string,
): Promise<boolean> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, IS_SIGNUP_ENABLED_CONFIG_KEY))
    .limit(1)

  return resolveIsSignupEnabled(rows[0]?.value, envOverride)
}

export async function getInstallStatus(
  db: Db,
  envOverride?: string,
): Promise<InstallStatus> {
  // Sequential: parallel drizzle queries on postgres.js can wedge the pool (Deno dev).
  const installed = await isInstanceInstalled(db)
  const signupEnabled = await isSignupEnabled(db, envOverride)
  const needsInstall = !installed
  return {
    needsInstall,
    isInstallMode: needsInstall,
    isSignupEnabled: signupEnabled,
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

async function readLocalMachineId(): Promise<string | undefined> {
  if (typeof Deno === 'undefined') return undefined
  try {
    const id = await Deno.readTextFile('/etc/machine-id')
    const trimmed = id.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

/** Default org created by the self-hosted install wizard (superadmin's org). */
async function findDefaultInstalledOrganizationId(
  db: Db,
): Promise<string | null> {
  const byName = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.displayName, DEFAULT_ORGANIZATION_NAME))
    .limit(1)
  if (byName[0]?.id) return byName[0].id

  const withSuperadmin = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(user.role, SUPERADMIN_ROLE))
    .limit(1)
  if (withSuperadmin[0]?.organizationId) return withSuperadmin[0].organizationId

  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(isNotNull(organization.displayName))
    .limit(1)

  return rows[0]?.id ?? null
}

/**
 * Resolve the co-located server row id from the live hub or persisted daemon
 * metadata (machineId / hostname). Used when the hub is empty during install
 * or right after an instance restart.
 */
export async function resolveColocatedServerId(db: Db): Promise<string | null> {
  const fromHub = getColocatedDaemonServerId()
  if (fromHub) return fromHub

  const machineId = await readLocalMachineId()
  if (machineId) {
    const byMachine = await db
      .select({ id: server.id })
      .from(server)
      .where(and(
        isNull(server.organizationId),
        isNull(server.deletedAt),
        sql`${server.metadata}->>'machineId' = ${machineId}`,
      ))
      .limit(1)
    if (byMachine[0]?.id) return byMachine[0].id
  }

  const hostname = getColocatedDaemonHostname()
  if (hostname) {
    const byHostname = await db
      .select({ id: server.id })
      .from(server)
      .where(and(
        isNull(server.organizationId),
        isNull(server.deletedAt),
        sql`${server.metadata}->>'hostname' = ${hostname}`,
      ))
      .limit(1)
    if (byHostname[0]?.id) return byHostname[0].id
  }

  // Self-hosted Deno co-located dev: a single unassigned row is this host.
  if (typeof Deno !== 'undefined') {
    const unassigned = await db
      .select({ id: server.id })
      .from(server)
      .where(and(isNull(server.organizationId), isNull(server.deletedAt)))
    if (unassigned.length === 1 && unassigned[0]?.id) {
      return unassigned[0].id
    }
  }

  return null
}

/** Assign the co-located daemon to the default installed organization when possible. */
export async function tryAssignColocatedDaemonToInstalledOrganization(
  db: Db,
): Promise<void> {
  const organizationId = await findDefaultInstalledOrganizationId(db)
  if (!organizationId) return

  await assignColocatedDaemonToOrganization(db, organizationId)
}

export async function assignColocatedDaemonToOrganization(
  db: Db,
  organizationId: string,
): Promise<boolean> {
  const serverId = await resolveColocatedServerId(db)
  if (!serverId) {
    console.log(
      '[install] colocated server not found yet — will assign on daemon connect',
    )
    return false
  }

  const updated = await db
    .update(server)
    .set({ organizationId, updatedAt: nowTs() })
    .where(and(eq(server.id, serverId), isNull(server.organizationId)))
    .returning({ id: server.id })

  const assignedRows = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  const assignedOrgId = assignedRows[0]?.organizationId
  if (assignedOrgId) {
    await ensureServerResource(db, serverId, assignedOrgId)
  }

  if (updated.length > 0) {
    console.log(
      `[install] assigned colocated server ${serverId} to organization ${organizationId}`,
    )
    return true
  }

  return assignedOrgId != null
}

export type CompleteInstallInput = {
  superadminEmail: string
  superadminPassword: string
}

export async function completeInstanceInstall(
  db: Db,
  input: CompleteInstallInput,
): Promise<{ organizationId: string; userId: string; licenseId: string }> {
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
    })

    await tx.insert(teammate).values({
      teamId,
      userId,
    })

    const resourceId = await registerResource(tx, {
      kind: 'organization',
      itemId: organizationId,
      organizationId,
    })

    const ownerRoleRows = await tx
      .select({ id: role.id })
      .from(role)
      .where(eq(role.key, 'owner'))
      .limit(1)

    const ownerRoleId = ownerRoleRows[0]?.id
    if (!ownerRoleId) {
      throw new Error('Owner role not found in catalog')
    }

    await tx.insert(access).values({
      subjectKind: 'user',
      subjectId: userId,
      resourceId,
      effect: 'allow',
      roleId: ownerRoleId,
      permissionId: null,
    })

    const { licenseId, licenseToken } = await createLicense(tx, {
      organizationId,
      displayName: 'Colocated server',
    })

    return { organizationId, userId, licenseId, licenseToken }
  })

  await assignColocatedDaemonToOrganization(db, result.organizationId)

  if (typeof Deno !== 'undefined') {
    try {
      const stateDir = resolveColocatedDaemonStateDir()
      await Deno.writeTextFile(`${stateDir}/license.id`, result.licenseId, {
        create: true,
      })
      await Deno.writeTextFile(
        `${stateDir}/license.token`,
        result.licenseToken,
        { create: true },
      )
    } catch (err) {
      console.warn(
        '[install] failed to write license credentials to disk:',
        err,
      )
    }
  }

  return {
    organizationId: result.organizationId,
    userId: result.userId,
    licenseId: result.licenseId,
  }
}
