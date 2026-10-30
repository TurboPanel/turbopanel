/**
 * The cluster's backup login: one per cluster, read-only, for a backup tool
 * that copies every database. It is a `login` row with `role = 'backup'` and
 * `recipe = 'backup'`; its rights are not stored. The daemon derives them per
 * engine from `kind: 'backup'` on the apply credential:
 *
 * - PostgreSQL: `pg_read_all_data`, `BYPASSRLS` and `CONNECT` on every database.
 * - MySQL: `SELECT`, `SHOW VIEW`, `TRIGGER`, `EVENT` and `SHOW_ROUTINE` at
 *   global level (`*.*`), so databases made with plain SQL are covered too.
 * - MariaDB: `SELECT`, `SHOW VIEW`, `TRIGGER`, `EVENT`, `LOCK TABLES` and
 *   `SHOW CREATE ROUTINE` at global level.
 *
 * A daemon from before the global grants gives the MySQL and MariaDB rights
 * only on the databases sent in the credential.
 *
 * On the shared front door it is a tool login (always the primary, no
 * read/write split), so a dump in one transaction stays on one server.
 */

import type { Db } from '../../db/connection.ts'
import { MANAGED_BACKUP_LOGIN_FEATURE } from '../../lib/version-wire.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { loginLimitSettings, type LoginLimitFields } from './login-limit-fields.ts'
import { parseLoginAllowedSources } from './login-sources.ts'
import type { LoginSettingsPatch } from './logins.ts'

/** The partial unique index that keeps a cluster to one backup login (`login` table). */
export const BACKUP_LOGIN_UNIQUE_INDEX = 'uniq_login_managed_backup'

/** The name a backup login gets when the request names none. */
export const BACKUP_LOGIN_DEFAULT_NAME = 'backup'

type Refusal = { error: string; message: string }

export const BACKUP_LOGIN_SOURCES_REQUIRED: Refusal = {
  error: 'managed_backup_login_sources_required',
  message:
    "A backup login can read every database, so it must say where it connects from. Choose at least one place, such as 'internal' (this server only) or one of your servers. 'any' is not allowed.",
}

export const BACKUP_LOGIN_EXISTS: Refusal = {
  error: 'managed_backup_login_exists',
  message: 'This cluster already has a backup login. Delete it first to make a new one.',
}

export const BACKUP_LOGIN_NEEDS_DAEMON_UPDATE: Refusal = {
  error: 'managed_backup_login_needs_daemon_update',
  message:
    "This server's TurboPanel daemon is too old to give a backup login its rights. Update the server, then try again.",
}

/**
 * `null` when the request names at least one place the login may connect
 * from (and not `any`); otherwise the 400 answer. A malformed list answers
 * the same plain-words error as any other login.
 */
export function backupLoginSourcesRefusal(raw: unknown): Refusal | null {
  if (raw === undefined || raw === null) return BACKUP_LOGIN_SOURCES_REQUIRED
  const parsed = parseLoginAllowedSources(raw)
  if (parsed === null) return BACKUP_LOGIN_SOURCES_REQUIRED
  if (!Array.isArray(parsed)) return parsed
  return null
}

/** 409 body when the server's daemon cannot give the login its rights; `null` when it can. */
export function backupLoginDaemonRefusal(features: readonly string[]): Refusal | null {
  return features.includes(MANAGED_BACKUP_LOGIN_FEATURE) ? null : BACKUP_LOGIN_NEEDS_DAEMON_UPDATE
}

/** Reads the server's advertised features, then {@link backupLoginDaemonRefusal}. */
export async function refuseBackupLoginOnOldDaemon(
  db: Db,
  serverId: string
): Promise<Refusal | null> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return backupLoginDaemonRefusal(state?.projection?.features ?? [])
}

/**
 * The stored settings of a new backup login: panel-set, a tool login (all
 * traffic to the primary), no listed databases or privileges (the daemon
 * reaches every database from `kind`), and the places it may connect from.
 */
export function backupLoginSettings(limits: LoginLimitFields): LoginSettingsPatch {
  return {
    grantMode: 'recipe',
    tool: true,
    databases: [],
    privileges: [],
    connectionRole: 'read-write',
    ...loginLimitSettings(limits),
  }
}
