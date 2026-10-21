#!/usr/bin/env node
/**
 * Advisory-locked migration runner (schema-migrate-hygiene, Road-to-0.1.x).
 *
 * `drizzle-kit migrate` (the CLI) takes no lock — confirmed against
 * `drizzle-orm`'s `PgDialect.migrate`: it reads the last-applied migration
 * row, then runs every migration newer than it inside one transaction, with
 * nothing serializing two concurrent callers. Postgres DDL is transactional,
 * so a second concurrent deploy does not corrupt the schema — its whole
 * transaction rolls back — but it still fails that deploy with a confusing
 * mid-DDL error instead of simply waiting its turn.
 *
 * A `pg_advisory_lock` has to be taken on the *same connection* that runs the
 * migration — a wrapper that takes the lock and then shells out to a
 * separate `drizzle-kit migrate` subprocess protects nothing, since that
 * subprocess opens its own unlocked connection. This script replaces the
 * `drizzle-kit migrate` CLI call with the programmatic
 * `drizzle-orm/postgres-js/migrator` `migrate()`, on one client, wrapped in a
 * blocking advisory lock: a second concurrent caller waits rather than
 * racing, and finds nothing left to apply once it acquires the lock.
 *
 * `migrationsTable`/`migrationsSchema` below must match `drizzle.config.mjs`
 * exactly (`migration` / `public`) — the programmatic migrator defaults to
 * `__drizzle_migrations` in the `drizzle` schema, a *different* bookkeeping
 * table from the one `drizzle-kit migrate` and this repo's baseline use; get
 * this wrong and every migration replays into a second, shadow table.
 */
import fs from 'node:fs'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'
import { runMigrateBackup } from './migrate-backup.mjs'
import { assertMigrateTargetMatchesEnv, stripJsonc } from './check-deploy-env.mjs'
import {
  compareSchemaState,
  describeSchemaState,
  readAppliedMigrationHashes,
  readShippedMigrationHashes,
} from './schema-state.mjs'

// Arbitrary fixed two-int4 advisory-lock key, scoped to this repo's
// migration runner specifically (not shared with any other lock use).
// Recognizable in `pg_locks` (`select * from pg_locks where locktype =
// 'advisory'`) rather than meaningful beyond being a stable constant.
const LOCK_KEY_1 = 0x54425043 // 'TBPC'
const LOCK_KEY_2 = 0x4d494752 // 'MIGR'

function fail(message) {
  console.error(`migrate-locked: ${message}`)
  process.exit(1)
}

// Testing and staging reach their databases through the managed database
// listener, a pooling proxy that refuses a session advisory lock ("Feature not
// supported"). They may skip the lock with TURBOPANEL_MIGRATE_NO_LOCK=1. Any
// other environment (live, local) keeps the lock: skipping it there is refused.
const NO_LOCK_ENVS = new Set(['testing', 'staging'])
// The variable comes from the build's environment or from that environment's
// `vars` in wrangler.jsonc (a build variable is not needed in the dashboard).
function wranglerVar(envName, key) {
  try {
    const config = JSON.parse(stripJsonc(fs.readFileSync('./wrangler.jsonc', 'utf8')))
    return config.env?.[envName]?.vars?.[key]
  } catch {
    return undefined
  }
}
const cloudflareEnv = process.env.CLOUDFLARE_ENV?.trim() ?? ''
const skipLock =
  String(
    process.env.TURBOPANEL_MIGRATE_NO_LOCK?.trim() ||
      wranglerVar(cloudflareEnv, 'TURBOPANEL_MIGRATE_NO_LOCK') ||
      ''
  ).trim() === '1'
if (skipLock && !NO_LOCK_ENVS.has(cloudflareEnv)) {
  fail('TURBOPANEL_MIGRATE_NO_LOCK=1 is only allowed when CLOUDFLARE_ENV is testing or staging')
}

const url = process.env.TURBOPANEL_DATABASE_URL?.trim()
if (!url) {
  fail('TURBOPANEL_DATABASE_URL is required')
}

// Under `pnpm deploy` (CLOUDFLARE_ENV set): refuse a URL that is not this
// env's Hyperdrive origin. See scripts/check-deploy-env.mjs.
try {
  console.log(`migrate-locked: ${await assertMigrateTargetMatchesEnv()}`)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const parts = resolvePostgresParts(url)
if (!parts) {
  fail('invalid TURBOPANEL_DATABASE_URL')
}

const options = { max: 1, prepare: false, onnotice: () => {} }
const client = parts.socketDir
  ? postgres({
      host: parts.socketDir,
      database: parts.database,
      user: parts.user,
      pass: parts.pass,
      ...options,
    })
  : postgres(parts.tcpUrl ?? url, options)

const db = drizzle(client)

try {
  if (skipLock) {
    console.log(
      `migrate-locked: advisory lock skipped (TURBOPANEL_MIGRATE_NO_LOCK=1, env ${cloudflareEnv}); do not run two migrations at once`
    )
  } else {
    console.log('migrate-locked: waiting for the migration advisory lock…')
    await client`select pg_advisory_lock(${LOCK_KEY_1}, ${LOCK_KEY_2})`
  }
  // Refuse a database whose history this checkout does not ship (a newer
  // release, or the pre-freeze baseline) — see scripts/schema-state.mjs.
  // Read under the lock so a concurrent migrate cannot change the answer.
  const state = compareSchemaState(
    await readAppliedMigrationHashes(client),
    readShippedMigrationHashes('./migrations')
  )
  if (state.status === 'ahead' || state.status === 'diverged') {
    throw new Error(describeSchemaState(state))
  }
  console.log(`migrate-locked: ${describeSchemaState(state)}`)
  // Back up before anything changes (no wipes: rollback is a restore). Runs
  // under the lock, so no other migration slips in between dump and migrate.
  if (state.status !== 'current') runMigrateBackup(process.env)
  console.log(`migrate-locked: ${skipLock ? 'applying' : 'lock acquired, applying'} migrations…`)
  await migrate(db, {
    migrationsFolder: './migrations',
    migrationsTable: 'migration',
    migrationsSchema: 'public',
  })
  console.log('migrate-locked: migrations applied successfully')
} catch (err) {
  console.error(`migrate-locked: ${err instanceof Error ? err.message : String(err)}`)
  // The migrator wraps the database's own error as "Failed query: …"; print what
  // the server (or the proxy in front of it) actually said.
  const cause = err instanceof Error ? err.cause : undefined
  if (cause) {
    console.error(
      `migrate-locked: cause: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    if (cause.code) console.error(`migrate-locked: cause code: ${cause.code}`)
  }
  process.exitCode = 1
} finally {
  if (!skipLock) {
    await client`select pg_advisory_unlock(${LOCK_KEY_1}, ${LOCK_KEY_2})`
  }
  await client.end()
}
