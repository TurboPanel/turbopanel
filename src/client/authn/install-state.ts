import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { DerivedSecretsConfig } from './secrets.ts'
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
  workspace,
} from '../../lib/db/schema.ts'
import {
  createLicense,
  generateLicenseToken,
  invalidateLicense,
} from './license.ts'
import { clearServerDaemonState } from '../../daemon/authn/server-identity-db.ts'
import { hashPassword } from './password.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'
import { compatLogInfo, compatLogWarn } from '../../log-compat.ts'
import {
  isEmailActiveForRuntime,
  resolveEmailSettings,
} from '../../lib/settings/email-settings.ts'
import { deriveMachineKey } from '../../lib/machine-key.ts'
import {
  ensureSelfHostSystemHierarchy,
  ensureSystemWorkspace,
  findSystemEnvironmentForServer,
  SYSTEM_SELF_HOST_COMPONENT,
} from '../system/hierarchy.ts'
import { WORKSPACE_KIND_USER } from '../../lib/db/workspace-kind.ts'

const ORG_NAME_RE = /^[A-Za-z0-9 ._-]+$/

/** Linear-time check matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` without backtracking. */
function isSimpleEmailShape(email: string): boolean {
  const at = email.indexOf('@')
  if (at <= 0 || email.includes('@', at + 1)) return false
  const domain = email.slice(at + 1)
  const dot = domain.indexOf('.')
  if (dot <= 0 || dot === domain.length - 1) return false
  for (const ch of email) {
    if (ch === '@') continue
    // `trim()` empty means whitespace — same intent as `[^\s@]` without a regex.
    if (ch.trim() === '') return false
  }
  return true
}

export const DEFAULT_ORGANIZATION_NAME = 'Default Organization'
export const DEFAULT_TEAM_NAME = 'Default Team'
export const DEFAULT_WORKSPACE_NAME = 'Default Workspace'
export const COLOCATED_SERVER_DISPLAY_NAME = 'this server'

export const IS_SIGNUP_ENABLED_CONFIG_KEY = 'IS_SIGNUP_ENABLED'

/**
 * Reserved `setting.key` used as a **unique install sentinel** so initial setup
 * cannot race into creating multiple superadmins/organizations. It relies on the
 * `setting_key_unique` constraint: the first `completeInstanceInstall()`
 * transaction inserts this key, and any concurrent install transaction blocks on
 * that key until the first commits, then observes the conflict (no returned row)
 * and aborts. No schema migration is required — the row lives in the existing
 * `setting` table. See `src/lib/db/AGENTS.md` (Install sentinel invariant).
 */
export const INSTANCE_INSTALL_SENTINEL_KEY = 'INSTANCE_INSTALL_SENTINEL'

/** Thrown when initial install is attempted but the instance is already configured. */
export const INSTANCE_ALREADY_CONFIGURED_ERROR = 'Instance is already configured'

/** Wrangler / platform env bindings may arrive as strings, numbers, or booleans. */
export type SignupEnvOverride = string | number | boolean | null

