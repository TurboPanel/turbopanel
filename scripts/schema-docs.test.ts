/**
 * `scripts/schema-docs.mjs` — the Markdown export of the schema descriptions.
 * Run against the shipped snapshot: every table lands in exactly one group, no
 * column is left without a sentence, and the Markdown names every table.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { readLatestSnapshot } from './schema-snapshot.mjs'
import { buildSchemaDocs, parentLinkText, renderMarkdown } from './schema-docs.mjs'

const test = Deno.test.bind(Deno)

test('every table of the shipped schema appears once, and no column is left bare', () => {
  const snapshot = readLatestSnapshot()
  const groups = buildSchemaDocs(snapshot)
  const tables = groups.flatMap((group) => group.tables)
  assertEquals(
    tables.map((table) => table.name).sort(),
    snapshot.tables.map((table: { name: string }) => table.name).sort()
  )
  const bare = tables.flatMap((table) =>
    table.columns.filter((column) => column.text === '').map((c) => `${table.name}.${c.name}`)
  )
  assertEquals(bare, [], 'columns with no description')
})

test('the Markdown names every table and spells a parent link out', () => {
  const groups = buildSchemaDocs()
  const markdown = renderMarkdown(groups)
  for (const table of groups.flatMap((group) => group.tables)) {
    assertStringIncludes(markdown, `### \`${table.name}\``)
  }
  assertEquals(
    parentLinkText({ table: 'organization', column: 'id', onDelete: 'cascade' }),
    'Parent `organization` row (on delete cascade).'
  )
  assert(markdown.startsWith('# Database Reference'))
})
