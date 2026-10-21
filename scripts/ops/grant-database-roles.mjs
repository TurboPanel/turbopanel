#!/usr/bin/env node
/**
 * Owner-run ops script (NOT a migration): gives the panel's database roles
 * their grants and proves they work.
 *
 * Migrations run as the migrate role, which owns every table and cannot create
 * or reconfigure other roles, so the runtime roles' grants live here. A schema
 * drop-and-recreate removes them; run this afterwards (and after the
 * migration, for the cached role's tables). Safe to run any number of times.
 *
 * Connect as the migrate role (the owner of the tables): a `GRANT ... ON ALL
 * TABLES` run by any other account only warns "no privileges were granted" and
 * changes nothing, so this script refuses to continue if it does not own the
 * tables it finds.
 *
 * What it does, in the public schema:
 *   - runtime role: USAGE on the schema, read/write on every existing table,
 *     and default privileges so each table the migration creates later is
 *     read/write for it at once (plus sequences, none exist today);
 *   - cached read role (optional): USAGE on the schema and SELECT on the few
 *     tables the cached read models query, nothing else;
 *   - then a check with the has_*_privilege functions (the admin cannot SET
 *     ROLE to these roles) and a non-zero exit if any grant is missing.
 *
 * Usage (nothing is changed without --confirm):
 *   TURBOPANEL_DATABASE_URL=<migrate role url> \
 *   TURBOPANEL_RUNTIME_DB_ROLE=production \
 *   TURBOPANEL_CACHED_DB_ROLE=production_cached \
 *   node scripts/ops/grant-database-roles.mjs --confirm [--check-only]
 *
 * `--check-only` changes nothing and only reports. The output names roles and
 * tables, never the connection string or password.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { resolvePostgresParts } from '../resolve-postgres-url.mjs'
import { assertMigrateTargetMatchesEnv } from '../check-deploy-env.mjs'

/** Tables the cached read models query (src/query-cache/read-models/). Add new ones here. */
export const CACHED_READ_TABLES = ['server', 'license', 'project', 'environment', 'workspace']
/** A table the cached role must NOT be able to read. */
const CACHED_DENIED_TABLE = 'setting'
const PROBE_TABLE = 'setting'
const ROLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

export function quoteIdent(name) {
  if (!ROLE_NAME_RE.test(name)) throw new Error(`invalid role name: ${JSON.stringify(name)}`)
  return `"${name}"`
}

/** Role names come from the environment; the cached role is optional. */
export function readRoleNames(env) {
  const runtime = env.TURBOPANEL_RUNTIME_DB_ROLE?.trim()
  const cached = env.TURBOPANEL_CACHED_DB_ROLE?.trim() || null
  if (!runtime) throw new Error('TURBOPANEL_RUNTIME_DB_ROLE is required')
  quoteIdent(runtime)
  if (cached) quoteIdent(cached)
  if (cached === runtime) throw new Error('the cached role must differ from the runtime role')
  return { runtime, cached }
}