/** Normalize signup env bindings to a trimmed string flag, or `undefined` when unset. */
export function normalizeSignupEnvOverride(
  value: SignupEnvOverride | undefined,
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
 * Prefer the per-request `platformEnv` binding (Workers dashboard / Deno process
 * env) over a value captured at `createApp()` init so force-enable/disable takes
 * effect without waiting for an isolate recycle.
 */
export function resolveSignupEnvOverrideFromContext(
  platformEnv: Record<string, string | undefined> | undefined,
  fallback?: SignupEnvOverride,
): SignupEnvOverride | undefined {
  const fromPlatform = normalizeSignupEnvOverride(
    platformEnv?.TURBOPANEL_IS_SIGNUP_ENABLED,
  )
  if (fromPlatform !== undefined) return fromPlatform
  return fallback
}

/**
 * Resolve whether public sign-up is enabled from a DB value and optional env
 * force override.
 *
 * **Env overrides the database** when set to a recognized force-enable
 * (`1` / `true`) or force-disable (`0` / `false`) flag — use
 * `TURBOPANEL_IS_SIGNUP_ENABLED` only for explicit operational force behavior
 * (e.g. permanently open a testing env). Unrecognized / unset env values do
 * not override.
 *
 * When no force override is configured, the `IS_SIGNUP_ENABLED` database
 * setting wins so a panel toggle can open or close sign-up without a code
 * deploy. When both env and DB are unset, sign-up defaults to **disabled**
 * on every runtime (including Workers).
 */
export function resolveIsSignupEnabled(
  dbValue: string | null | undefined,
  envOverride?: SignupEnvOverride,
  _options?: { runtime?: 'deno' | 'workers' },
): boolean {
  const normalizedEnv = normalizeSignupEnvOverride(envOverride)
  if (normalizedEnv !== undefined) {
    const flag = normalizedEnv.toLowerCase()
    if (flag === '1' || flag === 'true') return true
    if (flag === '0' || flag === 'false') return false
  }
  if (dbValue === '1') return true
  if (dbValue === '0') return false
  return false
}

/**
 * Config guard: the Workers **live** environment must not force-enable public
 * sign-up via `TURBOPANEL_IS_SIGNUP_ENABLED` in git. Live should leave the var
 * unset in `wrangler.jsonc` (set it only in the Cloudflare dashboard;
 * `keep_vars` preserves it). Pass `allowForceEnable: true` only for
 * deliberate test-only fixtures — never for production `env.live` parsing.
 */
export function assertLiveSignupNotForceEnabled(
  liveSignupVar: SignupEnvOverride | undefined,
  options?: { allowForceEnable?: boolean },
): void {
  if (options?.allowForceEnable) return
  const normalized = normalizeSignupEnvOverride(liveSignupVar)
  if (normalized === undefined) return
  const flag = normalized.toLowerCase()
  if (flag === '1' || flag === 'true') {
    throw new Error(
      'env.live must not commit TURBOPANEL_IS_SIGNUP_ENABLED as a force-enable; leave it unset in wrangler.jsonc and open sign-up via the Cloudflare dashboard',
    )
  }
}

/**
 * Read `env.live.vars.TURBOPANEL_IS_SIGNUP_ENABLED` from wrangler.jsonc text
 * (JSONC line comments stripped). Returns `undefined` when the live env or
 * the var is absent.
 */
export function readLiveSignupEnvOverrideFromWranglerJsonc(
  wranglerText: string,
): string | undefined {
  // Local import avoids a hard dependency cycle with workers-bindings helpers.
  const withoutComments = wranglerText
    .split('\n')
    .map((line) => {
      const commentAt = line.indexOf('//')
      return commentAt < 0 ? line : line.slice(0, commentAt)
    })
    .join('\n')
  const liveMatch = /"live"\s*:\s*\{/.exec(withoutComments)
  if (!liveMatch) return undefined
  const liveBlock = withoutComments.slice(liveMatch.index)
  const varsMatch = /"vars"\s*:\s*\{/.exec(liveBlock)
  if (!varsMatch) return undefined
  const varsStart = varsMatch.index + varsMatch[0].length
  // Find matching closing brace for the vars object.
  let depth = 1
  let i = varsStart
  while (i < liveBlock.length && depth > 0) {
    const ch = liveBlock[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    i += 1
  }
  const varsBody = liveBlock.slice(varsStart, i - 1)
  const valueMatch =
    /"TURBOPANEL_IS_SIGNUP_ENABLED"\s*:\s*"([^"]*)"/.exec(varsBody)
  if (!valueMatch) return undefined
  const trimmed = valueMatch[1].trim()
  return trimmed.length > 0 ? trimmed : undefined
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
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
      allow: true,
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

/** Insert the org's initial user workspace. Call inside the same transaction as org create. */
export async function insertDefaultWorkspace(
  db: Db,
  organizationId: string,
): Promise<string> {
  const inserted = await db
    .insert(workspace)
    .values({
      organizationId,
      name: DEFAULT_WORKSPACE_NAME,
      kind: WORKSPACE_KIND_USER,
    })
    .returning({ id: workspace.id })

  const workspaceId = inserted[0]?.id
  if (!workspaceId) {
    throw new Error('Default workspace creation failed')
  }
  return workspaceId
}

/** Production FHS state dir for persistent daemon identity (dev and managed). */
const DEFAULT_DAEMON_STATE_DIR = '/var/lib/turbopanel'

function stripTrailingSlash(path: string): string {
  let end = path.length
  while (end > 0 && (path.codePointAt(end - 1) ?? 0) === 47) {
    end--
  }
  return end === 0 ? '/' : path.slice(0, end)
}

/**
 * Resolve the directory that holds co-located daemon enrollment credentials
 * (`license.id` / `license.token`).
 *
 * Mirrors the daemon's `resolveServerIdentityDir` precedence: honor
 * `TURBOPANEL_DAEMON_STATE_DIR` (injected by `instance-launch`), then
 * `TURBOPANEL_STATE_DIR`, else the FHS default (`/var/lib/turbopanel`).
 */
const COLOCATED_DAEMON_IDENTITY_FILES = [
  'server.id',
  'server-key.json',
  'server-key-id',
] as const

/** Drop stale on-disk daemon identity so a fresh install always re-enrolls. */
export async function clearColocatedDaemonIdentityFiles(): Promise<void> {
  if (typeof Deno === 'undefined') return

  const stateDir = resolveColocatedLicenseCredentialsDir()
  for (const file of COLOCATED_DAEMON_IDENTITY_FILES) {
    try {
      await Deno.remove(`${stateDir}/${file}`)
    } catch {
      // Missing files are fine.
    }
  }
}

function resolveColocatedLicenseCredentialsDir(): string {
  if (typeof Deno !== 'undefined') {
    const daemonStateOverride = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')?.trim()
    if (daemonStateOverride) return stripTrailingSlash(daemonStateOverride)

    const stateOverride = Deno.env.get('TURBOPANEL_STATE_DIR')?.trim()
    if (stateOverride) return stripTrailingSlash(stateOverride)
  }
  return DEFAULT_DAEMON_STATE_DIR
}

/** True once an org has a name and at least one superadmin account exists. */
export async function isInstanceInstalled(db: Db): Promise<boolean> {
  const orgRows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(isNotNull(organization.name))
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

/**
 * Coerce a jsonb `IS_SIGNUP_ENABLED` value to a string. Panel writes store
 * `'0'`/`'1'`; ignore objects/arrays so they never become `'[object Object]'`.
 */
function readSignupSettingString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return `${raw}`
  }
  return null
}

export async function isSignupEnabled(
  db: Db,
  envOverride?: SignupEnvOverride,
  runtime: 'deno' | 'workers' = 'deno',
): Promise<boolean> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, IS_SIGNUP_ENABLED_CONFIG_KEY))
    .limit(1)

  return resolveIsSignupEnabled(
    readSignupSettingString(rows[0]?.value),
    envOverride,
    { runtime },
  )
}

