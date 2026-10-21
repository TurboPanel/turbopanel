/**
 * Pure rules for changing an existing database login (PATCH
 * /managed/users/:loginId): which transitions are allowed, the settings
 * change that results, and a plain-words list of what the next apply will do.
 *
 * The SQL itself is built by the daemon, so a dry run describes the
 * statements by kind instead of printing them.
 */

import {
  DATABASE_ADMIN_PRIVILEGE,
  evaluateDatabaseAdminGrant,
  type ReadWriteGrantState,
} from './owner-role.ts'
import {
  type DatabaseLoginRole,
  isLoginGrantMode,
  type LoginGrantMode,
  type LoginSettings,
  type LoginSettingsPatch,
} from './logins.ts'
import { describePatchedLimits } from './login-sources.ts'
import {
  describeStraightThroughPatch,
  refuseStraightThroughPatch,
} from './login-straight-through.ts'

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
  /** Parsed choice; `null` goes back to the default. Absent leaves the stored value. */
  straightThrough?: boolean | null
}

export type LoginPatchCurrent = LoginSettings & {
  role: DatabaseLoginRole
}

export type LoginPatchResult = {
  ok: true
  /** The columns to change; `null` clears a limit. */
  patch: LoginSettingsPatch
  grantMode: LoginGrantMode
  summary: string[]
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

function patchSettings(after: LoginGrantMode, input: LoginPatchInput): LoginSettingsPatch {
  const patch: LoginSettingsPatch = {}
  if (input.grantMode !== undefined) patch.grantMode = after
  if (input.tool !== undefined) patch.tool = input.tool as boolean
  if (input.databases !== undefined) patch.databases = input.databases
  if (input.privileges !== undefined) patch.privileges = input.privileges
  if (input.connectionRole !== undefined) patch.connectionRole = input.connectionRole
  // `null` clears: NULL means anywhere / no cap.
  if (input.allowedSources !== undefined) patch.allowedSources = input.allowedSources
  if (input.maxConnections !== undefined) patch.maxConnections = input.maxConnections
  if (input.straightThrough !== undefined) patch.straightThrough = input.straightThrough
  return patch
}

/** A login's stored mode and levels, for the daemon rule on the read/write level. */
export function readWriteGrantState(
  settings: Pick<LoginSettings, 'grantMode' | 'privileges' | 'databases'>
): ReadWriteGrantState {
  return {
    grantMode: settings.grantMode,
    privileges: settings.privileges,
    databases: settings.databases,
  }
}

export function planLoginPatch(
  engine: string,
  current: LoginPatchCurrent,
  input: LoginPatchInput
): LoginPatchResult | LoginPatchError {
  if (current.role !== 'user') {
    return fail(
      422,
      'managed_login_not_editable',
      'Only logins you created can be changed. The cluster administrator and replication logins are managed by TurboPanel.'
    )
  }
  const after = resolveGrantMode(current.grantMode, input)
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
  const before = current.grantMode
  const readOnlyAfter = (input.connectionRole ?? current.connectionRole) === 'read-only'
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

  // Straight through: judged on the state after the change, both directions
  // (turning it on with a limit, or adding a limit to a login set to it).
  const straightRefusal = refuseStraightThroughPatch(engine, current, input)
  if (straightRefusal) {
    return fail(straightRefusal.status, straightRefusal.error, straightRefusal.message)
  }

  // The Database admin login has one rule (never read-only), checked on the
  // state after the change. Owner-role setup never refuses it.
  const privilegesAfter = input.privileges ?? current.privileges
  const becomesAdmin = privilegesAfter.includes(DATABASE_ADMIN_PRIVILEGE)
  const adminRefusal = evaluateDatabaseAdminGrant(engine, {
    privileges: privilegesAfter,
    connectionRole: input.connectionRole ?? current.connectionRole,
  })
  if (adminRefusal) {
    return fail(adminRefusal.status, adminRefusal.error, adminRefusal.message)
  }

  const patch = patchSettings(after, input)
  if (input.privileges !== undefined && becomesAdmin) {
    // Admin is exclusive, and a tool login by default.
    patch.privileges = [DATABASE_ADMIN_PRIVILEGE]
    if (input.tool === undefined && !current.tool) {
      patch.tool = true
    }
  }
  if (Object.keys(patch).length === 0) {
    return fail(400, 'Invalid request', 'Nothing to change.')
  }
  const tool = patch.tool ?? current.tool
  const summary = describeApply(engine, after, tool, becomesAdmin)
  summary.push(...describePatchedLimits(current, input))
  summary.push(...describeStraightThroughPatch(engine, current, patch))
  return { ok: true, patch, grantMode: after, summary }
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
        ? 'Make the login a member of the owner role of each listed database that has one (it can grant on everything the owner role owns), give it read and write access on listed databases made before owner roles, and keep it from creating roles, databases or replication'
        : 'Give the login all rights on each listed database, with the right to pass them on, and nothing outside those databases'
    )
  }
  if (tool) {
    lines.push('Send all of this login traffic to the primary (no read/write splitting)')
  }
  return lines
}

/** The settings a PATCH can change, as they were: writing this back undoes the PATCH. */
export function loginPatchUndo(previous: LoginSettings): LoginSettingsPatch {
  return {
    grantMode: previous.grantMode,
    tool: previous.tool,
    databases: previous.databases,
    privileges: previous.privileges,
    connectionRole: previous.connectionRole,
    allowedSources: previous.allowedSources ?? null,
    maxConnections: previous.maxConnections ?? null,
    straightThrough: previous.straightThrough ?? null,
  }
}
