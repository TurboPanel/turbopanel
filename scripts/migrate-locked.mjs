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
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'

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

const url = process.env.TURBOPANEL_DATABASE_URL?.trim()
if (!url) {
  fail('TURBOPANEL_DATABASE_URL is required')
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
  console.log('migrate-locked: waiting for the migration advisory lock…')
  await client`select pg_advisory_lock(${LOCK_KEY_1}, ${LOCK_KEY_2})`
  console.log('migrate-locked: lock acquired, applying migrations…')
  await migrate(db, {
    migrationsFolder: './migrations',
    migrationsTable: 'migration',
    migrationsSchema: 'public',
  })
  console.log('migrate-locked: migrations applied successfully')
} finally {
  await client`select pg_advisory_unlock(${LOCK_KEY_1}, ${LOCK_KEY_2})`
  await client.end()
}
