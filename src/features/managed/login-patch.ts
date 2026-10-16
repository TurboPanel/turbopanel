/**
 * Pure rules for changing an existing database login (PATCH
 * /managed/users/:principalId): which transitions are allowed, the metadata
 * that results, and a plain-words list of what the next apply will do.
 *
 * The SQL itself is built by the daemon, so a dry run describes the
 * statements by kind instead of printing them.
 */

import { isLoginGrantMode, type LoginGrantMode, loginGrantMode, loginIsTool } from './logins.ts'
import type { DatabaseLoginRole } from './logins.ts'

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
}

export type LoginPatchCurrent = {
  role: DatabaseLoginRole
  metadata: unknown
}

export type LoginPatchResult = {
  ok: true
  metadata: Record<string, unknown>
  grantMode: LoginGrantMode
  summary: string[]
}

const fail = (
  status: LoginPatchError['status'],
  error: string,
  message: string
): LoginPatchError => ({ ok: false, status, error, message })

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
  const before = loginGrantMode(current.metadata)
  let after = before

  if (input.grantMode !== undefined) {
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
    after = input.grantMode
  }

  if (before === 'self' && after !== 'self' && input.confirmReset !== true) {
    return fail(
      409,
      'managed_grant_reset_needs_confirm',
      'Switching a manage-myself login back to panel-set permissions makes the panel reset its permissions to the chosen set, which removes any grants you made by hand. Send confirmReset: true to go ahead.'
    )
  }

  if (after === 'self' && (input.privileges !== undefined || input.connectionRole !== undefined)) {
    return fail(
      422,
      'managed_self_login_has_no_privileges',
      'A manage-myself login has no panel-set permissions to change. Grant or revoke in SQL, or switch it back to panel-set permissions first.'
    )
  }

  if (input.tool !== undefined && typeof input.tool !== 'boolean') {
    return fail(400, 'Invalid request', 'tool must be true or false.')
  }

  const metadata: Record<string, unknown> = {}
  if (input.grantMode !== undefined) metadata.grantMode = after
  if (input.tool !== undefined) metadata.tool = input.tool
  if (input.databases !== undefined) metadata.databases = input.databases
  if (input.privileges !== undefined) metadata.privileges = input.privileges
  if (input.connectionRole !== undefined) {
    // Stored only for read-only: an absent key is the read-write default.
    metadata.connectionRole = input.connectionRole === 'read-only' ? 'read-only' : undefined
  }

  if (Object.keys(metadata).length === 0 && !(before === 'self' && after !== 'self')) {
    return fail(400, 'Invalid request', 'Nothing to change.')
  }

  const tool = input.tool ?? loginIsTool(current.metadata)
  return {
    ok: true,
    metadata,
    grantMode: after,
    summary: describeApply(engine, after, tool),
  }
}

/** Plain-words statement kinds the next apply runs for this login. */
export function describeApply(engine: string, mode: LoginGrantMode, tool: boolean): string[] {
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
  if (tool) {
    lines.push('Send all of this login traffic to the primary (no read/write splitting)')
  }
  return lines
}
