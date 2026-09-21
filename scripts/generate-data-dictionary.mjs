#!/usr/bin/env node
/**
 * Website data dictionary generator.
 *
 * Renders the shipped schema — the latest `migrations/meta/NNNN_snapshot.json`
 * joined with `src/lib/db/schema-descriptions.ts` — as Fumadocs MDX pages
 * under the website checkout: one index, one page per data-dictionary
 * group, and the section `meta.json`. Every file starts with a generated
 * banner; edit the descriptions file or `schema.ts`, never the pages.
 *
 * Usage:
 *   node scripts/generate-data-dictionary.mjs            # write ../website/docs/database
 *   node scripts/generate-data-dictionary.mjs --check    # exit 1 when the pages are stale
 *   node scripts/generate-data-dictionary.mjs --out DIR  # write elsewhere
 *
 * The pages carry the migration tag they were generated from, so a schema
 * change that has been through `pnpm drizzle-kit generate --name …` shows
 * up as a diff here even before anyone touches a description.
 *
 * See src/lib/db/AGENTS.md → "Schema descriptions".
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DATA_DICTIONARY_GROUPS,
  isObviousColumn,
  SCHEMA_DESCRIPTIONS,
  STANDARD_COLUMNS,
} from '../src/lib/db/schema-descriptions.ts'
import { readLatestSnapshot, REPO_ROOT } from './schema-snapshot.mjs'

export const DEFAULT_OUT_DIR = path.resolve(REPO_ROOT, '../website/docs/database')
const DOCS_BASE = '/docs/database'

/** GFM table cell: pipes escaped (works inside code spans too). */
function cell(text) {
  return text.replaceAll('|', '\\|')
}

/** Inline code that stays inert inside a GFM table and MDX. */
function code(text) {
  return `\`${cell(text)}\``
}

function banner(snapshot) {
  return [
    '{/*',
    '  GENERATED FILE — do not edit by hand.',
    `  Source: turbopanel/src/lib/db/schema-descriptions.ts + migrations/meta/${String(snapshot.idx).padStart(4, '0')}_snapshot.json (${snapshot.tag}).`,
    '  Regenerate: `node scripts/generate-data-dictionary.mjs` in the turbopanel repo (`pnpm docs:data-dictionary`).',
    '*/}',
  ].join('\n')
}

function frontmatter(title, description) {
  return ['---', `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`, '---'].join('\n')
}

/** Group key → tables in it, alphabetical. Unknown groups are a bug the test catches. */
export function tablesByGroup(snapshot) {
  /** @type {Map<string, import('./schema-snapshot.mjs').SnapshotTable[]>} */
  const groups = new Map(Object.keys(DATA_DICTIONARY_GROUPS).map((g) => [g, []]))
  for (const table of [...snapshot.tables].sort((a, b) => a.name.localeCompare(b.name))) {
    const group = SCHEMA_DESCRIPTIONS[table.name]?.group ?? 'ungrouped'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(table)
  }
  return groups
}

function tableHref(tableName) {
  const group = SCHEMA_DESCRIPTIONS[tableName]?.group ?? 'ungrouped'
  return `${DOCS_BASE}/${group}#${tableName}`
}

function tableLink(tableName) {
  return `[${code(tableName)}](${tableHref(tableName)})`
}

/**
 * Description cell: a foreign key is always shown as a link with its
 * on-delete rule; an authored sentence follows when there is one; standard
 * columns use the shared wording; a plain parent link (`<table>_id`) says
 * nothing beyond the link, exactly like the database comment it does not get.
 */
function columnDescription(table, column) {
  const authored = SCHEMA_DESCRIPTIONS[table.name]?.columns[column.name]
  const fk = column.foreignKey
  const parts = []
  if (fk) parts.push(`FK → ${tableLink(fk.table)}.${code(fk.column)} (on delete ${fk.onDelete}).`)
  if (authored) parts.push(authored)
  else if (column.name in STANDARD_COLUMNS) parts.push(STANDARD_COLUMNS[column.name])
  else if (!fk || !isObviousColumn(column.name, fk.table)) parts.push('_No description yet._')
  return parts.join(' ')
}

