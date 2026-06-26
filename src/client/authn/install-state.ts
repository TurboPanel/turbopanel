import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { isMissingRelationError } from '../../db-errors.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import {
  grant,
  account,
  member,
  teammate,
  organization,
  license,
  server,
  setting,
  team,
  user,
} from '../../lib/db/schema.ts'
import { createLicense } from './license.ts'
import { hashPassword } from './password.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'
import { compatLogInfo, compatLogWarn } from '../../log-compat.ts'

const ORG_NAME_RE = /^[A-Za-z0-9 ._-]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const DEFAULT_ORGANIZATION_NAME = 'Default Organization'
export const DEFAULT_TEAM_NAME = 'Default Team'
export const COLOCATED_SERVER_DISPLAY_NAME = 'this server'

export const IS_SIGNUP_ENABLED_CONFIG_KEY = 'IS_SIGNUP_ENABLED'
export const IS_SIGNUP_EMAIL_VERIFICATION_ENABLED_CONFIG_KEY =
  'IS_SIGNUP_EMAIL_VERIFICATION_ENABLED'

/** Wrangler / platform env bindings may arrive as strings, numbers, or booleans. */
export type SignupEnvOverride = string | number | boolean | null | undefined

/** Normalize signup env bindings to a trimmed string flag, or `undefined` when unset. */
export function normalizeSignupEnvOverride(
  value: SignupEnvOverride,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return String(Math.trunc(value))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  return undefined
}

/**
 * Env override wins when it is a recognized enable/disable flag; otherwise the DB
 * setting applies. On Workers, sign-up defaults to enabled when both are unset so
 * fresh deployments can bootstrap via public sign-up (no Deno install wizard).
 */
export function resolveIsSignupEnabled(
  dbValue: string | null | undefined,
  envOverride: SignupEnvOverride,
  options?: { runtime?: 'deno' | 'workers' },
): boolean {
  const normalizedEnv = normalizeSignupEnvOverride(envOverride)
  if (normalizedEnv !== undefined) {
    const flag = normalizedEnv.toLowerCase()
    if (flag === '1' || flag === 'true') return true
    if (flag === '0' || flag === 'false') return false
  }
  if (dbValue === '1') return true
  if (dbValue === '0') return false
  if (options?.runtime === 'workers') return true
  return false
}

/**
 * Env override wins when it is a recognized enable/disable flag; otherwise the DB
 * setting applies. On Workers, email verification defaults to enabled when both are
 * unset. Self-hosted Deno defaults to disabled when email may not be configured.
 */
export function resolveIsSignupEmailVerificationEnabled(
  dbValue: string | null | undefined,
  envOverride: SignupEnvOverride,
  options?: { runtime?: 'deno' | 'workers' },
): boolean {
  const normalizedEnv = normalizeSignupEnvOverride(envOverride)
  if (normalizedEnv !== undefined) {
    const flag = normalizedEnv.toLowerCase()
    if (flag === '1' || flag === 'true') return true
    if (flag === '0' || flag === 'false') return false
  }
  if (dbValue === '1') return true
  if (dbValue === '0') return false
  if (options?.runtime === 'workers') return true
  return false
}

export type InstallStatus = {
  needsInstall: boolean
  isInstallMode: boolean
  isSignupEnabled: boolean
  isSignupEmailVerificationEnabled: boolean
}

function nowTs(): string {
  return new Date().toISOString()
}

export async function insertOwnerGrants(
  db: Db,
  userId: string,
  organizationId: string,
): Promise<void> {
  await db
    .insert(grant)
    .values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'organization:own',
      allow: true,
    })
    .onConflictDoNothing({
      target: [
        grant.entityType,
        grant.entityId,
        grant.subjectType,
        grant.subjectId,
        grant.permission,
      ],
    })
}

const DEFAULT_DAEMON_STATE_DIR = '/opt/turbopanel/platform/daemon/state'

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

/** Daemon enrollment credentials always live under the canonical state dir. */
function resolveColocatedLicenseCredentialsDir(): string {
  return DEFAULT_DAEMON_STATE_DIR
}

/** True once an org has a name and at least one superadmin account exists. */
export async function isInstanceInstalled(db: Db): Promise<boolean> {
  try {
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
  } catch (err) {
    if (isMissingRelationError(err)) return false
    throw err
  }
}