/** The statements that change grants, in order. Pure, so tests can read them. */
export function buildGrantStatements({ runtime, cached }, cachedTables) {
  const r = quoteIdent(runtime)
  const statements = [
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${r}`,
  ]
  if (cached) {
    const c = quoteIdent(cached)
    statements.push(`GRANT USAGE ON SCHEMA public TO ${c}`)
    if (cachedTables.length > 0) {
      const list = cachedTables.map((t) => `public.${quoteIdent(t)}`).join(', ')
      statements.push(`GRANT SELECT ON ${list} TO ${c}`)
    }
  }
  return statements
}

async function existingTables(client) {
  const rows = await client`select tablename from pg_tables where schemaname = 'public'`
  return new Set(rows.map((row) => row.tablename))
}

async function assertRolesExist(client, roles) {
  const names = roles.filter(Boolean)
  const rows = await client`select rolname from pg_roles where rolname = any(${names})`
  const found = new Set(rows.map((row) => row.rolname))
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`role(s) do not exist: ${missing.join(', ')}`)
}

async function assertOwnsTables(client) {
  const [row] = await client`
    select count(*)::int as foreign_tables, current_user::text as me
    from pg_tables where schemaname = 'public' and tableowner <> current_user
  `
  if (row.foreign_tables > 0) {
    throw new Error(
      `${row.foreign_tables} table(s) in public are not owned by ${row.me}; connect as the migrate ` +
        'role (the table owner), otherwise the grants would silently do nothing'
    )
  }
}

/** Table-level checks the report asks for; returns [{ name, ok }]. */
export async function checkGrants(client, { runtime, cached }, tables) {
  const checks = []
  const ask = async (name, sqlText, params) => {
    const [row] = await client.unsafe(`select ${sqlText} as ok`, params)
    checks.push({ name, ok: row.ok === true })
  }
  await ask(
    `${runtime} can connect`,
    `has_database_privilege($1::name, current_database(), 'CONNECT')`,
    [runtime]
  )
  await ask(
    `${runtime} can use schema public`,
    `has_schema_privilege($1::name, 'public', 'USAGE')`,
    [runtime]
  )
  if (tables.has(PROBE_TABLE)) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      await ask(
        `${runtime} can ${priv} on ${PROBE_TABLE}`,
        `has_table_privilege($1::name, 'public.${PROBE_TABLE}', '${priv}')`,
        [runtime]
      )
    }
  }
  const [defaults] = await client.unsafe(
    `select count(*)::int as n from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace,
      lateral aclexplode(d.defaclacl) a
      join pg_roles g on g.oid = a.grantee
     where n.nspname = 'public' and d.defaclrole = current_user::regrole
       and d.defaclobjtype = 'r' and g.rolname = $1 and a.privilege_type = 'INSERT'`,
    [runtime]
  )
  checks.push({ name: `new tables inherit grants for ${runtime}`, ok: defaults.n > 0 })
  if (cached) {
    await ask(
      `${cached} can use schema public`,
      `has_schema_privilege($1::name, 'public', 'USAGE')`,
      [cached]
    )
    for (const table of CACHED_READ_TABLES.filter((t) => tables.has(t))) {
      await ask(
        `${cached} can SELECT on ${table}`,
        `has_table_privilege($1::name, 'public.${table}', 'SELECT')`,
        [cached]
      )
    }
    if (tables.has(CACHED_DENIED_TABLE)) {
      await ask(
        `${cached} cannot read ${CACHED_DENIED_TABLE}`,
        `not has_table_privilege($1::name, 'public.${CACHED_DENIED_TABLE}', 'SELECT')`,
        [cached]
      )
    }
  }
  return checks
}

/**
 * Applies (unless checkOnly) and checks. Returns { ok, lines } where lines are
 * printable results. Throws on refusals (missing role, foreign table owner).
 */
export async function grantDatabaseRoles(client, names, { checkOnly = false } = {}) {
  const lines = []
  await assertRolesExist(client, [names.runtime, names.cached])
  const tables = await existingTables(client)
  if (!checkOnly) {
    await assertOwnsTables(client)
    const cachedTables = CACHED_READ_TABLES.filter((t) => tables.has(t))
    await client.begin(async (tx) => {
      for (const statement of buildGrantStatements(names, cachedTables)) await tx.unsafe(statement)
    })
    lines.push(`applied grants for ${names.runtime}${names.cached ? ` and ${names.cached}` : ''}`)
    const pending = CACHED_READ_TABLES.filter((t) => !tables.has(t))
    if (names.cached && pending.length > 0) {
      lines.push(
        `PENDING: tables not created yet (${pending.join(', ')}); run again after the migration`
      )
    }
  }
  lines.push(`public tables: ${tables.size}`)
  const checks = await checkGrants(client, names, tables)
  for (const check of checks) lines.push(`${check.ok ? 'ok     ' : 'MISSING'} ${check.name}`)
  return { ok: checks.every((check) => check.ok), lines }
}

function fail(message) {
  console.error(`grant-database-roles: ${message}`)
  process.exit(1)
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check-only')
  if (!checkOnly && !args.includes('--confirm')) {
    fail('refusing to change grants without --confirm (use --check-only to just report)')
  }
  const url = process.env.TURBOPANEL_DATABASE_URL?.trim()
  if (!url) fail('TURBOPANEL_DATABASE_URL (the migrate role) is required')
  let names
  try {
    names = readRoleNames(process.env)
    console.log(`grant-database-roles: ${await assertMigrateTargetMatchesEnv()}`)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  const parts = resolvePostgresParts(url)
  if (!parts) fail('invalid TURBOPANEL_DATABASE_URL')
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
  try {
    const { ok, lines } = await grantDatabaseRoles(client, names, { checkOnly })
    for (const line of lines) console.log(`grant-database-roles: ${line}`)
    if (!ok) fail('database roles lack grants (see MISSING above)')
    console.log('grant-database-roles: all grants present')
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  } finally {
    await client.end({ timeout: 5 })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
