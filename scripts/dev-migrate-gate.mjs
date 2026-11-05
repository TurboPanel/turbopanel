/**
 * Pure helpers for `scripts/dev-migrate-on-start.mjs`, the development control
 * plane's migrate-before-start step. Kept apart from the entry script so the
 * tests can load them without a database client.
 *
 * Rules (owner decision 2026-11-05):
 * - Only migrations that are on `origin/trunk`, byte for byte, are applied
 *   automatically. A migration that exists only on a branch, or was edited
 *   locally, would be applied for good (migrations are forward-only), so it
 *   is refused and left for a person to run by hand.
 * - Nothing migrates without a backup: a `pg_dump -Fc` inside the local
 *   database container, the same command the daemon's Update and Restart job
 *   builds (turbopaneld `src/dev-host/job.ts` `buildBackupCommand`), written to
 *   the same folder.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'

/** Set by the instance unit only on a co-located development source install. */
export const DEV_FLAG = 'TURBOPANEL_DEV_SURFACE'
/** Folder for the dumps (the unit sets it to `<daemon state>/dev-updates/backups`). */
export const BACKUP_DIR_VAR = 'TURBOPANEL_DEV_MIGRATE_BACKUP_DIR'
/** Name of the local Postgres container; defaults to the one the dev stack runs. */
export const CONTAINER_VAR = 'TURBOPANEL_DEV_MIGRATE_POSTGRES_CONTAINER'
export const DEFAULT_CONTAINER = 'turbopanel-database'
/** Dumps kept in the backups folder (the daemon's job keeps the same number). */
export const BACKUPS_KEEP = 5
export const TRUNK_REF = 'origin/trunk'

const SAFE_NAME = /^\w[\w.-]{0,62}$/
const SAFE_DIR = /^\/[\w./-]+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Why the pending migrations may not be applied automatically, or null when
 * they may. `localEntries` and `trunkEntries` are manifest entries
 * (`{ tag, sha256 }`); `pending` are the hashes the database lacks;
 * `changedFiles` are migration files that differ from trunk or are not on it.
 */
export function trunkRefusal({ localEntries, trunkEntries, pending, changedFiles }) {
  for (let i = 0; i < localEntries.length; i++) {
    if (trunkEntries[i]?.sha256 !== localEntries[i].sha256) {
      return `migration ${localEntries[i].tag} is not on ${TRUNK_REF}`
    }
  }
  const pendingSet = new Set(pending)
  const pendingTags = localEntries
    .filter((entry) => pendingSet.has(entry.sha256))
    .map((entry) => entry.tag)
  const changed = changedFiles.filter((file) =>
    pendingTags.some((tag) => path.basename(file) === `${tag}.sql`)
  )
  if (changed.length > 0) {
    return `${changed.join(', ')} differs from ${TRUNK_REF}`
  }
  return null
}

/**
 * The shell command `TURBOPANEL_MIGRATE_BACKUP_COMMAND` runs before a
 * migration, or why there is none. The database must be on this machine (a
 * socket URL or a loopback host), the user and database plain names and the
 * folder a plain absolute path; anything else is refused so the migration
 * never runs without a backup.
 */
export function buildDevBackupCommand(url, backupsDir, container) {
  const parts = resolvePostgresParts(url)
  if (!parts) return { error: 'the database URL is not a Postgres URL' }
  if (!parts.socketDir) {
    const host = new URL(parts.tcpUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!LOCAL_HOSTS.has(host)) {
      return { error: `the database is not on this machine (host ${host || 'missing'})` }
    }
  }
  if (!SAFE_NAME.test(parts.user)) return { error: 'no plain user name in the URL' }
  if (!SAFE_NAME.test(parts.database)) return { error: 'no plain database name in the URL' }
  if (!backupsDir || !SAFE_DIR.test(backupsDir) || backupsDir.includes('..')) {
    return { error: `${BACKUP_DIR_VAR} is not a plain absolute path` }
  }
  if (!SAFE_NAME.test(container)) return { error: 'bad container name' }
  const command = [
    'set -eu',
    'umask 077',
    `mkdir -p '${backupsDir}'`,
    `f='${backupsDir}'/turbopanel-$(date -u +%Y%m%dT%H%M%SZ).dump`,
    `trap 'rm -f -- "$f.part"' EXIT`,
    `docker exec ${container} pg_dump -Fc -U '${parts.user}' -d '${parts.database}' > "$f.part"`,
    `test -s "$f.part"`,
    `mv -- "$f.part" "$f"`,
    'trap - EXIT',
    `echo "backup written to $f"`,
  ].join('; ')
  return { command }
}

/** Keep the newest `keep` `turbopanel-*.dump` files (names sort by time). */
export function pruneBackups(dir, keep = BACKUPS_KEEP) {
  let names
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith('turbopanel-') && e.name.endsWith('.dump'))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a))
  } catch {
    return
  }
  for (const name of names.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, name))
    } catch {
      // A dump that cannot be removed is left for the next run.
    }
  }
}