export async function isSignupEnabled(
  db: Db,
  envOverride?: SignupEnvOverride,
  runtime: 'deno' | 'workers' = 'deno',
): Promise<boolean> {
  try {
    const rows = await db
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, IS_SIGNUP_ENABLED_CONFIG_KEY))
      .limit(1)

    const raw = rows[0]?.value
    const dbValue =
      typeof raw === 'string' ? raw : raw != null ? String(raw) : null
    return resolveIsSignupEnabled(dbValue, envOverride, { runtime })
  } catch (err) {
    if (isMissingRelationError(err)) {
      return resolveIsSignupEnabled(undefined, envOverride, { runtime })
    }
    throw err
  }
}

export async function isSignupEmailVerificationEnabled(
  db: Db,
  envOverride?: SignupEnvOverride,
  runtime: 'deno' | 'workers' = 'deno',
): Promise<boolean> {
  try {
    const rows = await db
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, IS_SIGNUP_EMAIL_VERIFICATION_ENABLED_CONFIG_KEY))
      .limit(1)

    const raw = rows[0]?.value
    const dbValue =
      typeof raw === 'string' ? raw : raw != null ? String(raw) : null
    return resolveIsSignupEmailVerificationEnabled(dbValue, envOverride, {
      runtime,
    })
  } catch (err) {
    if (isMissingRelationError(err)) {
      return resolveIsSignupEmailVerificationEnabled(undefined, envOverride, {
        runtime,
      })
    }
    throw err
  }
}

export async function getInstallStatus(
  db: Db,
  envOverride?: SignupEnvOverride,
  emailVerificationEnvOverride?: SignupEnvOverride,
): Promise<InstallStatus> {
  // Sequential: parallel drizzle queries on postgres.js can wedge the pool (Deno dev).
  const installed = await isInstanceInstalled(db)
  const signupEnabled = await isSignupEnabled(db, envOverride)
  const emailVerificationEnabled = await isSignupEmailVerificationEnabled(
    db,
    emailVerificationEnvOverride,
  )
  const needsInstall = !installed
  return {
    needsInstall,
    isInstallMode: needsInstall,
    isSignupEnabled: signupEnabled,
    isSignupEmailVerificationEnabled: emailVerificationEnabled,
  }
}

export type DenoClientPublicStatus = InstallStatus & { ok: true }

export type WorkersClientPublicStatus = {
  ok: true
  isSignupEnabled: boolean
  isSignupEmailVerificationEnabled: boolean
}

export type ClientPublicStatus = DenoClientPublicStatus | WorkersClientPublicStatus