/**
 * Shared entry point for `/status`, `/auth/sign-up`, and OTP auto-registration
 * so the effective signup flag cannot drift across those surfaces.
 *
 * Reads the current DB setting on every call (plus any env force override).
 * Do not capture this boolean once at Worker `createApp()` init — panel toggles
 * must take effect without a redeploy.
 */
export async function resolveEffectiveSignupEnabled(
  db: Db | undefined,
  runtime: 'deno' | 'workers',
  envOverride?: SignupEnvOverride,
): Promise<boolean> {
  if (db === undefined) {
    return resolveIsSignupEnabled(undefined, envOverride, { runtime })
  }
  return isSignupEnabled(db, envOverride, runtime)
}

export type SignupSettingMeta = {
  /** Effective flag after env force + DB resolution. */
  enabled: boolean
  /** Raw DB value (`'1'` / `'0'`), or null when unset. */
  dbValue: '0' | '1' | null
  /** True when `TURBOPANEL_IS_SIGNUP_ENABLED` is a recognized force override. */
  isEnvForced: boolean
  envOverride: string | null
}

/** Read signup setting metadata for the admin panel. */
export async function getSignupSettingMeta(
  db: Db,
  runtime: 'deno' | 'workers',
  envOverride?: SignupEnvOverride,
): Promise<SignupSettingMeta> {
  const normalizedEnv = normalizeSignupEnvOverride(envOverride)
  let isEnvForced = false
  if (normalizedEnv !== undefined) {
    const flag = normalizedEnv.toLowerCase()
    isEnvForced = flag === '1' || flag === 'true' || flag === '0' || flag === 'false'
  }

  let dbValue: '0' | '1' | null = null
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, IS_SIGNUP_ENABLED_CONFIG_KEY))
    .limit(1)
  const asString = readSignupSettingString(rows[0]?.value)
  if (asString === '0' || asString === '1') {
    dbValue = asString
  }

  return {
    enabled: await resolveEffectiveSignupEnabled(db, runtime, envOverride),
    dbValue,
    isEnvForced,
    envOverride: normalizedEnv ?? null,
  }
}

/**
 * Persist the panel-controlled `IS_SIGNUP_ENABLED` DB setting.
 * Env force overrides still win at read time when configured.
 */
