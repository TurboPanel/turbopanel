#!/usr/bin/env node
/**
 * Upgrade-from-the-previous-release migration check (no-wipes rule).
 *
 * Every schema change ships as a forward-only migration "tested as an upgrade
 * from the previous release". The static guards (manifest freeze, additions
 * only, forward-only) read SQL text; this one runs it:
 *
 *   1. previous release = the newest stable `vX.Y.Z` tag reachable from
 *      `origin/live` (or `live`), falling back to the newest stable tag;
 *   2. that tag's `migrations/` (read from git, not the working tree) is
 *      applied to an empty scratch database;
 *   3. scripts/migration-upgrade-seed.sql inserts representative rows;
 *   4. this checkout's migrations are applied on top with the real deploy
 *      path (check-postgres-compat.mjs, then migrate-locked.mjs);
 *   5. every seeded row must still exist with the values it had, the
 *      migration history must be `current`, and the schema must match a fresh
 *      apply of this checkout's migrations to a second scratch database
 *      (which also gets the seed, so a seed that no longer fits fails in the
 *      change that broke it).
 *
 * The one sanctioned loss: a pending migration carrying `-- breaking-ok:
 * <reason>` (the contract step, see check-migration-forward-only.mjs) may
 * drop or rename the tables and columns it names; seeded rows are compared
 * under the new names and dropped ones are skipped.
 *
 * Only scratch databases named `tp_upgrade_check_*` are created, migrated and
 * dropped. The database in TURBOPANEL_DATABASE_URL is used solely as the
 * connection for CREATE/DROP DATABASE; nothing runs inside it. The role needs
 * CREATEDB. Refuses to run with CLOUDFLARE_ENV set (that is a deploy shell).
 *
 * Usage:
 *   TURBOPANEL_DATABASE_URL=… node scripts/check-migration-upgrade.mjs
 *   TURBOPANEL_DATABASE_URL=… node scripts/check-migration-upgrade.mjs --from v0.1.12
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'
import { hasBreakingOk, stripComments } from './check-migration-forward-only.mjs'
import { REPO_ROOT, readJournal } from './schema-snapshot.mjs'
import {
  compareSchemaState,
  describeSchemaState,
  readAppliedMigrationHashes,
  readShippedMigrationHashes,
} from './schema-state.mjs'

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const LIVE_REFS = ['origin/live', 'live']
const SCRATCH_PREFIX = 'tp_upgrade_check_'
const SEED_PATH = 'scripts/migration-upgrade-seed.sql'
// One identifier, optionally `public.`-qualified and/or double-quoted.
const IDENT = String.raw`(?:"?public"?\.)?("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`

/** Newest `vX.Y.Z` (release candidates and other suffixes ignored), or null. */
export function newestStableTag(tags) {
  const stable = tags
    .map((tag) => tag.trim())
    .filter((tag) => STABLE_TAG.test(tag))
    .map((tag) => ({ tag, parts: tag.match(STABLE_TAG).slice(1).map(Number) }))
  stable.sort(
    (a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]
  )
  return stable[0]?.tag ?? null
}

/** The same connection URL pointed at another database (TCP or `?host=` socket form). */
export function withDatabase(url, database) {
  const match = url.match(/^(postgres(?:ql)?:\/\/[^/]*\/)([^?]*)(\?.*)?$/)
  if (!match) throw new Error('cannot parse TURBOPANEL_DATABASE_URL')
  return `${match[1]}${database}${match[3] ?? ''}`
}

function identName(token) {
  return token.startsWith('"') ? token.slice(1, -1) : token.toLowerCase()
}

/** An empty allowance: nothing may be dropped or renamed. */
export function noAllowance() {
  return {
    droppedTables: new Set(),
    droppedColumns: new Set(),
    tables: new Map(),
    columns: new Map(),
  }
}

/**
 * Tables and columns a `-- breaking-ok` migration drops or renames, merged
 * into `allowance` (`droppedColumns` holds `table.column`; `tables` maps old
 * to new table name; `columns` maps `table.old` to the new column name).
 * Files without the marker add nothing.
 */
