#!/usr/bin/env node
/**
 * Postgres `COMMENT ON` delta for the schema descriptions.
 *
 * `src/lib/db/schema-descriptions.ts` is the source of truth for every
 * table and column description. Shipped migrations are immutable, so the
 * comments cannot be re-emitted as a full dump each time: this script
 * replays every `COMMENT ON TABLE` / `COMMENT ON COLUMN` statement across
 * `migrations/*.sql` in journal order (last statement wins, `IS NULL`
 * clears) to learn what the database already says, compares that with the
 * descriptions file, and prints only the statements still missing — ready
 * to paste into a new custom migration.
 *
 * Modes:
 *   node scripts/schema-comments.mjs             # print pending statements
 *   node scripts/schema-comments.mjs --check     # exit 1 if anything is pending
 *   node scripts/schema-comments.mjs --all       # full dump (for reference only)
 *
 * Scope: only tables and columns that exist in the latest snapshot are
 * considered, so a description that outlives its column is reported by
 * `schema-descriptions.test.ts`, not turned into a failing statement here.
 * Obvious columns (`id`, `created_at`, `updated_at`, plain parent-link
 * foreign keys — see `isObviousColumn`) are deliberately left without a
 * database comment: the wording would be identical on every table. The
 * data dictionary still spells them out (`STANDARD_COLUMNS`,
 * `parentLinkComment`).
 *
 * See src/lib/db/AGENTS.md → "Schema descriptions" for the full loop.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCHEMA_DESCRIPTIONS } from '../src/lib/db/schema-descriptions.ts'
import { MIGRATIONS_DIR, readJournal, readLatestSnapshot } from './schema-snapshot.mjs'

const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

const COMMENT_RE =
  /COMMENT\s+ON\s+(TABLE|COLUMN)\s+(?:"public"\.)?"([^"]+)"(?:\."([^"]+)")?\s+IS\s+(NULL|'(?:[^']|'')*')\s*;/gi

/** SQL string literal: single quotes doubled. */
export function sqlLiteral(text) {
  return `'${text.replaceAll("'", "''")}'`
}

/** Key for the comment map: `table` or `table.column`. */
function key(table, column) {
  return column === undefined ? table : `${table}.${column}`
}

/**
 * Replay every COMMENT ON statement across the journaled migrations.
 * @returns {Map<string, string | null>} key → comment text (null = cleared)
 */
export function readAppliedComments(migrationsDir = MIGRATIONS_DIR) {
  /** @type {Map<string, string | null>} */
  const applied = new Map()
  for (const entry of readJournal(migrationsDir)) {
    const sql = fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf8')
    for (const match of sql.matchAll(COMMENT_RE)) {
      const [, , table, column, literal] = match
      const value =
        literal.toUpperCase() === 'NULL' ? null : literal.slice(1, -1).replaceAll("''", "'")
      applied.set(key(table, column), value)
    }
  }
  return applied
}

/** What the plain parent-link foreign key comment says (generated, not authored). */
export function parentLinkComment(foreignKey) {
  return `Parent \`${foreignKey.table}\` row (on delete ${foreignKey.onDelete}).`
}

/**
 * The comment every existing table and authored column should carry:
 * table summaries plus the column descriptions from the descriptions file,
 * restricted to tables and columns present in the latest snapshot.
 * @returns {Map<string, string>} key → comment text
 */
export function desiredComments(snapshot = readLatestSnapshot()) {
  /** @type {Map<string, string>} */
  const desired = new Map()
  for (const table of snapshot.tables) {
    const description = SCHEMA_DESCRIPTIONS[table.name]
    if (!description) continue
    if (description.summary) desired.set(key(table.name), description.summary)
    for (const column of table.columns) {
      const authored = description.columns[column.name]
      if (authored) desired.set(key(table.name, column.name), authored)
    }
  }
  return desired
}

/** One COMMENT ON statement. */
export function commentStatement(target, text) {
  const [table, column] = target.split('.')
  const object = column === undefined ? `TABLE "${table}"` : `COLUMN "${table}"."${column}"`
  return `COMMENT ON ${object} IS ${sqlLiteral(text)};`
}

/**
 * Statements whose text differs from what the migrations already applied.
 * Order follows the snapshot (table order, then column order) so the output
 * is stable across runs.
 */
export function pendingStatements({ snapshot = readLatestSnapshot(), migrationsDir = MIGRATIONS_DIR } = {}) {
  const applied = readAppliedComments(migrationsDir)
  const statements = []
  for (const [target, text] of desiredComments(snapshot)) {
    if (applied.get(target) !== text) statements.push(commentStatement(target, text))
  }
  return statements
}

export function allStatements(snapshot = readLatestSnapshot()) {
  return Array.from(desiredComments(snapshot), ([target, text]) => commentStatement(target, text))
}

/** drizzle migration body: statements joined by its breakpoint marker. */
export function migrationBody(statements) {
  return statements.join(`${STATEMENT_BREAKPOINT}\n`) + (statements.length ? '\n' : '')
}

function main(argv) {
  const check = argv.includes('--check')
  const all = argv.includes('--all')
  const statements = all ? allStatements() : pendingStatements()
  if (check) {
    if (statements.length === 0) {
      console.log('schema-comments: every description is carried by a migration')
      return 0
    }
    console.error(
      `schema-comments: ${statements.length} comment statement(s) not yet in any migration — ` +
        'run `pnpm drizzle-kit generate --custom --name <summary>`, paste the output of ' +
        '`node scripts/schema-comments.mjs` into the new file, then ' +
        '`node scripts/check-migration-freeze.mjs --update`'
    )
    return 1
  }
  process.stdout.write(migrationBody(statements))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