export async function setSignupEnabledSetting(
  db: Db,
  enabled: boolean,
): Promise<void> {
  const value = enabled ? '1' : '0'
  await db
    .insert(setting)
    .values({ key: IS_SIGNUP_ENABLED_CONFIG_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value,
        updatedAt: nowTs(),
      },
    })
}

export async function getInstallStatus(
  db: Db,
  envOverride?: SignupEnvOverride,
  platformEnv: Record<string, string | undefined> = {},
  dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<InstallStatus> {
  // Sequential: parallel drizzle queries on postgres.js can wedge the pool (Deno dev).
  const installed = await isInstanceInstalled(db)
  const signupEnabled = await resolveEffectiveSignupEnabled(db, 'deno', envOverride)
  const emailSettings = await resolveEmailSettings(db, platformEnv, dataEncryptionSecrets)
  const emailVerificationEnabled = isEmailActiveForRuntime(emailSettings, 'deno')
  const needsInstall = !installed
  return {
    needsInstall,
    isInstallMode: needsInstall,
    isSignupEnabled: signupEnabled,
    isSignupEmailVerificationEnabled: emailVerificationEnabled,
  }
}

export type DenoClientPublicStatus = InstallStatus & {
  ok: true
  /** Control-plane runtime — UI uses this for self-hosted (green) vs HA (blue) auth chrome. */
  runtime: 'deno'
}

export type WorkersClientPublicStatus = {
  ok: true
  runtime: 'workers'
  isSignupEnabled: boolean
  isSignupEmailVerificationEnabled: boolean
}

export type ClientPublicStatus = DenoClientPublicStatus | WorkersClientPublicStatus

/** Public client status for GET /api/client/v1/status (both runtimes). */
export async function getClientPublicStatus(
  db: Db | undefined,
  runtime: 'deno' | 'workers',
  envOverride?: SignupEnvOverride,
  platformEnv: Record<string, string | undefined> = {},
  dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<ClientPublicStatus | null> {
  if (runtime === 'workers') {
    const emailSettings = await resolveEmailSettings(
      db,
      platformEnv,
      dataEncryptionSecrets,
    )
    return {
      ok: true,
      runtime: 'workers',
      isSignupEnabled: await resolveEffectiveSignupEnabled(db, runtime, envOverride),
      isSignupEmailVerificationEnabled: isEmailActiveForRuntime(
        emailSettings,
        runtime,
      ),
    }
  }

  if (db === undefined) {
    return null
  }

  const status = await getInstallStatus(db, envOverride, platformEnv, dataEncryptionSecrets)
  return { ok: true, runtime: 'deno', ...status }
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
  if (!isSimpleEmailShape(trimmed)) {
    return 'Enter a valid email address'
  }
  return null
}

/**
 * Special characters accepted by the password policy. This set is the canonical
 * server-side mirror of the UI's `validatePassword` in
 * `ui/src/components/auth/sign-up-screen.tsx` — keep the two in lockstep so the
 * UI and API cannot drift.
 */
export const PASSWORD_SPECIAL_CHARS_PATTERN = /[$!@%&*#^()_+=-]/
const PASSWORD_DIGIT_PATTERN = /\d/
export const PASSWORD_MIN_LENGTH = 8

/**
 * Canonical server-side password policy, enforced on every password-setting
 * path (install, sign-up, password reset) so a direct API call cannot bypass
 * the rules the UI presents. Structural rules match the UI mirror
 * (`ui/src/components/auth/sign-up-screen.tsx` → `validatePassword`):
 * at least {@link PASSWORD_MIN_LENGTH} characters, at least one digit, at least
 * one special character, and no leading/trailing whitespace.
 *
 * Returns a human-readable error string for the first failing rule, or `null`
 * when the password satisfies the policy.
 */
export function validateSuperadminPassword(password: string): string | null {
  if (password !== password.trim()) {
    return 'Password must not have leading or trailing whitespace'
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (!PASSWORD_DIGIT_PATTERN.test(password)) {
    return 'Password must include at least one number'
  }
  if (!PASSWORD_SPECIAL_CHARS_PATTERN.test(password)) {
    return 'Password must include at least one special character'
  }
  return null
}

export async function readLocalMachineKey(): Promise<string | undefined> {
  if (typeof Deno === 'undefined') return undefined
  try {
    const id = await Deno.readTextFile('/etc/machine-id')
    return await deriveMachineKey(id)
  } catch {
    return undefined
  }
}

/** Default org created by the self-hosted install wizard (superadmin's org). */
export async function findDefaultInstalledOrganizationId(
  db: Db,
): Promise<string | null> {
  const byName = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.name, DEFAULT_ORGANIZATION_NAME))
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
    .where(isNotNull(organization.name))
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

/**
 * Resolve the co-located server row id from dedicated identity columns
 * (machineKey / hostname). Used when no daemon is connected during install or
 * right after an instance restart.
 */
export async function resolveColocatedServerId(
  db: Db,
  registry?: DaemonCellRegistry,
): Promise<string | null> {
  return (
    (await resolveColocatedServerIdFromRegistry(db, registry)) ??
    (await resolveColocatedServerIdByMachineKey(db)) ??
    (await resolveColocatedServerIdByHostname(db)) ??
    (await resolveColocatedServerIdFromSingleUnassigned(db))
  )
}

async function resolveColocatedServerIdFromRegistry(
  db: Db,
  registry?: DaemonCellRegistry,
): Promise<string | null> {
  if (!registry) return null
  const fromRegistry = await findColocatedServerIdFromRegistry(db, registry)
  if (!fromRegistry) return null
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.id, fromRegistry))
    .limit(1)
  return rows[0]?.id ?? null
}

async function resolveColocatedServerIdByMachineKey(
  db: Db,
): Promise<string | null> {
  const machineKey = await readLocalMachineKey()
  if (!machineKey) return null
  const byMachine = await db
    .select({ id: server.id })
    .from(server)
    .where(and(
      isNull(server.organizationId),
      eq(server.machineKey, machineKey),
    ))
    .limit(1)
  return byMachine[0]?.id ?? null
}

function readLocalHostname(): string | null {
  if (typeof Deno === 'undefined') return null
  try {
    return Deno.hostname()
  } catch {
    // hostname unavailable without --allow-sys=hostname
    return null
  }
}

async function resolveColocatedServerIdByHostname(
  db: Db,
): Promise<string | null> {
  const hostname = readLocalHostname()
  if (!hostname) return null
  const byHostname = await db
    .select({ id: server.id })
    .from(server)
    .where(and(
      isNull(server.organizationId),
      eq(server.hostname, hostname),
    ))
    .limit(1)
  return byHostname[0]?.id ?? null
}

async function resolveColocatedServerIdFromSingleUnassigned(
  db: Db,
): Promise<string | null> {
  // Self-hosted Deno co-located dev: a single unassigned row is this host.
  if (typeof Deno === 'undefined') return null
  const unassigned = await db
    .select({ id: server.id })
    .from(server)
    .where(isNull(server.organizationId))
  if (unassigned.length === 1 && unassigned[0]?.id) {
    return unassigned[0].id
  }
  return null
}

const COLOCATED_LICENSE_REVOKE_ERROR =
  'The license for the co-located control plane daemon cannot be revoked'

async function readColocatedDiskLicenseId(): Promise<string | null> {
  if (typeof Deno === 'undefined') return null

  const candidates = [resolveColocatedLicenseCredentialsDir()]

  for (const dir of new Set(candidates)) {
    try {
      const id = (await Deno.readTextFile(`${dir}/license.id`)).trim()
      if (id.length > 0) return id
    } catch {
      // try next candidate path
    }
  }

  return null
}

/** Live registry: active license latched to the Unix-socket co-located server, if any. */
async function resolveLicenseIdFromColocatedRegistry(
  db: Db,
  registry: DaemonCellRegistry,
  organizationId?: string,
): Promise<string | null> {
  const colocatedServerId = await findColocatedServerIdFromRegistry(db, registry)
  if (!colocatedServerId) return null
  const filter = organizationId
    ? and(
      eq(license.serverId, colocatedServerId),
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    )
    : and(eq(license.serverId, colocatedServerId), isNull(license.revokedAt))
  const rows = await db
    .select({ id: license.id })
    .from(license)
    .where(filter)
    .limit(1)
  return rows[0]?.id ?? null
}

/** Install-wizard license named {@link COLOCATED_SERVER_DISPLAY_NAME}, if still active. */
async function resolveInstallDisplayNameLicenseId(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const installLicense = await db
    .select({ id: license.id })
    .from(license)
    .where(and(
      eq(license.organizationId, organizationId),
      eq(license.name, COLOCATED_SERVER_DISPLAY_NAME),
      isNull(license.revokedAt),
    ))
    .limit(1)
  return installLicense[0]?.id ?? null
}

/**
 * Durable pin: licenses bound to the server that owns the `turbopanel` self-host
 * environment stay protected even when the daemon is offline.
 */
async function addSelfHostBoundLicenseIds(
  db: Db,
  ids: Set<string>,
  organizationId?: string,
): Promise<void> {
  const boundFilter = organizationId
    ? and(eq(license.organizationId, organizationId), isNotNull(license.serverId))
    : isNotNull(license.serverId)
  const boundRows = await db
    .select({ id: license.id, serverId: license.serverId })
    .from(license)
    .where(boundFilter)
  for (const row of boundRows) {
    if (!row.serverId || ids.has(row.id)) continue
    const envId = await findSystemEnvironmentForServer(
      db,
      row.serverId,
      SYSTEM_SELF_HOST_COMPONENT,
    )
    if (envId) ids.add(row.id)
  }
}

/**
 * Licenses tied to the Unix-socket co-located daemon are not revocable — revoking
 * would break the local control plane and dev stack.
 *
 * Protection sources (any one is enough): live registry probe, on-disk
 * `license.id`, install display-name match, and the durable self-host
 * environment pin (`license.server_id` owns the `turbopanel` system
 * environment) so revoke stays blocked when the daemon is offline and disk
 * credentials are missing.
 */
export async function resolveProtectedColocatedLicenseIds(
  db: Db,
  registry?: DaemonCellRegistry,
  organizationId?: string,
): Promise<Set<string>> {
  const ids = new Set<string>()
  if (typeof Deno === 'undefined') return ids

  // Accumulate every protection source — a registry hit must not skip disk,
  // reserved display-name, or durable self-host pin fallbacks.
  if (registry) {
    const registryLicenseId = await resolveLicenseIdFromColocatedRegistry(
      db,
      registry,
      organizationId,
    )
    if (registryLicenseId != null) ids.add(registryLicenseId)
  }

  const diskId = await readColocatedDiskLicenseId()
  if (diskId) ids.add(diskId)

  if (organizationId) {
    const installId = await resolveInstallDisplayNameLicenseId(db, organizationId)
    if (installId) ids.add(installId)
  }

  await addSelfHostBoundLicenseIds(db, ids, organizationId)
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

/**
 * Assign the co-located daemon server row to `organizationId`.
 *
 * Returns the resolved colocated `serverId` when the row was found (newly
 * assigned or already belonging to an org). Callers that must provision the
 * self-host system hierarchy after install should use this id directly —
 * {@link resolveColocatedServerId} filters on `organization_id IS NULL` and
 * cannot re-find a server that was just assigned.
 *
 * Returns `null` when no colocated server row exists yet (daemon not enrolled).
 */
export async function assignColocatedDaemonToOrganization(
  db: Db,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<string | null> {
  const serverId = await resolveColocatedServerId(db, registry)
  if (!serverId) {
    compatLogInfo(
      'install',
      'colocated server not found yet — will assign on daemon connect',
    )
    return null
  }

  const now = nowTs()
  await db
    .update(server)
    .set({
      name: sql`coalesce(${server.name}, ${COLOCATED_SERVER_DISPLAY_NAME})`,
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
    return serverId
  }

  return assignedOrgId != null ? serverId : null
}

/**
 * Best-effort System workspace + self-host hierarchy bootstrap. Resolves the
 * default installed organization first and ensures the System workspace
 * (backfill for pre-existing installs — no daemon required), then when a
 * colocated server is resolvable provisions the full `turbopanel`
 * project/environment/services tree (see `system/hierarchy.ts`). Callers
 * re-run this on a maintenance timer so a host whose daemon enrolls after
 * install still converges. Logs and swallows failures so it can never block
 * install completion or the boot path that calls it.
 */
export async function ensureSelfHostSystemHierarchyBestEffort(
  db: Db,
  registry?: DaemonCellRegistry,
): Promise<void> {
  try {
    const organizationId = await findDefaultInstalledOrganizationId(db)
    if (!organizationId) return

    // Backfill System workspace for installs that predate install-time
    // provisioning — does not require a colocated server.
    await ensureSystemWorkspace(db, organizationId)

    const serverId = await resolveColocatedServerId(db, registry)
    if (!serverId) return

    await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })
  } catch (err) {
    compatLogWarn(
      'install',
      `failed to ensure self-host system hierarchy: ${err}`,
    )
  }
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
 * After a partial install (DB configured but license files missing), rotate the
 * colocated license and persist credentials so the daemon can enroll.
 *
 * The plaintext token is unrecoverable once disk files are gone (DB stores only
 * an Argon2id hash). When a co-located server is already enrolled (active bound
 * license), recovery **updates that row's token in place** so the `server_id`
 * latch and daemon identity stay intact. Otherwise it revokes active unbound
 * colocated licenses, mints one fresh seat, and — when a prior binding still
 * holds `server_id` — rebinds the new credential and clears daemon state in the
 * same transaction so re-enroll targets the same server.
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

  const { licenseId, licenseToken } = await rotateColocatedLicenseCredentials(
    db,
    organizationId,
  )
  await persistColocatedLicenseCredentials(licenseId, licenseToken)
  compatLogInfo(
    'install',
    'restored colocated license credentials on disk after partial install',
  )
}

/**
 * Restore colocated disk credentials for an org.
 *
 * Prefer in-place token rotation on an already-bound active seat. Fall back to
 * revoke-then-mint, rebinding any prior `server_id` and clearing daemon identity
 * so the new credential can re-enroll the same server.
 */
export async function rotateColocatedLicenseCredentials(
  db: Db,
  organizationId: string,
): Promise<{ licenseId: string; licenseToken: string }> {
  const boundActive = await findActiveBoundColocatedLicense(db, organizationId)
  if (boundActive) {
    return rotateLicenseTokenInPlace(db, boundActive.id)
  }

  return db.transaction(async (tx) => {
    const priorServerId = await findColocatedBoundServerId(tx, organizationId)
    await revokeActiveColocatedLicenses(tx, organizationId)
    const created = await createLicense(tx, {
      organizationId,
      name: COLOCATED_SERVER_DISPLAY_NAME,
    })

    if (priorServerId) {
      // Free the unique-index slot held by revoked rows, then latch the new seat.
      await tx
        .update(license)
        .set({ serverId: null, updatedAt: nowTs() })
        .where(eq(license.serverId, priorServerId))
      await tx
        .update(license)
        .set({ serverId: priorServerId, updatedAt: nowTs() })
        .where(eq(license.id, created.licenseId))
      await clearServerDaemonState(tx, priorServerId)
    }

    return created
  })
}

/** Active colocated license already latched to a server, if any. */
async function findActiveBoundColocatedLicense(
  db: Db,
  organizationId: string,
): Promise<{ id: string; serverId: string } | null> {
  const rows = await db
    .select({ id: license.id, serverId: license.serverId })
    .from(license)
    .where(and(
      eq(license.organizationId, organizationId),
      eq(license.name, COLOCATED_SERVER_DISPLAY_NAME),
      isNull(license.revokedAt),
      isNotNull(license.serverId),
    ))
    .limit(1)
  const row = rows[0]
  if (!row?.serverId) return null
  return { id: row.id, serverId: row.serverId }
}

/**
 * Server id still held by any colocated license row (including revoked), so
 * replacement recovery can rebind the same host.
 */
async function findColocatedBoundServerId(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ serverId: license.serverId })
    .from(license)
    .where(and(
      eq(license.organizationId, organizationId),
      eq(license.name, COLOCATED_SERVER_DISPLAY_NAME),
      isNotNull(license.serverId),
    ))
    .limit(1)
  return rows[0]?.serverId ?? null
}

