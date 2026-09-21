/**
 * Read the latest drizzle snapshot (`migrations/meta/NNNN_snapshot.json`)
 * as a flat, ordered description of the shipped schema.
 *
 * Shared by `scripts/schema-comments.mjs` (Postgres `COMMENT ON` delta) and
 * `scripts/generate-data-dictionary.mjs` (website data dictionary). Both
 * describe the schema as it *shipped* — the snapshot behind the newest
 * journal entry — never `schema.ts` directly, so an edit that has not been
 * through `pnpm drizzle-kit generate --name …` cannot leak into comments or
 * docs ahead of its migration.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations')

/** @returns {{ idx: number, tag: string, when: number }[]} journal entries in order */
export function readJournal(migrationsDir = MIGRATIONS_DIR) {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'))
  return journal.entries
}

/**
 * @typedef {{
 *   name: string,
 *   type: string,
 *   notNull: boolean,
 *   primaryKey: boolean,
 *   default: string | undefined,
 *   foreignKey: { table: string, column: string, onDelete: string } | undefined,
 * }} SnapshotColumn
 *
 * @typedef {{
 *   name: string,
 *   columns: SnapshotColumn[],
 *   primaryKey: string[],
 *   uniques: { name: string, columns: string[] }[],
 *   indexes: { name: string, columns: string[], isUnique: boolean, where: string | undefined }[],
 *   checks: { name: string, value: string }[],
 * }} SnapshotTable
 *
 * @typedef {{ tag: string, idx: number, id: string, tables: SnapshotTable[] }} LatestSnapshot
 */

/** @returns {LatestSnapshot} */
export function readLatestSnapshot(migrationsDir = MIGRATIONS_DIR) {
  const entries = readJournal(migrationsDir)
  const last = entries[entries.length - 1]
  const file = path.join(migrationsDir, `meta/${String(last.idx).padStart(4, '0')}_snapshot.json`)
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
  const tables = Object.values(snapshot.tables).map((table) => {
    /** @type {Record<string, { table: string, column: string, onDelete: string }>} */
    const fkByColumn = {}
    for (const fk of Object.values(table.foreignKeys ?? {})) {
      if (fk.columnsFrom.length !== 1) continue
      fkByColumn[fk.columnsFrom[0]] = {
        table: fk.tableTo,
        column: fk.columnsTo[0],
        onDelete: fk.onDelete ?? 'no action',
      }
    }
    const composite = Object.values(table.compositePrimaryKeys ?? {})[0]
    const columns = Object.values(table.columns).map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notNull === true,
      primaryKey: column.primaryKey === true || (composite?.columns ?? []).includes(column.name),
      default: column.default === undefined ? undefined : String(column.default),
      foreignKey: fkByColumn[column.name],
    }))
    return {
      name: table.name,
      columns,
      primaryKey: columns.filter((c) => c.primaryKey).map((c) => c.name),
      uniques: Object.values(table.uniqueConstraints ?? {}).map((u) => ({
        name: u.name,
        columns: u.columns,
      })),
      indexes: Object.values(table.indexes ?? {}).map((i) => ({
        name: i.name,
        columns: i.columns.map((c) => c.expression),
        isUnique: i.isUnique === true,
        where: i.where,
      })),
      checks: Object.values(table.checkConstraints ?? {}).map((c) => ({
        name: c.name,
        value: c.value,
      })),
    }
  })
  return { tag: last.tag, idx: last.idx, id: snapshot.id, tables }
}
