#!/usr/bin/env node
/**
 * Development control plane only: bring the local database up to this
 * checkout's migrations before the instance starts, so a restart can never
 * leave the dev box serving code against an older schema (owner decision
 * 2026-11-05; the Deno instance itself refuses to start on anything but a
 * current schema, `src/platform/deno/server.ts`).
 *
 * The instance unit runs it as `ExecStartPre` on a co-located source install
 * (turbopaneld `orchestration/roles/instance-launch/templates/
 * turbopanel-instance.service.j2`). It reads the same environment as the
 * instance: `TURBOPANEL_DATABASE_URL`, `TURBOPANEL_DEV_SURFACE=1`, and
 * `TURBOPANEL_DEV_MIGRATE_BACKUP_DIR` for the dumps.
 *
 * - Schema current: exit 0 at once (no git, no backup).
 * - Pending migrations that are all on `origin/trunk`, unchanged: back up,
 *   then `check-postgres-compat.mjs` and `migrate-locked.mjs` (the same steps
 *   as `pnpm migrate`); the newest five dumps are kept.
 * - Anything else (a migration only on a branch or edited locally, no
 *   `origin/trunk`, no usable backup, a history this checkout does not ship):
 *   exit 1 with one plain line, and the instance does not start.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import {
  BACKUP_DIR_VAR,
  buildDevBackupCommand,
  CONTAINER_VAR,
  DEFAULT_CONTAINER,
  DEV_FLAG,
  pruneBackups,
  TRUNK_REF,
  trunkRefusal,
} from './dev-migrate-gate.mjs'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'
import {
  compareSchemaState,
  describeSchemaState,
  readAppliedMigrationHashes,
} from './schema-state.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BY_HAND = 'Apply it by hand with `pnpm migrate` if that is intended.'

function log(line) {
  console.log(`dev-migrate-on-start: ${line}`)
}

function fail(line) {
  console.error(`dev-migrate-on-start: ${line}`)
  process.exit(1)
}

/** Absolute, so a writable folder early on PATH cannot stand in for git (dev hosts are Debian). */
const GIT = '/usr/bin/git'

function git(args) {
  const result = spawnSync(GIT, args, { cwd: ROOT, encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout ?? '' }
}

function manifestEntries(text) {
  const entries = JSON.parse(text).entries ?? []
  if (entries.length === 0 || entries.some((e) => typeof e.sha256 !== 'string')) {
    throw new Error('the migrations manifest has no usable entries')
  }
  return entries
}

async function readState(url, shipped) {
  const parts = resolvePostgresParts(url)
  if (!parts) fail('TURBOPANEL_DATABASE_URL is not a Postgres URL')
  const options = { max: 1, prepare: false, onnotice: () => {} }
  const client = parts.socketDir
    ? postgres({
        host: parts.socketDir,
        database: parts.database,
        user: parts.user,
        pass: parts.pass,
        ...options,
      })
    : postgres(parts.tcpUrl, options)
  try {
    return compareSchemaState(await readAppliedMigrationHashes(client), shipped)
  } finally {
    await client.end()
  }
}

function runNode(script, env) {
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, env, stdio: 'inherit' })
  return result.status ?? 1
}

async function main() {
  const env = process.env
  if (env[DEV_FLAG]?.trim() !== '1') {
    log('not a development control plane; nothing to do')
    return 0
  }
  const url = env.TURBOPANEL_DATABASE_URL?.trim()
  if (!url) fail('TURBOPANEL_DATABASE_URL is required')

  const localEntries = manifestEntries(
    fs.readFileSync(path.join(ROOT, 'migrations', 'manifest.json'), 'utf8')
  )
  const state = await readState(
    url,
    localEntries.map((e) => e.sha256)
  )
  if (state.status === 'current') {
    log(`database is current (${state.applied} migrations)`)
    return 0
  }
  if (state.status === 'ahead' || state.status === 'diverged') {
    fail(describeSchemaState(state))
  }
  const pending = state.status === 'behind' ? state.pending : localEntries.map((e) => e.sha256)
  log(`${pending.length} migration(s) pending`)

  const trunk = git(['show', `${TRUNK_REF}:migrations/manifest.json`])
  if (!trunk.ok) {
    fail(
      `cannot read ${TRUNK_REF} in ${ROOT} (run \`git fetch origin trunk\`); not migrating. ${BY_HAND}`
    )
  }
  const changed = git(['diff', '--name-only', '--diff-filter=AM', TRUNK_REF, '--', 'migrations'])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'migrations'])
  if (!changed.ok || !untracked.ok) fail(`cannot compare migrations with ${TRUNK_REF}`)
  const refusal = trunkRefusal({
    localEntries,
    trunkEntries: manifestEntries(trunk.stdout),
    pending,
    changedFiles: `${changed.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean),
  })
  if (refusal) fail(`${refusal}; not applying it automatically. ${BY_HAND}`)

  const backupsDir = env[BACKUP_DIR_VAR]?.trim() ?? ''
  const backup = buildDevBackupCommand(
    url,
    backupsDir,
    env[CONTAINER_VAR]?.trim() || DEFAULT_CONTAINER
  )
  if ('error' in backup) fail(`cannot take a database backup (${backup.error}); not migrating`)

  const migrateEnv = { ...env, TURBOPANEL_MIGRATE_BACKUP_COMMAND: backup.command }
  const code =
    runNode(path.join(ROOT, 'scripts', 'check-postgres-compat.mjs'), migrateEnv) ||
    runNode(path.join(ROOT, 'scripts', 'migrate-locked.mjs'), migrateEnv)
  pruneBackups(backupsDir)
  if (code !== 0) fail('migration failed; the control plane is not started')
  log('migrations applied')
  return 0
}

try {
  process.exitCode = await main()
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
