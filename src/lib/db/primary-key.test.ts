/**
 * Guard: every application table has a PRIMARY KEY, and that key is a UUID
 * (`uuid … DEFAULT uuidv7()`) or an explicitly allowlisted natural key.
 * Sequence-backed keys (`serial` family, identity columns, `nextval()`
 * defaults) are rejected in application table definitions. Scans every
 * NNNN_*.sql file under migrations/.
 *
 * Rationale: the supported multi-node model is primary/standby replication
 * with one writable primary — UUIDv7 keys avoid sequence coordination across
 * writers and failovers. See src/lib/db/AGENTS.md (Multi-node PostgreSQL
 * model).
 */

import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Application tables whose primary key is intentionally a natural key rather
 * than a `DEFAULT uuidv7()` surrogate. Keep this list minimal — every entry
 * needs a reason.
 *
 * | Table | PK column | Why |
 * | --- | --- | --- |
 * | `dispatch` | `command_id` | 1:1 payload row keyed by the owning `command.id` (itself uuidv7); a second surrogate id would be dead weight |
 */
const NATURAL_KEY_PRIMARY_KEYS = new Map<string, string>([['dispatch', 'command_id']])

const CREATE_TABLE_BLOCK_RE = /CREATE\s+TABLE\s+"([^"]+)"\s*\(([\s\S]*?)\n\);/gi

/** Inline column PK: `"col" <type> … PRIMARY KEY …` on one line. */
const INLINE_PK_LINE_RE = /^\s*"([^"]+)"\s+(\w+)\b([^\n]*)\bPRIMARY KEY\b([^\n]*)$/

/**
 * Sequence-backed column shapes forbidden in application tables. `serial` /
 * `bigserial` / `smallserial` pseudo-types, SQL-standard identity columns,
 * and explicit `nextval()` defaults all pin inserts to a node-local sequence.
 */
const SEQUENCE_BACKED_RE =
  /\b(?:small|big)?serial\b|GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY|nextval\s*\(/i

type TableBlock = { name: string; body: string; file: string }

async function readMigrationTableBlocks(): Promise<TableBlock[]> {
  const here = dirname(fromFileUrl(import.meta.url))
  const migrationsDir = join(here, '../../../migrations')
  const sqlFiles: string[] = []
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (!entry.isFile) continue
    if (!/^\d{4}_.*\.sql$/.test(entry.name)) continue
    sqlFiles.push(entry.name)
  }
  sqlFiles.sort((a, b) => a.localeCompare(b))
  if (sqlFiles.length === 0) {
    throw new TypeError('expected at least one NNNN_*.sql file under migrations/')
  }

  const blocks: TableBlock[] = []
  for (const file of sqlFiles) {
    const sql = await Deno.readTextFile(join(migrationsDir, file))
    for (const match of sql.matchAll(CREATE_TABLE_BLOCK_RE)) {
      const [, name, body] = match
      if (name !== undefined && body !== undefined) {
        blocks.push({ name, body, file })
      }
    }
  }
  if (blocks.length === 0) {
    throw new TypeError(
      'expected at least one CREATE TABLE in scanned migration SQL files under migrations/',
    )
  }
  return blocks
}

function primaryKeyLines(body: string): string[] {
  return body.split('\n').filter((line) => /\bPRIMARY KEY\b/i.test(line))
}

test('migrations/ every CREATE TABLE has a PRIMARY KEY', async () => {
  const blocks = await readMigrationTableBlocks()
  for (const { name, body, file } of blocks) {
    if (primaryKeyLines(body).length === 0) {
      throw new TypeError(
        `table "${name}" in ${file} has no PRIMARY KEY — every application table must declare one`,
      )
    }
  }
})

