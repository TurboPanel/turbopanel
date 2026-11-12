#!/usr/bin/env node
/**
 * Print the schema documentation: every table and column of the shipped
 * schema with its description.
 *
 * `src/db/schema-descriptions.ts` is the source of the wording and
 * `migrations/meta/NNNN_snapshot.json` (the snapshot behind the newest journal
 * entry) is the source of the structure, so a column the descriptions do not
 * name still appears with its type. The database carries no comments; this
 * export is how a docs page is produced.
 *
 * Modes:
 *   node scripts/schema-docs.mjs            # Markdown, grouped by data dictionary group
 *   node scripts/schema-docs.mjs --json     # the same content as JSON
 *
 * Obvious columns (`id`, `created_at`, `updated_at`, plain parent links; see
 * `isObviousColumn`) get the generic wording below, never a per-table sentence.
 * See src/db/AGENTS.md → "Schema descriptions".
 */
import { pathToFileURL } from 'node:url'
import {
  DATA_DICTIONARY_GROUPS,
  SCHEMA_DESCRIPTIONS,
  STANDARD_COLUMNS,
} from '../src/db/schema-descriptions.ts'
import { MIGRATIONS_DIR, readLatestSnapshot } from './schema-snapshot.mjs'

/** What a plain parent-link foreign key says (generated, not authored). */
export function parentLinkText(foreignKey) {
  return `Parent \`${foreignKey.table}\` row (on delete ${foreignKey.onDelete}).`
}

/** The sentence a column carries: authored, standard, generated for a parent link, or none. */
export function columnText(tableName, column) {
  const authored = SCHEMA_DESCRIPTIONS[tableName]?.columns?.[column.name]
  if (authored) return authored
  if (column.name in STANDARD_COLUMNS) return STANDARD_COLUMNS[column.name]
  if (column.foreignKey && column.name === `${column.foreignKey.table}_id`) {
    return parentLinkText(column.foreignKey)
  }
  return ''
}

/**
 * @typedef {{ name: string, type: string, notNull: boolean, text: string }} DocColumn
 * @typedef {{ name: string, summary: string, columns: DocColumn[] }} DocTable
 * @typedef {{ key: string, title: string, blurb: string, tables: DocTable[] }} DocGroup
 */

/**
 * The documentation as data: groups in dictionary order, each with its tables
 * (alphabetical) and each table with its columns in schema order.
 */
export function buildSchemaDocs(snapshot = readLatestSnapshot(MIGRATIONS_DIR)) {
  /** @type {DocGroup[]} */
  const groups = Object.entries(DATA_DICTIONARY_GROUPS).map(([key, group]) => ({
    key,
    title: group.title,
    blurb: group.blurb,
    tables: /** @type {DocTable[]} */ ([]),
  }))
  const byKey = new Map(groups.map((group) => [group.key, group]))
  for (const table of snapshot.tables) {
    const description = SCHEMA_DESCRIPTIONS[table.name]
    const group = byKey.get(description?.group)
    if (!group) throw new Error(`table ${table.name} has no known group`)
    group.tables.push({
      name: table.name,
      summary: description.summary ?? '',
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notNull,
        text: columnText(table.name, column),
      })),
    })
  }
  for (const group of groups) group.tables.sort((a, b) => a.name.localeCompare(b.name))
  return groups.filter((group) => group.tables.length > 0)
}

/**
 * Markdown for the data: one section per group, one table per database table.
 * @param {DocGroup[]} groups
 */
export function renderMarkdown(groups) {
  const out = ['# Database Reference', '']
  for (const group of groups) {
    out.push(`## ${group.title}`, '', group.blurb, '')
    for (const table of group.tables) {
      out.push(
        `### \`${table.name}\``,
        '',
        table.summary,
        '',
        '| Column | Type | Required | Description |',
        '| --- | --- | --- | --- |'
      )
      for (const column of table.columns) {
        out.push(
          `| \`${column.name}\` | \`${column.type}\` | ${column.notNull ? 'yes' : 'no'} | ${column.text} |`
        )
      }
      out.push('')
    }
  }
  return `${out.join('\n')}\n`
}

function main(argv) {
  const groups = buildSchemaDocs()
  process.stdout.write(
    argv.includes('--json') ? `${JSON.stringify(groups, null, 2)}\n` : renderMarkdown(groups)
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
