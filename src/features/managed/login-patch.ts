/**
 * Pure rules for changing an existing database login (PATCH
 * /managed/users/:principalId): which transitions are allowed, the metadata
 * that results, and a plain-words list of what the next apply will do.
 *
 * The SQL itself is built by the daemon, so a dry run describes the
 * statements by kind instead of printing them.
 */

import { DATABASE_ADMIN_PRIVILEGE, evaluateDatabaseAdminGrant } from './owner-role.ts'
import {
  type DatabaseLoginRole,
  isLoginGrantMode,
  type LoginGrantMode,
  loginGrantMode,
  loginIsTool,
} from './logins.ts'
import { describeLoginLimits, loginAllowedSources, loginMaxConnections } from './login-sources.ts'

export type LoginPatchError = {
  ok: false
  status: 400 | 409 | 422
  error: string
  message: string
}

export type LoginPatchInput = {
  grantMode?: unknown
  tool?: unknown
  /** Already validated against the cluster's databases by the caller. */
  databases?: string[]
  connectionRole?: 'read-write' | 'read-only'
  privileges?: string[]
  confirmReset?: unknown
  /** Parsed places; `null` clears (anywhere). Absent leaves the stored value. */
  allowedSources?: string[] | null
  /** Parsed cap; `null` clears. Absent leaves the stored value. */
  maxConnections?: number | null
}

export type LoginPatchCurrent = {
  role: DatabaseLoginRole
  metadata: unknown
}

/** Facts about the cluster the planner needs; none are required. */
export type LoginPatchCluster = {
  /** Postgres: databases that have an owner role. */
  ownerRoleDatabases?: readonly string[]
}

export type LoginPatchResult = {
  ok: true
  metadata: Record<string, unknown>
  grantMode: LoginGrantMode
  summary: string[]
}

function storedConnectionRole(metadata: unknown): 'read-only' | 'read-write' {
  const role = (metadata as Record<string, unknown> | null)?.connectionRole
  return role === 'read-only' ? 'read-only' : 'read-write'
}

const fail = (
  status: LoginPatchError['status'],
  error: string,
  message: string
): LoginPatchError => ({ ok: false, status, error, message })

/** The mode after the change, or the plain-words refusal. */
function resolveGrantMode(
  before: LoginGrantMode,
  input: LoginPatchInput
): LoginGrantMode | LoginPatchError {
  if (input.grantMode === undefined) return before
  if (!isLoginGrantMode(input.grantMode)) {
    return fail(400, 'managed_grant_mode_invalid', "grantMode must be 'recipe' or 'self'.")
  }
  if (input.grantMode === 'preset' && before !== 'preset') {
    return fail(
      422,
      'managed_grant_mode_invalid_transition',
      "'preset' only describes logins made before permission modes existed. Choose 'recipe' (the panel sets permissions) or 'self' (you set them)."
    )
  }
  if (before === 'self' && input.grantMode !== 'self' && input.confirmReset !== true) {
    return fail(
      409,
      'managed_grant_reset_needs_confirm',
      'Switching a manage-myself login back to panel-set permissions makes the panel reset its permissions to the chosen set, which removes any grants you made by hand. Send confirmReset: true to go ahead.'
    )
  }
  return input.grantMode
}

function patchMetadata(after: LoginGrantMode, input: LoginPatchInput): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  if (input.grantMode !== undefined) metadata.grantMode = after
  if (input.tool !== undefined) metadata.tool = input.tool
  if (input.databases !== undefined) metadata.databases = input.databases
  if (input.privileges !== undefined) metadata.privileges = input.privileges
  if (input.connectionRole !== undefined) {
    // Stored only for read-only: an absent key is the read-write default.
    metadata.connectionRole = input.connectionRole === 'read-only' ? 'read-only' : undefined
  }
  // `undefined` removes the key: absent means anywhere / no cap.
  if (input.allowedSources !== undefined)
    metadata.allowedSources = input.allowedSources ?? undefined
  if (input.maxConnections !== undefined)
    metadata.maxConnections = input.maxConnections ?? undefined
  return metadata
}