test('migrations/ primary keys are uuidv7 UUIDs or an allowlisted natural key', async () => {
  const blocks = await readMigrationTableBlocks()
  const seenNaturalKeyTables = new Set<string>()

  for (const { name, body, file } of blocks) {
    for (const line of primaryKeyLines(body)) {
      const inline = INLINE_PK_LINE_RE.exec(line)
      if (!inline) {
        // Table-level `CONSTRAINT … PRIMARY KEY (…)` (composite) is not used
        // today; adding one is a deliberate schema-design decision that must
        // extend this guard, not slip past it.
        throw new TypeError(
          `table "${name}" in ${file} declares a PRIMARY KEY this guard cannot parse ` +
            `(expected an inline column PK): ${line.trim()}`,
        )
      }
      const [, column, type] = inline
      if (type?.toLowerCase() !== 'uuid') {
        throw new TypeError(
          `table "${name}" primary key "${column}" in ${file} has type "${type}" — ` +
            `application primary keys must be uuid`,
        )
      }
      const allowedNaturalKey = NATURAL_KEY_PRIMARY_KEYS.get(name)
      if (allowedNaturalKey !== undefined) {
        if (column !== allowedNaturalKey) {
          throw new TypeError(
            `table "${name}" primary key is "${column}" but the allowlist expects ` +
              `natural key "${allowedNaturalKey}"`,
          )
        }
        seenNaturalKeyTables.add(name)
        continue
      }
      if (!/DEFAULT uuidv7\(\)/.test(line)) {
        throw new TypeError(
          `table "${name}" primary key "${column}" in ${file} lacks DEFAULT uuidv7() — ` +
            `use a uuidv7 surrogate key or add a documented natural-key allowlist entry`,
        )
      }
    }
  }

  // Every allowlisted natural key must still exist (no stale exceptions)
  for (const [table, column] of [...NATURAL_KEY_PRIMARY_KEYS].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (!seenNaturalKeyTables.has(table)) {
      throw new TypeError(
        `natural-key allowlist entry "${table}"."${column}" is not present in scanned ` +
          `migration SQL files under migrations/ — remove it from the test allowlist`,
      )
    }
  }
})

test('migrations/ application tables have no sequence-backed columns', async () => {
  const blocks = await readMigrationTableBlocks()
  for (const { name, body, file } of blocks) {
    const match = SEQUENCE_BACKED_RE.exec(body)
    if (match) {
      throw new TypeError(
        `table "${name}" in ${file} uses a sequence-backed column (${match[0].trim()}) — ` +
          `serial / identity / nextval() are forbidden in application tables`,
      )
    }
  }
})

/**
 * Documented exception: `public.migration` — drizzle-kit's bookkeeping table
 * (configured in drizzle.config.mjs). It is created by drizzle-orm's
 * `PgDialect.migrate`, not by SQL under migrations/, as:
 *
 *   CREATE TABLE IF NOT EXISTS "public"."migration" (
 *     id SERIAL PRIMARY KEY,
 *     hash text NOT NULL,
 *     created_at bigint
 *   )
 *
 * It has a primary key but the key is sequence-backed (SERIAL). That is
 * acceptable because the table is written only while `pnpm migrate` runs —
 * an operator-controlled, single-writer operation against the primary —
 * never at request time and never from concurrent writers. This test pins
 * the vendored migrator DDL so a drizzle-orm upgrade that changes the
 * bookkeeping shape forces this audit (and src/lib/db/AGENTS.md,
 * "Documented exception: public.migration") to be revisited.
 */
test('drizzle-orm migrator bookkeeping DDL matches the documented public.migration audit', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const dialectPath = join(here, '../../../node_modules/drizzle-orm/pg-core/dialect.js')
  let source: string
  try {
    source = await Deno.readTextFile(dialectPath)
  } catch {
    throw new TypeError(
      `cannot read ${dialectPath} — run pnpm install before the db guard tests`,
    )
  }
  const createIdx = source.indexOf('CREATE TABLE IF NOT EXISTS')
  if (createIdx === -1) {
    throw new TypeError(
      'drizzle-orm PgDialect.migrate no longer contains its bookkeeping CREATE TABLE — ' +
        're-audit public.migration and update src/lib/db/AGENTS.md',
    )
  }
  const ddl = source.slice(createIdx, createIdx + 400)
  for (const expected of ['id SERIAL PRIMARY KEY', 'hash text NOT NULL', 'created_at bigint']) {
    if (!ddl.includes(expected)) {
      throw new TypeError(
        `drizzle-orm migrator bookkeeping DDL changed (missing "${expected}") — ` +
          're-audit public.migration and update src/lib/db/AGENTS.md',
      )
    }
  }
  assertEquals(NATURAL_KEY_PRIMARY_KEYS.size, 1)
})