function renderTable(table) {
  const description = SCHEMA_DESCRIPTIONS[table.name]
  const lines = []
  lines.push(`## ${code(table.name)} [#${table.name}]`)
  lines.push('')
  lines.push(description?.summary ?? '_No description yet — add one in `schema-descriptions.ts`._')
  lines.push('')
  lines.push('| Column | Type | Null | Default | Description |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const column of table.columns) {
    const name = column.primaryKey ? `${code(column.name)} (PK)` : code(column.name)
    const nullable = column.notNull ? 'no' : 'yes'
    const def = column.default === undefined ? '' : code(column.default)
    lines.push(`| ${name} | ${code(column.type)} | ${nullable} | ${def} | ${cell(columnDescription(table, column))} |`)
  }
  const constraints = []
  if (table.primaryKey.length > 1) {
    constraints.push(`- Primary key: (${table.primaryKey.map(code).join(', ')})`)
  }
  for (const unique of table.uniques) {
    constraints.push(`- Unique ${code(unique.name)}: (${unique.columns.map(code).join(', ')})`)
  }
  for (const index of table.indexes) {
    const kind = index.isUnique ? 'Unique index' : 'Index'
    const where = index.where ? ` where ${code(index.where)}` : ''
    constraints.push(`- ${kind} ${code(index.name)}: (${index.columns.map(code).join(', ')})${where}`)
  }
  for (const check of table.checks) {
    constraints.push(`- Check ${code(check.name)}: ${code(check.value)}`)
  }
  if (constraints.length) {
    lines.push('')
    lines.push('**Constraints and indexes**')
    lines.push('')
    lines.push(...constraints)
  }
  lines.push('')
  return lines.join('\n')
}

