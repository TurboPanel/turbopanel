#!/usr/bin/env node
/**
 * Pre-migration compatibility gate for `pnpm migrate`.
 *
 * The schema baseline (migrations/0000_init.sql) defaults every surrogate
 * primary key to the built-in `uuidv7()`, which ships with PostgreSQL 18.
 * This script connects to the target server before `drizzle-kit migrate`
 * runs and fails fast with a clear message when `uuidv7()` is unavailable,
 * instead of letting the baseline die halfway through on the first DEFAULT.
 *
 * Covered paths: `pnpm migrate` (package.json chains this script before
 * drizzle-kit), which also covers `pnpm deploy` (Workers) and
 * scripts/bootstrap-dev-db.sh. The orchestration Postgres pin
 * (turbopaneld/orchestration/roles/postgres/defaults/main.yml,
 * `postgres_image: postgres:18`) must stay >= this requirement.
 */
import postgres from 'postgres'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'

const MINIMUM_POSTGRES_MAJOR = 18

function fail(message) {
  console.error(`check-postgres-compat: ${message}`)
  process.exit(1)
}

const url = process.env.TURBOPANEL_DATABASE_URL?.trim()
if (!url) {
  // Same requirement as drizzle.config.mjs (drizzleDbCredentialsFromEnv).
  fail('TURBOPANEL_DATABASE_URL is required')
}
const parts = resolvePostgresParts(url)
if (!parts) {
  fail('invalid TURBOPANEL_DATABASE_URL')
}

const options = { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} }
// Unix-socket libpq URLs (`?host=/dir`) need the connection-object form —
// postgres.js string parsing rejects the `@/db` shape (same as src/db.ts).
const sql = parts.socketDir
  ? postgres({
      host: parts.socketDir,
      database: parts.database,
      user: parts.user,
      pass: parts.pass,
      ...options,
    })
  : postgres(parts.tcpUrl ?? url, options)

try {
  let serverVersion
  try {
    const [row] = await sql`
      select current_setting('server_version') as version,
             current_setting('server_version_num')::int as version_num`
    serverVersion = row
  } catch (error) {
    fail(
      `cannot reach the target PostgreSQL server (${error?.message ?? error}) — ` +
        'check TURBOPANEL_DATABASE_URL before running migrations',
    )
  }

  let uuidv7Available = true
  try {
    await sql`select uuidv7()`
  } catch {
    uuidv7Available = false
  }

  if (!uuidv7Available) {
    fail(
      `the connected server is PostgreSQL ${serverVersion.version} and has no uuidv7() — ` +
        `turbopanel migrations require PostgreSQL ${MINIMUM_POSTGRES_MAJOR} or newer ` +
        '(the schema defaults primary keys to the built-in uuidv7()). ' +
        'Upgrade the server; the orchestration pin is postgres:18 ' +
        '(turbopaneld/orchestration/roles/postgres/defaults/main.yml).',
    )
  }

  if (serverVersion.version_num < MINIMUM_POSTGRES_MAJOR * 10000) {
    // uuidv7() resolved on an older server (e.g. an extension shim) — allow
    // it, but flag the drift from the documented PostgreSQL 18 minimum.
    console.warn(
      `check-postgres-compat: warning — PostgreSQL ${serverVersion.version} is below the ` +
        `documented minimum ${MINIMUM_POSTGRES_MAJOR}, but uuidv7() is available; proceeding`,
    )
  }

  console.log(
    `check-postgres-compat: PostgreSQL ${serverVersion.version} with uuidv7() — ok`,
  )
} finally {
  await sql.end({ timeout: 5 })
}
