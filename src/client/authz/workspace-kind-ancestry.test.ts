import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  environment,
  managed,
  organization,
  principal,
  project,
  workspace,
} from '../../lib/db/schema.ts'
import {
  WORKSPACE_KIND_SYSTEM,
  WORKSPACE_KIND_USER,
} from '../../lib/db/workspace-kind.ts'
import { resolveWorkspaceKindForEntity } from './workspace-kind-ancestry.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withAncestryFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    userWorkspaceId: string
    systemWorkspaceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping workspace-kind ancestry tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Workspace Kind Ancestry Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUserWorkspace] = await db
    .insert(workspace)
    .values({
      displayName: 'User Workspace',
      organizationId,
      kind: WORKSPACE_KIND_USER,
    })
    .returning({ id: workspace.id })
  const userWorkspaceId = insertedUserWorkspace!.id

  const [insertedSystemWorkspace] = await db
    .insert(workspace)
    .values({
      displayName: 'System Workspace',
      organizationId,
      kind: WORKSPACE_KIND_SYSTEM,
    })
    .returning({ id: workspace.id })
  const systemWorkspaceId = insertedSystemWorkspace!.id

  try {
    await fn({ db, organizationId, userWorkspaceId, systemWorkspaceId })
  } finally {
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('resolveWorkspaceKindForEntity returns kind for managed-scoped principals', async () => {
  await withAncestryFixtures(async ({ db, userWorkspaceId, systemWorkspaceId }) => {
    const [userProject] = await db
      .insert(project)
      .values({ displayName: 'User Managed Project', workspaceId: userWorkspaceId })
      .returning({ id: project.id })
    const userProjectId = userProject!.id

    const [userEnv] = await db
      .insert(environment)
      .values({ displayName: 'User Managed Env', projectId: userProjectId })
      .returning({ id: environment.id })
    const userEnvironmentId = userEnv!.id

    const [userManaged] = await db
      .insert(managed)
      .values({ environmentId: userEnvironmentId })
      .returning({ id: managed.id })
    const userManagedId = userManaged!.id

    const [userPrincipal] = await db
      .insert(principal)
      .values({
        kind: 'database',
        provider: 'postgres',
        username: 'managed_user_kind',
        managedId: userManagedId,
      })
      .returning({ id: principal.id })
    const userPrincipalId = userPrincipal!.id

    const [systemProject] = await db
      .insert(project)
      .values({ displayName: 'System Managed Project', workspaceId: systemWorkspaceId })
      .returning({ id: project.id })
    const systemProjectId = systemProject!.id

    const [systemEnv] = await db
      .insert(environment)
      .values({ displayName: 'System Managed Env', projectId: systemProjectId })
      .returning({ id: environment.id })
    const systemEnvironmentId = systemEnv!.id

    const [systemManaged] = await db
      .insert(managed)
      .values({ environmentId: systemEnvironmentId })
      .returning({ id: managed.id })
    const systemManagedId = systemManaged!.id

    const [systemPrincipal] = await db
      .insert(principal)
      .values({
        kind: 'database',
        provider: 'postgres',
        username: 'managed_system_kind',
        managedId: systemManagedId,
      })
      .returning({ id: principal.id })
    const systemPrincipalId = systemPrincipal!.id

    try {
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'principal', userPrincipalId),
        WORKSPACE_KIND_USER,
      )
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'principal', systemPrincipalId),
        WORKSPACE_KIND_SYSTEM,
      )
    } finally {
      await db.delete(principal).where(eq(principal.id, userPrincipalId))
      await db.delete(principal).where(eq(principal.id, systemPrincipalId))
      await db.delete(managed).where(eq(managed.id, userManagedId))
      await db.delete(managed).where(eq(managed.id, systemManagedId))
      await db.delete(environment).where(eq(environment.id, userEnvironmentId))
      await db.delete(environment).where(eq(environment.id, systemEnvironmentId))
      await db.delete(project).where(eq(project.id, userProjectId))
      await db.delete(project).where(eq(project.id, systemProjectId))
    }
  })
})