export function addBreakingOkAllowance(sql, allowance = noAllowance()) {
  if (!hasBreakingOk(sql)) return allowance
  for (const statement of stripComments(sql).split(';')) {
    const drop = statement.match(
      new RegExp(String.raw`^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]*)`, 'i')
    )
    if (drop) {
      for (const match of drop[1].matchAll(new RegExp(IDENT, 'g'))) {
        if (!/^(cascade|restrict)$/i.test(match[1]))
          allowance.droppedTables.add(identName(match[1]))
      }
      continue
    }
    const alter = statement.match(
      new RegExp(
        String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}\s+([\s\S]*)$`,
        'i'
      )
    )
    if (!alter) continue
    const table = identName(alter[1])
    const actions = alter[2]
    const renameTable = actions.match(new RegExp(String.raw`^RENAME\s+TO\s+${IDENT}`, 'i'))
    if (renameTable) {
      allowance.tables.set(table, identName(renameTable[1]))
      continue
    }
    const dropColumn = new RegExp(String.raw`DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?${IDENT}`, 'gi')
    for (const match of actions.matchAll(dropColumn)) {
      allowance.droppedColumns.add(`${table}.${identName(match[1])}`)
    }
    const renameColumn = actions.match(
      new RegExp(
        String.raw`^RENAME\s+(?!CONSTRAINT\b|TO\b)(?:COLUMN\s+)?${IDENT}\s+TO\s+${IDENT}`,
        'i'
      )
    )
    if (renameColumn) {
      allowance.columns.set(`${table}.${identName(renameColumn[1])}`, identName(renameColumn[2]))
    }
  }
  return allowance
}

function tablesOf(rows) {
  return new Set([...rows.keys()].map((key) => key.slice(0, key.indexOf('('))))
}

/**
 * Seeded rows that changed across the upgrade. `before`/`after` map a row key
 * (`table(pk)`) to its `to_jsonb` object; only columns present before are
 * compared, so a migration may add columns but not drop rows or rewrite
 * existing values. `allowance` (from addBreakingOkAllowance) lets a
 * sanctioned contract migration drop or rename what it names, but only when
 * the old name is really gone afterwards (`tablesAfter`: tables that exist
 * after the upgrade): a name that was dropped and re-added, or swapped in by
 * a rename, is compared like any other.
 */
export function diffRows(before, after, allowance = noAllowance(), tablesAfter = tablesOf(after)) {
  const problems = []
  for (const [key, row] of before) {
    const table = key.slice(0, key.indexOf('('))
    const tableGone = !tablesAfter.has(table)
    if (tableGone && allowance.droppedTables.has(table)) continue
    const renamed = (tableGone && allowance.tables.get(table)) || table
    const next = after.get(`${renamed}${key.slice(table.length)}`)
    if (!next) {
      problems.push(`${key}: row missing after upgrade`)
      continue
    }
    for (const [column, value] of Object.entries(row)) {
      let target = column
      if (!(column in next)) {
        const names = [`${table}.${column}`, `${renamed}.${column}`]
        if (names.some((name) => allowance.droppedColumns.has(name))) continue
        target = names.map((name) => allowance.columns.get(name)).find(Boolean) ?? column
      }
      if (!(target in next)) {
        problems.push(`${key}: column ${column} gone after upgrade`)
      } else if (JSON.stringify(next[target]) !== JSON.stringify(value)) {
        problems.push(
          `${key}: ${column} was ${JSON.stringify(value)}, now ${JSON.stringify(next[target])}`
        )
      }
    }
  }
  return problems
}

/** True when a seed error names an old table or column a pending rename moved away. */
export function seedErrorFromRename(message, allowance) {
  const oldNames = [
    ...allowance.tables.keys(),
    ...[...allowance.columns.keys()].map((name) => name.slice(name.indexOf('.') + 1)),
  ]
  return oldNames.some((name) => message.includes(`"${name}"`))
}

/** Allowance from this checkout's migrations that the previous release does not have. */
function pendingAllowance(tagMigrations) {
  const shipped = new Set(readJournal(tagMigrations).map((entry) => entry.tag))
  const allowance = noAllowance()
  for (const entry of readJournal(path.join(REPO_ROOT, 'migrations'))) {
    if (shipped.has(entry.tag)) continue
    const file = path.join(REPO_ROOT, 'migrations', `${entry.tag}.sql`)
    addBreakingOkAllowance(fs.readFileSync(file, 'utf8'), allowance)
  }
  return allowance
}

/** Differences between two `schemaShape` results, one line per object. */
export function diffSchemas(upgraded, fresh) {
  const problems = []
  for (const category of Object.keys(fresh)) {
    const left = new Set(upgraded[category] ?? [])
    const right = new Set(fresh[category])
    for (const item of left)
      if (!right.has(item)) problems.push(`${category} only after upgrade: ${item}`)
    for (const item of right)
      if (!left.has(item)) problems.push(`${category} only on fresh apply: ${item}`)
  }
  return problems
}

// Each query returns rows describing one kind of schema object; a row's JSON
// is its identity. Column order (ordinal_position) is deliberately left out.
const SHAPE_QUERIES = {
  columns: `select table_name, column_name, data_type, udt_name, is_nullable, column_default,
      character_maximum_length, numeric_precision, numeric_scale, datetime_precision,
      is_identity, is_generated, generation_expression
    from information_schema.columns where table_schema = 'public'`,
  constraints: `select c.conrelid::regclass::text as rel, c.conname, c.contype,
      pg_get_constraintdef(c.oid) as def, c.convalidated
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' and c.conrelid <> 0`,
  indexes: `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'`,
  comments: `select c.relname, a.attname, d.description
    from pg_description d
    join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
    where n.nspname = 'public'`,
  sequences: `select sequencename, data_type, start_value, min_value, max_value, increment_by, cycle
    from pg_sequences where schemaname = 'public'`,
  triggers: `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal`,
  functions: `select p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
  views: `select viewname, definition from pg_views where schemaname = 'public'`,
  types: `select t.typname, t.typtype, coalesce(string_agg(e.enumlabel, ',' order by e.enumsortorder), '') as labels
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    left join pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public' and t.typtype in ('e', 'd') group by t.typname, t.typtype`,
  history: `select hash from public.migration order by created_at, id`,
}

async function schemaShape(sql) {
  const shape = {}
  for (const [category, query] of Object.entries(SHAPE_QUERIES)) {
    const rows = await sql.unsafe(query)
    shape[category] = rows.map((row) => JSON.stringify(row))
  }
  return shape
}

/** Every row of every public table (bar drizzle's bookkeeping), keyed by table + primary key. */
async function rowSnapshot(sql) {
  const tables = await sql`
    select c.relname as table, array_agg(a.attname::text order by a.attname) as pk
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
    where n.nspname = 'public' and i.indisprimary and c.relkind = 'r' and c.relname <> 'migration'
    group by c.relname order by c.relname`
  const rows = new Map()
  for (const { table, pk } of tables) {
    for (const { row } of await sql`select to_jsonb(t) as row from ${sql(table)} t`) {
      rows.set(`${table}(${pk.map((column) => row[column]).join(',')})`, row)
    }
  }
  return rows
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

function previousRelease() {
  for (const ref of LIVE_REFS) {
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
    } catch {
      continue
    }
    const tag = newestStableTag(git('tag', '--merged', ref).split('\n'))
    if (tag) return { tag, how: `newest stable tag on ${ref}` }
  }
  const tag = newestStableTag(git('tag', '--list').split('\n'))
  if (tag) return { tag, how: 'newest stable tag (no live branch found)' }
  throw new Error('no stable vX.Y.Z tag found; fetch tags (git fetch --tags) or pass --from <ref>')
}

/** Writes `<ref>:migrations/` into `dir` and returns the migrations path. */
function extractMigrations(ref, dir) {
  const archive = execFileSync('git', ['archive', '--format=tar', ref, 'migrations'], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  })
  execFileSync('tar', ['-x', '-C', dir], { input: archive })
  return path.join(dir, 'migrations')
}

function connect(url) {
  const parts = resolvePostgresParts(url)
  if (!parts) throw new Error('invalid TURBOPANEL_DATABASE_URL')
  const options = { max: 1, prepare: false, onnotice: () => {} }
  return parts.socketDir
    ? postgres({
        host: parts.socketDir,
        database: parts.database,
        user: parts.user,
        pass: parts.pass,
        ...options,
      })
    : postgres(parts.tcpUrl, options)
}

/** The deploy path (`pnpm migrate`) against one scratch database. */
function migrateCurrent(url, what) {
  console.log(`migration-upgrade: applying this checkout’s migrations ${what}`)
  const env = { ...process.env, TURBOPANEL_DATABASE_URL: url }
  for (const script of ['scripts/check-postgres-compat.mjs', 'scripts/migrate-locked.mjs']) {
    try {
      execFileSync(process.execPath, [script], { cwd: REPO_ROOT, env, stdio: 'inherit' })
    } catch {
      throw new Error(`${script} failed applying this checkout’s migrations ${what} (output above)`)
    }
  }
}

async function withClient(url, fn) {
  const sql = connect(url)
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

async function applySeed(sql, schema) {
  try {
    await sql.unsafe(fs.readFileSync(path.join(REPO_ROOT, SEED_PATH), 'utf8'))
  } catch (err) {
    throw new Error(
      `${SEED_PATH} does not fit ${schema}: ${err instanceof Error ? err.message : String(err)} — update the seed`
    )
  }
}

/** Runs every cleanup step (newest first); a failing step is logged, never thrown. */
async function runCleanups(steps) {
  for (const step of steps.reverse()) {
    try {
      await step()
    } catch (err) {
      console.error(
        `migration-upgrade: cleanup: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

function parseFrom(argv) {
  const index = argv.indexOf('--from')
  if (index === -1) return null
  const ref = argv[index + 1]
  if (!ref) throw new Error('--from needs a tag or commit')
  return ref
}

async function run(baseUrl, from) {
  const { tag, how } = from ? { tag: from, how: '--from' } : previousRelease()
  console.log(`migration-upgrade: previous release ${tag} (${how})`)

  const suffix = `${process.pid}_${Date.now()}`
  const upgradeDb = `${SCRATCH_PREFIX}${suffix}_up`
  const freshDb = `${SCRATCH_PREFIX}${suffix}_fresh`
  const upgradeUrl = withDatabase(baseUrl, upgradeDb)
  const freshUrl = withDatabase(baseUrl, freshDb)
  const problems = []
  const cleanups = []
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-upgrade-check-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const tagMigrations = extractMigrations(tag, dir)
    const allowance = pendingAllowance(tagMigrations)

    const admin = connect(baseUrl)
    cleanups.push(() => admin.end())
    for (const name of [upgradeDb, freshDb]) {
      await admin.unsafe(`create database "${name}"`)
      cleanups.push(() => admin.unsafe(`drop database if exists "${name}" with (force)`))
    }

    let seeded
    await withClient(upgradeUrl, async (sql) => {
      await migrate(drizzle(sql), {
        migrationsFolder: tagMigrations,
        migrationsTable: 'migration',
        migrationsSchema: 'public',
      })
      console.log(`migration-upgrade: applied ${tag} migrations to ${upgradeDb}`)
      const empty = await rowSnapshot(sql)
      await applySeed(sql, `the ${tag} schema`)
      seeded = new Map([...(await rowSnapshot(sql))].filter(([key]) => !empty.has(key)))
      console.log(`migration-upgrade: seeded ${seeded.size} rows`)
    })

    migrateCurrent(upgradeUrl, `on top of ${tag} plus the seed`)
    migrateCurrent(freshUrl, 'to an empty database')

    const shipped = readShippedMigrationHashes(path.join(REPO_ROOT, 'migrations'))
    const upgraded = await withClient(upgradeUrl, async (sql) => {
      const state = compareSchemaState(await readAppliedMigrationHashes(sql), shipped)
      if (state.status !== 'current')
        problems.push(`history after upgrade: ${describeSchemaState(state)}`)
      const tablesAfter = new Set(
        (await sql`select tablename from pg_tables where schemaname = 'public'`).map(
          (row) => row.tablename
        )
      )
      problems.push(...diffRows(seeded, await rowSnapshot(sql), allowance, tablesAfter))
      return schemaShape(sql)
    })
    const fresh = await withClient(freshUrl, async (sql) => {
      const shape = await schemaShape(sql)
      try {
        await applySeed(sql, "this checkout's schema (fresh apply)")
      } catch (err) {
        // One seed cannot name both sides of a rename, so a sanctioned rename
        // defers the seed update to the change after this release ships.
        if (seedErrorFromRename(err.message, allowance)) {
          console.warn(`migration-upgrade: warning (pending breaking-ok rename): ${err.message}`)
        } else {
          problems.push(err.message)
        }
      }
      return shape
    })
    problems.push(...diffSchemas(upgraded, fresh))
  } finally {
    await runCleanups(cleanups)
  }
  return { tag, problems }
}

async function main() {
  const url = process.env.TURBOPANEL_DATABASE_URL?.trim()
  if (!url) {
    console.error('migration-upgrade: TURBOPANEL_DATABASE_URL is required')
    process.exit(1)
  }
  if (process.env.CLOUDFLARE_ENV) {
    console.error(
      'migration-upgrade: CLOUDFLARE_ENV is set (a deploy shell); unset it — this check only uses scratch databases'
    )
    process.exit(1)
  }
  try {
    const { tag, problems } = await run(url, parseFrom(process.argv.slice(2)))
    if (problems.length > 0) {
      for (const problem of problems) console.error(`migration-upgrade: ${problem}`)
      console.error(`migration-upgrade: upgrade from ${tag} FAILED (${problems.length} problems)`)
      process.exit(1)
    }
    console.log(
      `migration-upgrade: upgrade from ${tag} kept every seeded row and matches a fresh apply`
    )
  } catch (err) {
    console.error(`migration-upgrade: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