/** Public client status for GET /api/client/v1/status (both runtimes). */
export async function getClientPublicStatus(
  db: Db | undefined,
  runtime: 'deno' | 'workers',
  envOverride?: SignupEnvOverride,
  emailVerificationEnvOverride?: SignupEnvOverride,
): Promise<ClientPublicStatus | null> {
  if (runtime === 'workers') {
    if (db === undefined) {
      return {
        ok: true,
        isSignupEnabled: resolveIsSignupEnabled(undefined, envOverride, {
          runtime: 'workers',
        }),
        isSignupEmailVerificationEnabled: resolveIsSignupEmailVerificationEnabled(
          undefined,
          emailVerificationEnvOverride,
          { runtime: 'workers' },
        ),
      }
    }
    const signupEnabled = await isSignupEnabled(db, envOverride, 'workers')
    const emailVerificationEnabled = await isSignupEmailVerificationEnabled(
      db,
      emailVerificationEnvOverride,
      'workers',
    )
    return {
      ok: true,
      isSignupEnabled: signupEnabled,
      isSignupEmailVerificationEnabled: emailVerificationEnabled,
    }
  }

  if (db === undefined) {
    return null
  }

  const status = await getInstallStatus(db, envOverride, emailVerificationEnvOverride)
  return { ok: true, ...status }
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

async function findColocatedServerIdFromRegistry(
  db: Db,
  registry: DaemonCellRegistry,
): Promise<string | null> {
  const onlineIds = await registry.listOnlineServerIds()
  if (onlineIds.length === 0) return null
  const presence = await resolveFleetPresence(db, registry, onlineIds)
  for (const id of onlineIds) {
    const live = presence.get(id)
    if (live?.directAttach && live.connected) {
      return id
    }
  }
  return null
}

async function findColocatedHostnameFromRegistry(
  db: Db,
  registry: DaemonCellRegistry,
): Promise<string | null> {
  const onlineIds = await registry.listOnlineServerIds()
  if (onlineIds.length === 0) return null
  const presence = await resolveFleetPresence(db, registry, onlineIds)
  for (const id of onlineIds) {
    const live = presence.get(id)
    if (live?.directAttach && live.connected && live.hostname) {
      return live.hostname
    }
  }
  return null
}

/**
 * Resolve the co-located server row id from the live cell registry or persisted
 * daemon metadata (machineId / hostname). Used when no daemon is connected
 * during install or right after an instance restart.
 */
export async function resolveColocatedServerId(
  db: Db,
  registry?: DaemonCellRegistry,
): Promise<string | null> {
  if (registry) {
    const fromRegistry = await findColocatedServerIdFromRegistry(db, registry)
    if (fromRegistry) return fromRegistry
  }

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

  let hostname: string | null = null
  if (registry) {
    hostname = await findColocatedHostnameFromRegistry(db, registry)
  }
  if (!hostname && typeof Deno !== 'undefined') {
    try {
      hostname = Deno.hostname()
    } catch {
      // hostname unavailable without --allow-sys=hostname
    }
  }
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

const COLOCATED_LICENSE_REVOKE_ERROR =
  'The license for the co-located control plane daemon cannot be revoked'

async function readColocatedDiskLicenseId(): Promise<string | null> {
  if (typeof Deno === 'undefined') return null

  const candidates = [resolveColocatedLicenseCredentialsDir()]
  const instanceStateOverride = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')?.trim()
  if (instanceStateOverride) {
    const normalized = stripTrailingSlash(instanceStateOverride)
    candidates.push(normalized, `${normalized}/state`)
  }

  for (const dir of candidates) {
    try {
      const id = (await Deno.readTextFile(`${dir}/license.id`)).trim()
      if (id.length > 0) return id
    } catch {
      // try next candidate path
    }
  }

  return null
}

/**
 * Licenses tied to the Unix-socket co-located daemon are not revocable — revoking
 * would break the local control plane and dev stack.
 */
export async function resolveProtectedColocatedLicenseIds(
  db: Db,
  registry?: DaemonCellRegistry,
  organizationId?: string,
): Promise<Set<string>> {
  const ids = new Set<string>()
  if (typeof Deno === 'undefined') return ids

  if (registry) {
    const colocatedServerId = await findColocatedServerIdFromRegistry(db, registry)
    if (colocatedServerId) {
      const rows = await db
        .select({ licenseId: server.licenseId })
        .from(server)
        .where(eq(server.id, colocatedServerId))
        .limit(1)
      const licenseId = rows[0]?.licenseId
      if (licenseId != null) {
        ids.add(licenseId)
        return ids
      }
    }
  }

  const diskId = await readColocatedDiskLicenseId()
  if (diskId) ids.add(diskId)

  if (organizationId) {
    const installLicense = await db
      .select({ id: license.id })
      .from(license)
      .where(and(
        eq(license.organizationId, organizationId),
        eq(license.displayName, COLOCATED_SERVER_DISPLAY_NAME),
        isNull(license.revokedAt),
      ))
      .limit(1)
    if (installLicense[0]?.id) ids.add(installLicense[0].id)
  }

  return ids
}

export async function isProtectedColocatedLicenseId(
  db: Db,
  licenseId: string,
  registry?: DaemonCellRegistry,
  organizationId?: string,
): Promise<boolean> {
  const protectedIds = await resolveProtectedColocatedLicenseIds(
    db,
    registry,
    organizationId,
  )
  return protectedIds.has(licenseId)
}

export function colocatedLicenseRevokeError(): string {
  return COLOCATED_LICENSE_REVOKE_ERROR
}

/** Assign the co-located daemon to the default installed organization when possible. */
export async function tryAssignColocatedDaemonToInstalledOrganization(
  db: Db,
  registry?: DaemonCellRegistry,
): Promise<void> {
  const organizationId = await findDefaultInstalledOrganizationId(db)
  if (!organizationId) return

  await assignColocatedDaemonToOrganization(db, organizationId, registry)
}

export async function assignColocatedDaemonToOrganization(
  db: Db,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<boolean> {
  const serverId = await resolveColocatedServerId(db, registry)
  if (!serverId) {
    compatLogInfo(
      'install',
      'colocated server not found yet — will assign on daemon connect',
    )
    return false
  }

  const now = nowTs()
  await db
    .update(server)
    .set({
      displayName: sql`coalesce(${server.displayName}, ${COLOCATED_SERVER_DISPLAY_NAME})`,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))

  const updated = await db
    .update(server)
    .set({ organizationId, updatedAt: now })
    .where(and(eq(server.id, serverId), isNull(server.organizationId)))
    .returning({ id: server.id })

  const assignedRows = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  const assignedOrgId = assignedRows[0]?.organizationId

  if (updated.length > 0) {
    compatLogInfo(
      'install',
      `assigned colocated server ${serverId} to organization ${organizationId}`,
    )
    return true
  }

  return assignedOrgId != null
}

export type CompleteInstallInput = {
  superadminEmail: string
  superadminPassword: string
}

/** Write colocated daemon license files for enrollment (self-hosted Deno only). */
export async function persistColocatedLicenseCredentials(
  licenseId: string,
  licenseToken: string,
): Promise<boolean> {
  if (typeof Deno === 'undefined') return false

  try {
    const stateDir = resolveColocatedLicenseCredentialsDir()
    await Deno.mkdir(stateDir, { recursive: true })
    await Deno.writeTextFile(`${stateDir}/license.id`, licenseId, {
      create: true,
    })
    await Deno.writeTextFile(`${stateDir}/license.token`, licenseToken, {
      create: true,
    })
    return true
  } catch (err) {
    compatLogWarn(
      'install',
      `failed to write license credentials to disk: ${err}`,
    )
    return false
  }
}

/**
 * After a partial install (DB configured but license files missing), mint a
 * fresh colocated license and persist it so the daemon can enroll.
 */
export async function ensureColocatedLicenseCredentialsOnDisk(
  db: Db,
): Promise<void> {
  if (typeof Deno === 'undefined') return

  const stateDir = resolveColocatedLicenseCredentialsDir()
  try {
    const licenseId = (await Deno.readTextFile(`${stateDir}/license.id`)).trim()
    const licenseToken = (await Deno.readTextFile(`${stateDir}/license.token`))
      .trim()
    if (licenseId.length > 0 && licenseToken.length > 0) return
  } catch {
    // Missing or unreadable — recover below when installed.
  }

  if (!(await isInstanceInstalled(db))) return

  const organizationId = await findDefaultInstalledOrganizationId(db)
  if (!organizationId) return

  const { licenseId, licenseToken } = await createLicense(db, {
    organizationId,
    displayName: COLOCATED_SERVER_DISPLAY_NAME,
  })
  await persistColocatedLicenseCredentials(licenseId, licenseToken)
  compatLogInfo(
    'install',
    'restored colocated license credentials on disk after partial install',
  )
}

export async function createOrganizationForUser(
  db: Db,
  userId: string,
  orgName?: string,
): Promise<{ organizationId: string; teamId: string }> {
  const displayName = orgName?.trim() || DEFAULT_ORGANIZATION_NAME

  return await db.transaction(async (tx) => {
    const insertedOrg = await tx
      .insert(organization)
      .values({
        displayName,
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
        displayName: DEFAULT_TEAM_NAME,
      })
      .returning({ id: team.id })

    const teamId = insertedTeam[0]?.id
    if (!teamId) {
      throw new Error('Team creation failed')
    }

    await tx.insert(member).values({
      organizationId,
      userId,
    })

    await tx.insert(teammate).values({
      teamId,
      userId,
    })

    await insertOwnerGrants(tx, userId, organizationId)

    await tx
      .insert(grant)
      .values({
        entityType: 'team',
        entityId: teamId,
        subjectType: 'user',
        subjectId: userId,
        permission: 'team:own',
        allow: true,
      })
      .onConflictDoNothing({
        target: [
          grant.entityType,
          grant.entityId,
          grant.subjectType,
          grant.subjectId,
          grant.permission,
        ],
      })

    return { organizationId, teamId }
  })
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

    await insertOwnerGrants(tx, userId, organizationId)

    await tx
      .insert(grant)
      .values({
        entityType: 'team',
        entityId: teamId,
        subjectType: 'user',
        subjectId: userId,
        permission: 'team:own',
        allow: true,
      })
      .onConflictDoNothing({
        target: [
          grant.entityType,
          grant.entityId,
          grant.subjectType,
          grant.subjectId,
          grant.permission,
        ],
      })

    const { licenseId, licenseToken } = await createLicense(tx, {
      organizationId,
      displayName: COLOCATED_SERVER_DISPLAY_NAME,
    })

    return { organizationId, userId, licenseId, licenseToken }
  })

  await persistColocatedLicenseCredentials(
    result.licenseId,
    result.licenseToken,
  )

  await assignColocatedDaemonToOrganization(db, result.organizationId)

  return {
    organizationId: result.organizationId,
    userId: result.userId,
    licenseId: result.licenseId,
  }
}