function renderGroupPage(snapshot, groupKey, tables) {
  const group = DATA_DICTIONARY_GROUPS[groupKey] ?? { title: 'Ungrouped', blurb: 'Tables with no group yet.' }
  const names = tables.map((t) => t.name)
  const description = `Data dictionary — ${group.title.toLowerCase()} tables: ${names.join(', ')}`
  const parts = [
    frontmatter(group.title, description),
    '',
    banner(snapshot),
    '',
    `# ${group.title}`,
    '',
    group.blurb,
    '',
    `Tables on this page: ${names.map((n) => `[${code(n)}](#${n})`).join(' · ')}. Generated from migration ${code(snapshot.tag)}; see [How to read this](${DOCS_BASE}#how-to-read-this-dictionary).`,
    '',
    ...tables.map(renderTable),
  ]
  return parts.join('\n')
}

function renderIndex(snapshot, groups) {
  const rows = []
  for (const [groupKey, tables] of groups) {
    if (tables.length === 0) continue
    const group = DATA_DICTIONARY_GROUPS[groupKey] ?? { title: 'Ungrouped' }
    rows.push(`| [${group.title}](${DOCS_BASE}/${groupKey}) | ${tables.map((t) => tableLink(t.name)).join(', ')} |`)
  }
  const tableCount = snapshot.tables.length
  const columnCount = snapshot.tables.reduce((n, t) => n + t.columns.length, 0)
  return [
    frontmatter(
      'Database',
      'Data dictionary for the TurboPanel control-plane PostgreSQL schema: every table and column, generated from the shipped migrations'
    ),
    '',
    banner(snapshot),
    '',
    '# Database',
    '',
    'The control plane keeps its state in one PostgreSQL database (PostgreSQL 18 or newer). This dictionary is generated from the shipped schema — the drizzle snapshot behind the newest migration — joined with the maintained descriptions in the [TurboPanel/turbopanel](https://github.com/TurboPanel/turbopanel) repository. The same descriptions are applied to the live database as `COMMENT ON` metadata, so `\\d+ table` in `psql` and this page always say the same thing.',
    '',
    `| Generated from | Tables | Columns |`,
    `| --- | --- | --- |`,
    `| migration ${code(snapshot.tag)} | ${tableCount} | ${columnCount} |`,
    '',
    '## Tables by area',
    '',
    '| Area | Tables |',
    '| --- | --- |',
    ...rows,
    '',
    '## How to read this dictionary',
    '',
    '- **Physical names.** Every table is one lower-case word (`seat`, `copy`, `2fa`); the drizzle export names in `schema.ts` sometimes differ. Pages and anchors use the physical name.',
    '- **Standard columns.** Every table has `id` (`uuid`, defaulting to `uuidv7()` so keys are time-ordered and collision-free across writers), `created_at` and, on mutable tables, `updated_at`. They are listed for completeness but never described per table.',
    '- **Foreign keys** are shown inline as `FK → table.column (on delete …)`. A plain parent link named `<table>_id` carries no further text; a foreign key under another name (`assigned_tier_id`, `actor_user_id`) always does, because the name signals a rule.',
    '- **Vocabularies.** A column with a fixed value set carries a `CHECK (col IN (…))` listed under *Constraints and indexes*; the description names the members. Provider-owned vocabularies keep a raw `provider_*` copy beside the normalized column.',
    '- **`metadata` / `options`.** Tables that carry them declare both, both nullable, right after the timestamps: `metadata` is free-form, `options` is validated by the writer named in its description.',
    '- **Booleans** are named `is_*`; `NULL` on a boolean means *not set*, not `false`.',
    '- **Secrets** are never stored in the clear: a column holding one says so and names the envelope format.',
    '',
    'To change a description, edit `src/lib/db/schema-descriptions.ts` in the turbopanel repository and follow the *Schema descriptions* loop in its `AGENTS.md`; a schema change regenerates these pages as part of the same migration.',
    '',
  ].join('\n')
}

function metaJson(groups) {
  const pages = ['index', ...[...groups].filter(([, t]) => t.length > 0).map(([g]) => g)]
  return JSON.stringify({ title: 'Database', pages }, null, 2) + '\n'
}

/** @returns {Map<string, string>} relative file → content */
export function renderAll(snapshot = readLatestSnapshot()) {
  const groups = tablesByGroup(snapshot)
  const files = new Map()
  files.set('index.mdx', renderIndex(snapshot, groups))
  files.set('meta.json', metaJson(groups))
  for (const [groupKey, tables] of groups) {
    if (tables.length === 0) continue
    files.set(`${groupKey}.mdx`, renderGroupPage(snapshot, groupKey, tables))
  }
  return files
}

function main(argv) {
  const check = argv.includes('--check')
  const outFlag = argv.indexOf('--out')
  const outDir = outFlag === -1 ? DEFAULT_OUT_DIR : path.resolve(argv[outFlag + 1])
  const files = renderAll()

  const parent = path.dirname(outDir)
  if (!fs.existsSync(parent)) {
    console.error(`data-dictionary: ${parent} does not exist — pass --out DIR or check out the website repo beside this one`)
    return 2
  }

  const onDisk = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => f.endsWith('.mdx') || f === 'meta.json')
    : []
  const stale = []
  for (const [rel, content] of files) {
    const file = path.join(outDir, rel)
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) stale.push(rel)
  }
  const orphans = onDisk.filter((f) => !files.has(f))

  if (check) {
    if (stale.length === 0 && orphans.length === 0) {
      console.log(`data-dictionary: ${outDir} is up to date (${files.size} files)`)
      return 0
    }
    for (const rel of stale) console.error(`data-dictionary: stale or missing: ${rel}`)
    for (const rel of orphans) console.error(`data-dictionary: orphan (not generated any more): ${rel}`)
    console.error('data-dictionary: run `node scripts/generate-data-dictionary.mjs` and commit the website pages')
    return 1
  }

  fs.mkdirSync(outDir, { recursive: true })
  for (const [rel, content] of files) fs.writeFileSync(path.join(outDir, rel), content)
  for (const rel of orphans) fs.rmSync(path.join(outDir, rel))
  console.log(
    `data-dictionary: wrote ${files.size} files to ${outDir}` +
      (orphans.length ? `, removed ${orphans.length} orphan(s): ${orphans.join(', ')}` : '')
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
