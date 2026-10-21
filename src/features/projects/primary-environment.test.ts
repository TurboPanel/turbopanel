import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { environment, organization, project, server, workspace } from '../../db/schema.ts'
import { forgetServerOwnedResources } from '../../client/servers/delete-guards.ts'
import {
  deleteEnvironmentCascade,
  deleteProjectCascade,
  dropEnvironmentSubtreeInTx,
} from './project-delete.ts'
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

test('deleting an environment and its project at the same time never deadlocks', async () => {
  for (let round = 0; round < 5; round += 1) {
    await withProject(async (db, projectId) => {
      const [a] = await db
        .insert(environment)
        .values({ projectId, name: 'one', isPrimary: isFirstEnvironmentOf(projectId) })
        .returning({ id: environment.id })
      const [b] = await db
        .insert(environment)
        .values({ projectId, name: 'two', isPrimary: isFirstEnvironmentOf(projectId) })
        .returning({ id: environment.id })
      const settled = await Promise.allSettled([
        deleteEnvironmentCascade(db, round % 2 === 0 ? a!.id : b!.id),
        deleteProjectCascade(db, projectId),
      ])
      // Whatever order the locks fall in, both finish: no deadlock error.
      assertEquals(
        settled.map((result) => result.status),
        ['fulfilled', 'fulfilled']
      )
      const left = await db
        .select({ id: environment.id, isPrimary: environment.isPrimary })
        .from(environment)
        .where(eq(environment.projectId, projectId))
      assertEquals(left.length === 0 || left.filter((row) => row.isPrimary).length === 1, true)
    })
  }
})

/** A project with a primary environment on an offline server and a second one off it. */
async function withServerProject(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    projectId: string
    serverId: string
    placedId: string
    otherId: string
  }) => Promise<void>
) {
  await withProject(async (db, projectId) => {
    const [proj] = await db
      .select({ organizationId: project.organizationId })
      .from(project)
      .where(eq(project.id, projectId))
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({
        organizationId: proj!.organizationId,
        name: `Primary Env Server ${crypto.randomUUID().slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    try {
      const [placed] = await db
        .insert(environment)
        .values({
          projectId,
          name: 'placed',
          serverId: srv!.id,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00Z',
        })
        .returning({ id: environment.id })
      const [other] = await db
        .insert(environment)
        .values({ projectId, name: 'other', createdAt: '2026-01-02T00:00:00Z' })
        .returning({ id: environment.id })
      await fn({
        db,
        organizationId: proj!.organizationId,
        projectId,
        serverId: srv!.id,
        placedId: placed!.id,
        otherId: other!.id,
      })
    } finally {
      await db.delete(environment).where(eq(environment.projectId, projectId))
      await db.delete(server).where(eq(server.id, srv!.id))
    }
  })
}

test('the oldest remaining environment becomes primary after a bulk drop and after a server forget', async () => {
  await withServerProject(async ({ db, projectId, serverId, placedId, otherId }) => {
    // Bulk path: the host is gone, the primary's rows are dropped.
    await db.transaction((tx) => dropEnvironmentSubtreeInTx(tx, [placedId], { serverId }))
    assertEquals((await loadPrimaryEnvironment(db, projectId))?.id, otherId)
  })
  await withServerProject(async ({ db, projectId, serverId, organizationId, otherId }) => {
    // Forget path: the environment placed on the server goes, the other takes over.
    await db.transaction((tx) => forgetServerOwnedResources(tx, serverId, organizationId))
    assertEquals((await loadPrimaryEnvironment(db, projectId))?.id, otherId)
  })
})

test('server forget, project delete and make primary running together never deadlock', async () => {
  for (let round = 0; round < 6; round += 1) {
    await withServerProject(async ({ db, projectId, serverId, organizationId, otherId }) => {
      const settled = await Promise.allSettled([
        db.transaction((tx) => forgetServerOwnedResources(tx, serverId, organizationId)),
        round % 2 === 0
          ? deleteProjectCascade(db, projectId)
          : db.transaction((tx) => setPrimaryEnvironment(tx, projectId, otherId)),
      ])
      for (const result of settled) {
        if (result.status === 'rejected') {
          assertEquals(String(result.reason).includes('deadlock'), false, String(result.reason))
        }
      }
      const left = await db
        .select({ isPrimary: environment.isPrimary })
        .from(environment)
        .where(eq(environment.projectId, projectId))
      assertEquals(left.length === 0 || left.filter((row) => row.isPrimary).length === 1, true)
    })
  }
})