/** Mint a new plaintext token on an existing active license row. */
async function rotateLicenseTokenInPlace(
  db: Db,
  licenseId: string,
): Promise<{ licenseId: string; licenseToken: string }> {
  const { plaintext, hashed } = await generateLicenseToken()
  const updated = await db
    .update(license)
    .set({ token: hashed, updatedAt: nowTs() })
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .returning({ id: license.id })
  if (!updated[0]?.id) {
    throw new Error('Colocated license token rotation failed')
  }
  return { licenseId, licenseToken: plaintext }
}

/** Soft-invalidate every active colocated (`this server`) license for an org. */
async function revokeActiveColocatedLicenses(
  db: Db,
  organizationId: string,
): Promise<void> {
  const active = await db
    .select({ id: license.id })
    .from(license)
    .where(and(
      eq(license.organizationId, organizationId),
      eq(license.name, COLOCATED_SERVER_DISPLAY_NAME),
      isNull(license.revokedAt),
    ))

  for (const row of active) {
    await invalidateLicense(db, row.id, organizationId)
  }
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
        name: displayName,
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
        name: DEFAULT_TEAM_NAME,
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
        actorType: 'user',
        actorId: userId,
        permission: 'team:own',
        allow: true,
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

    await insertDefaultWorkspace(tx, organizationId)

    return { organizationId, teamId }
  })
}