function storedStrings(metadata: unknown, key: 'databases' | 'privileges'): string[] {
  const value = (metadata as Record<string, unknown> | null)?.[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function planLoginPatch(
  engine: string,
  current: LoginPatchCurrent,
  input: LoginPatchInput,
  cluster: LoginPatchCluster = {}
): LoginPatchResult | LoginPatchError {
  if (current.role !== 'user') {
    return fail(
      422,
      'managed_login_not_editable',
      'Only logins you created can be changed. The cluster administrator and replication logins are managed by TurboPanel.'
    )
  }
  const after = resolveGrantMode(loginGrantMode(current.metadata), input)
  if (typeof after !== 'string') return after

  // connectionRole is routing (read replicas vs primary), not privileges, so a
  // manage-myself login may change it. Only the panel-set privileges are refused.
  if (after === 'self' && input.privileges !== undefined) {
    return fail(
      422,
      'managed_self_login_has_no_privileges',
      'A manage-myself login has no panel-set permissions to change. Grant or revoke in SQL, or switch it back to panel-set permissions first.'
    )
  }
  const before = loginGrantMode(current.metadata)
  const readOnlyAfter =
    (input.connectionRole ?? storedConnectionRole(current.metadata)) === 'read-only'
  if (
    engine === 'postgres' &&
    after === 'self' &&
    before !== 'self' &&
    readOnlyAfter &&
    input.confirmReset !== true
  ) {
    return fail(
      409,
      'managed_grant_reset_needs_confirm',
      'This login is set to read-only. In PostgreSQL that is a default setting on the login itself, and a manage-myself login is never touched by the panel, so the read-only setting stays on until someone removes it by hand (ALTER ROLE ... RESET default_transaction_read_only). Send confirmReset: true to go ahead.'
    )
  }
  if (input.tool !== undefined && typeof input.tool !== 'boolean') {
    return fail(400, 'Invalid request', 'tool must be true or false.')
  }

  // The Database admin login has fixed rules (never read-only; on Postgres
  // only on databases with an owner role), checked on the state after the change.
  const privilegesAfter = input.privileges ?? storedStrings(current.metadata, 'privileges')
  const becomesAdmin = privilegesAfter.includes(DATABASE_ADMIN_PRIVILEGE)
  const adminRefusal = evaluateDatabaseAdminGrant(engine, {
    privileges: privilegesAfter,
    databases: input.databases ?? storedStrings(current.metadata, 'databases'),
    connectionRole: input.connectionRole ?? storedConnectionRole(current.metadata),
    ownerRoleDatabases: cluster.ownerRoleDatabases,
  })
  if (adminRefusal) {
    return fail(adminRefusal.status, adminRefusal.error, adminRefusal.message)
  }

  const metadata = patchMetadata(after, input)
  if (input.privileges !== undefined && becomesAdmin) {
    // Admin is exclusive, and a tool login by default.
    metadata.privileges = [DATABASE_ADMIN_PRIVILEGE]
    if (input.tool === undefined && !loginIsTool(current.metadata)) metadata.tool = true
  }
  if (Object.keys(metadata).length === 0) {
    return fail(400, 'Invalid request', 'Nothing to change.')
  }
  const tool = (metadata.tool as boolean | undefined) ?? loginIsTool(current.metadata)
  const summary = describeApply(engine, after, tool, becomesAdmin)
  if (input.allowedSources !== undefined || input.maxConnections !== undefined) {
    const sources =
      input.allowedSources === undefined
        ? loginAllowedSources(current.metadata)
        : (input.allowedSources ?? undefined)
    const cap =
      input.maxConnections === undefined
        ? loginMaxConnections(current.metadata)
        : (input.maxConnections ?? undefined)
    summary.push(...describeLoginLimits(sources, cap))
  }
  return { ok: true, metadata, grantMode: after, summary }
}

/** Plain-words statement kinds the next apply runs for this login. */
export function describeApply(
  engine: string,
  mode: LoginGrantMode,
  tool: boolean,
  admin = false
): string[] {
  const kept = [
    'Create the login if missing and set its password',
    engine === 'postgres'
      ? 'Keep LOGIN on, SUPERUSER off and the connection limit'
      : 'Keep the account rows for each allowed client address',
    engine === 'postgres'
      ? 'Allow CONNECT on the listed databases (everyone else stays blocked)'
      : 'Keep the account usable from the listed client addresses',
  ]
  const lines =
    mode === 'self'
      ? [
          ...kept,
          'Do not revoke or grant anything else: permissions you set by hand are left exactly as they are',
        ]
      : [
          ...kept,
          engine === 'postgres'
            ? 'Revoke the login from databases not listed, reset its permissions on listed databases to the chosen set, and set its default permissions for new tables'
            : 'Reset the login permissions on each listed database to the chosen set',
        ]
  if (admin) {
    lines.push(
      engine === 'postgres'
        ? "Make the login a member of each listed database's owner role (it can grant on everything the owner role owns) and keep it from creating roles, databases or replication"
        : 'Give the login all rights on each listed database, with the right to pass them on, and nothing outside those databases'
    )
  }
  if (tool) {
    lines.push('Send all of this login traffic to the primary (no read/write splitting)')
  }
  return lines
}

/** The metadata keys a PATCH can change, as they were: writing this back undoes the PATCH. */
export function loginPatchUndo(previous: unknown): Record<string, unknown> {
  const before = (previous ?? {}) as Record<string, unknown>
  const mode = loginGrantMode(previous)
  return {
    grantMode: mode === 'preset' ? undefined : mode,
    tool: before.tool,
    databases: before.databases,
    privileges: before.privileges,
    connectionRole: before.connectionRole,
    allowedSources: before.allowedSources,
    maxConnections: before.maxConnections,
  }
}
