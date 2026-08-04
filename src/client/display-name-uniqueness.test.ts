import { assertEquals } from 'jsr:@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import {
  container,
  environment,
  organization,
  project,
  server,
  service,
  workspace,
} from '../lib/db/schema.ts'
import { ensureSystemHierarchy } from './system/hierarchy.ts'
import {
  isWorkspaceDisplayNameTaken,
  normalizeDisplayNameKey,
  PROJECT_NAME_IN_USE_ERROR,
  WORKSPACE_NAME_IN_USE_ERROR,
} from './display-name-uniqueness.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('normalizeDisplayNameKey trims and lowercases', () => {
  assertEquals(normalizeDisplayNameKey('  My Project  '), 'my project')
  assertEquals(normalizeDisplayNameKey('DEFAULT Workspace'), 'default workspace')
})

test('name-in-use error codes stay stable for API clients', () => {
  assertEquals(PROJECT_NAME_IN_USE_ERROR, 'project_name_in_use')
  assertEquals(WORKSPACE_NAME_IN_USE_ERROR, 'workspace_name_in_use')
})

async function cleanupOrgHierarchy(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
): Promise<void> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  const workspaceIds = workspaceRows.map((row) => row.id)

  if (workspaceIds.length > 0) {
    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(inArray(project.workspaceId, workspaceIds))
    const projectIds = projectRows.map((row) => row.id)

    if (projectIds.length > 0) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(inArray(environment.projectId, projectIds))
      const environmentIds = envRows.map((row) => row.id)

      if (environmentIds.length > 0) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, environmentIds))
        const serviceIds = serviceRows.map((row) => row.id)

        if (serviceIds.length > 0) {
          await db
            .delete(container)
            .where(inArray(container.serviceId, serviceIds))
          await db.delete(service).where(inArray(service.id, serviceIds))
        }
        await db
          .delete(environment)
          .where(inArray(environment.id, environmentIds))
      }
      await db.delete(project).where(inArray(project.id, projectIds))
    }
    await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
  }

  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

test('isWorkspaceDisplayNameTaken ignores system workspace named System', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping workspace display-name uniqueness DB test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Display Name Uniqueness Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Display Name Uniqueness Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await ensureSystemHierarchy(db, { organizationId, serverId })

    assertEquals(
      await isWorkspaceDisplayNameTaken(db, organizationId, 'System'),
      false,
    )

    await db.insert(workspace).values({
      organizationId,
      displayName: 'System',
      kind: 'user',
    })

    assertEquals(
      await isWorkspaceDisplayNameTaken(db, organizationId, 'System'),
      true,
    )
  } finally {
    await cleanupOrgHierarchy(db, organizationId)
  }
})