export async function completeInstanceInstall(
  db: Db,
  input: CompleteInstallInput,
): Promise<{ organizationId: string; userId: string; licenseId: string }> {
  // Preflight only — friendly fast-fail. The authoritative guard is the unique
  // install sentinel acquired inside the transaction below.
  if (await isInstanceInstalled(db)) {
    throw new Error(INSTANCE_ALREADY_CONFIGURED_ERROR)
  }

  const emailError = validateSuperadminEmail(input.superadminEmail)
  if (emailError) throw new Error(emailError)

  const passwordError = validateSuperadminPassword(input.superadminPassword)
  if (passwordError) throw new Error(passwordError)

  const trimmedOrgName = DEFAULT_ORGANIZATION_NAME
  const trimmedTeamName = DEFAULT_TEAM_NAME
  const trimmedEmail = input.superadminEmail.trim().toLowerCase()
  const hashedPassword = await hashPassword(input.superadminPassword)

  const existingUser = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, trimmedEmail))
    .limit(1)

  if (existingUser.length > 0) {
    throw new Error('Email is already registered')
  }

  const result = await db.transaction(async (tx) => {
    // Acquire the unique install sentinel first. Concurrent installs block on
    // this `setting.key` (setting_key_unique) until we commit; the loser then
    // observes the conflict (no returned row) and aborts. This serializes
    // install completion at the database level so only one superadmin bootstrap
    // can ever be created, even under concurrent requests across isolates.
    const sentinel = await tx
      .insert(setting)
      .values({
        key: INSTANCE_INSTALL_SENTINEL_KEY,
        value: { installedAt: nowTs() },
      })
      .onConflictDoNothing({ target: setting.key })
      .returning({ id: setting.id })

    if (sentinel.length === 0) {
      throw new Error(INSTANCE_ALREADY_CONFIGURED_ERROR)
    }

    // Re-check while holding the sentinel. Guards installs that predate the
    // sentinel row (org + superadmin already exist without a sentinel): the
    // sentinel insert would otherwise succeed and create a second superadmin.
    if (await isInstanceInstalled(tx)) {
      throw new Error(INSTANCE_ALREADY_CONFIGURED_ERROR)
    }

    const insertedOrg = await tx
      .insert(organization)
      .values({
        name: trimmedOrgName,
      })
      .returning({ id: organization.id })

    const organizationId = insertedOrg[0]?.id
    if (!organizationId) {
      throw new Error('Organization creation failed')
    }

    // System workspace first so uuidv7 / created_at ordering puts it ahead of
    // Default Workspace in GET /workspaces.
    await ensureSystemWorkspace(tx, organizationId)

    const insertedTeam = await tx
      .insert(team)
      .values({
        organizationId,
        name: trimmedTeamName,
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
        actorType: 'user',
        actorId: userId,
        permission: 'team:own',
        allow: true,
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

    await insertDefaultWorkspace(tx, organizationId)

    const { licenseId, licenseToken } = await createLicense(tx, {
      organizationId,
      name: COLOCATED_SERVER_DISPLAY_NAME,
    })

    return { organizationId, userId, licenseId, licenseToken }
  })

  await clearColocatedDaemonIdentityFiles()

  await persistColocatedLicenseCredentials(
    result.licenseId,
    result.licenseToken,
  )

  // Resolve + assign before hierarchy provision. After assignment,
  // resolveColocatedServerId filters on organization_id IS NULL and cannot
  // re-find this server — pass the returned id directly.
  const colocatedServerId = await assignColocatedDaemonToOrganization(
    db,
    result.organizationId,
  )

  if (colocatedServerId) {
    try {
      await ensureSelfHostSystemHierarchy(db, {
        organizationId: result.organizationId,
        serverId: colocatedServerId,
      })
    } catch (err) {
      compatLogWarn(
        'install',
        `failed to ensure self-host system hierarchy: ${err}`,
      )
    }
  }

  return {
    organizationId: result.organizationId,
    userId: result.userId,
    licenseId: result.licenseId,
  }
}
