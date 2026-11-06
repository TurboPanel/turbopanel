/**
 * Rules for `scripts/dev-migrate-on-start.mjs`, the development control
 * plane's migrate-before-start step. Kept apart from the entry script so the
 * tests can load them without a database client.
 *
 * Rules (owner decision 2026-11-05):
 * - Only migrations that are on `origin/trunk`, byte for byte, are applied
 *   automatically. A migration that exists only on a branch, or was edited
 *   locally, would be applied for good (migrations are forward-only), so it
 *   is refused and left for a person to run by hand.
 * - The check follows what drizzle applies: every entry of the local
 *   `migrations/meta/_journal.json`, read from `<tag>.sql`. Each must be the
 *   entry at the same place in trunk's `migrations/manifest.json` (same tag
 *   and `when`) and its SQL must have trunk's sha256 (the hash drizzle
 *   records). No `git diff` is involved, so an untracked file, a type change
 *   or a file hidden from git cannot slip past.
 * - "Trunk" is the checkout's `origin/trunk`. On a contributor's fork set up by
 *   the dev `setup.sh fork`, `origin` is the fork, so the fork's trunk counts;
 *   that only ever reaches the contributor's own dev database.
 * - Nothing migrates without a backup: a `pg_dump -Fc` inside the local
 *   database container, the same command the daemon's Update and Restart job
 *   builds (turbopaneld `src/dev-host/job.ts` `buildBackupCommand`), written to
 *   the same folder. It assumes that container is the server behind the URL,
 *   as the daemon's job does.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
/** Absolute, so a writable folder early on PATH cannot stand in for git (dev hosts are Debian). */
export const GIT = '/usr/bin/git'

const SAFE_NAME = /^\w[\w.-]{0,62}$/
const SAFE_DIR = /^\/[\w./-]+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** The `entries` of a manifest or journal text; throws when there are none. */
export function parseEntries(text, what) {
  const entries = JSON.parse(text).entries ?? []
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${what} has no entries`)
  }
  return entries
}

/** sha256 of a migration's SQL, as drizzle records it; null when the file is missing. */
export function sqlHash(root, tag) {
  try {
    const sql = fs.readFileSync(path.join(root, 'migrations', `${tag}.sql`), 'utf8')
    return createHash('sha256').update(sql).digest('hex')
  } catch {
    return null
  }
}

/**
 * Why the checkout's migrations may not be applied automatically, or null
 * when they may. `localEntries` are the local manifest's entries (what the
 * schema state is read against), `journalEntries` the local journal's (what
 * drizzle applies), `trunkEntries` trunk's manifest entries, and `hashOf`
 * gives the local SQL's sha256 for a tag (null when missing).
 */
export function trunkRefusal({ localEntries, journalEntries, trunkEntries, hashOf }) {
  for (const [i, entry] of localEntries.entries()) {
    if (trunkEntries[i]?.sha256 !== entry.sha256) {
      return `migration ${entry.tag} is not on ${TRUNK_REF}`
    }
  }
  for (const [i, entry] of journalEntries.entries()) {
    const trunk = trunkEntries[i]
    if (!trunk || trunk.tag !== entry.tag || trunk.when !== entry.when) {
      return `migration ${entry.tag} is not on ${TRUNK_REF}`
    }
    const hash = hashOf(entry.tag)
    if (hash === null) return `migrations/${entry.tag}.sql is missing`
    if (hash !== trunk.sha256) return `migrations/${entry.tag}.sql differs from ${TRUNK_REF}`
  }
  return null
}

/** Trunk's manifest entries, or null when `origin/trunk` cannot be read. */
export function readTrunkEntries(root, git = GIT) {
  const result = spawnSync(git, ['show', `${TRUNK_REF}:migrations/manifest.json`], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  try {
    return parseEntries(result.stdout, `${TRUNK_REF} manifest`)
  } catch {
    return null
  }
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
    // The process id keeps two dumps in the same second apart.
    `f='${backupsDir}'/turbopanel-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump`,
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
