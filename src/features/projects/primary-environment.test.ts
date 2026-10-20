import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { environment, organization, project, workspace } from '../../db/schema.ts'
import {
  isFirstEnvironmentOf,
  loadPrimaryEnvironment,
  setPrimaryEnvironment,
  sortEnvironmentsForDisplay,
} from './primary-environment.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('sortEnvironmentsForDisplay lists primary, then pinned, then oldest, within each project', () => {
  const row = (name: string, projectId: string, createdAt: string, p = false, pin = false) => ({
    name,
    projectId,
    createdAt,
    isPrimary: p,
    isPinned: pin,
  })
  const sorted = sortEnvironmentsForDisplay([
    row('b-old', 'B', '2026-01-01', false),
    row('a-new', 'A', '2026-03-01', false),
    row('a-pinned', 'A', '2026-02-01', false, true),
    row('a-main', 'A', '2026-04-01', true),
    row('b-main', 'B', '2026-05-01', true),
  ])
  assertEquals(
    sorted.map((r) => r.name),
    ['b-main', 'b-old', 'a-main', 'a-pinned', 'a-new']
  )
})

/** The backfill statement as written in the migration, run against rows made without a marker. */
function backfillStatement(): string {
  const text = Deno.readTextFileSync(
    new URL('../../../migrations/0001_primary_environment.sql', import.meta.url)
  )
  const statement = text.split('--> statement-breakpoint').find((part) => part.includes('UPDATE'))
  if (!statement) throw new TypeError('backfill statement missing')
  return statement.trim()
}

async function withProject(
  fn: (db: ReturnType<typeof createDenoDb>, projectId: string) => Promise<void>
) {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('primary environment tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Primary Environment Org' })
    .returning({ id: organization.id })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Primary Environment Workspace', organizationId: org!.id })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ name: 'Primary Environment Project', workspaceId: ws!.id, organizationId: org!.id })
    .returning({ id: project.id })
  try {
    await fn(db, proj!.id)
  } finally {
    await db.delete(environment).where(eq(environment.projectId, proj!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
  }
}

test('the migration backfill marks only the oldest environment of a project primary', async () => {
  await withProject(async (db, projectId) => {
    await db.insert(environment).values([
      { projectId, name: 'newer', createdAt: '2026-02-01T00:00:00Z' },
      { projectId, name: 'oldest', createdAt: '2026-01-01T00:00:00Z' },
      { projectId, name: 'middle', createdAt: '2026-01-15T00:00:00Z' },
    ])
    await db.execute(sql.raw(backfillStatement().replace(/;\s*$/, '')))
    const rows = await db
      .select({ name: environment.name, isPrimary: environment.isPrimary })
      .from(environment)
      .where(eq(environment.projectId, projectId))
    assertEquals(
      rows.filter((r) => r.isPrimary).map((r) => r.name),
      ['oldest']
    )
  })
})

test('setPrimaryEnvironment swaps the marker without tripping the unique index', async () => {
  await withProject(async (db, projectId) => {
    const [first] = await db
      .insert(environment)
      .values({ projectId, name: 'one', isPrimary: isFirstEnvironmentOf(projectId) })
      .returning({ id: environment.id, isPrimary: environment.isPrimary })
    const [second] = await db
      .insert(environment)
      .values({ projectId, name: 'two', isPrimary: isFirstEnvironmentOf(projectId) })
      .returning({ id: environment.id, isPrimary: environment.isPrimary })
    assertEquals([first!.isPrimary, second!.isPrimary], [true, false])

    assertEquals(
      await db.transaction((tx) => setPrimaryEnvironment(tx, projectId, second!.id)),
      true
    )
    assertEquals((await loadPrimaryEnvironment(db, projectId))?.id, second!.id)
    // Another project's environment cannot be made primary here.
    assertEquals(
      await db.transaction((tx) => setPrimaryEnvironment(tx, projectId, crypto.randomUUID())),
      false
    )
    assertEquals((await loadPrimaryEnvironment(db, projectId))?.id, second!.id)
  })
})
