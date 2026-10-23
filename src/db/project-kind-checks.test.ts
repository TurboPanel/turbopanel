/**
 * `project.kind` and `project.icon` against a real database: the CHECKs refuse
 * unlisted words, and the upgrade statements in migration 0003 move the old
 * `metadata.type` into `kind` (the upgrade seed check cannot cover this, it
 * refuses any changed value).
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { createDenoDb } from './connection.ts'
import { organization, project, workspace } from './schema.ts'
import { getDatabaseUrl } from './url.ts'
import { PROJECT_ICONS, PROJECT_KINDS } from '../features/projects/vocabulary.ts'

const test = Deno.test.bind(Deno)

test('project kind and icon accept the listed words and null, and refuse the rest', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('project kind check tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Project Kind Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'ws', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id

  for (const kind of [null, ...PROJECT_KINDS]) {
    await db.insert(project).values({ workspaceId, organizationId, kind })
  }
  for (const icon of PROJECT_ICONS) {
    await db.insert(project).values({ workspaceId, organizationId, icon })
  }
  for (const values of [{ kind: 'template' }, { kind: 'empty' }, { icon: 'unicorn' }]) {
    let refused = false
    try {
      await db.insert(project).values({ workspaceId, organizationId, ...values })
    } catch {
      refused = true
    }
    assert(refused, `${JSON.stringify(values)} should be refused`)
  }
})

test('migration 0003 moves metadata.type into kind and keeps the catalog code', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('project kind backfill test')
    return
  }
  const db = createDenoDb()
  const migration = readFileSync(
    new URL('../../migrations/0003_project_kind_icon.sql', import.meta.url),
    'utf8'
  )
  const updates = migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith('UPDATE "project"'))
  assertEquals(updates.length, 2)

  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`CREATE TEMP TABLE project_backfill (id int, kind text, metadata jsonb) ON COMMIT DROP`
    )
    await tx.execute(sql`
      INSERT INTO project_backfill (id, metadata) VALUES
        (1, '{"type": "docker-compose"}'),
        (2, '{"type": "template", "code": "wordpress"}'),
        (3, '{"type": "managed", "code": "postgres"}'),
        (4, '{"type": "system", "component": "hosting-ingress"}'),
        (5, '{"type": "empty"}'),
        (6, '{"note": "keep"}'),
        (7, NULL)
    `)
    for (const statement of updates) {
      await tx.execute(sql.raw(statement.replaceAll('"project"', 'project_backfill')))
    }
    return await tx.execute<{ id: number; kind: string | null; metadata: unknown }>(
      sql`SELECT id, kind, metadata FROM project_backfill ORDER BY id`
    )
  })
  assertEquals(
    [...rows].map((row) => [row.id, row.kind, row.metadata]),
    [
      [1, 'compose', null],
      [2, 'compose', { code: 'wordpress' }],
      [3, 'managed', { code: 'postgres' }],
      [4, 'system', { component: 'hosting-ingress' }],
      [5, null, null],
      [6, null, { note: 'keep' }],
      [7, null, null],
    ]
  )
})
