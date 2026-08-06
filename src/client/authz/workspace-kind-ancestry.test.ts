import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  environment,
  hosting,
  managed,
  organization,
  principal,
  project,
  service,
  variable,
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

test('resolveWorkspaceKindForEntity walks workspace, project, and environment ancestry', async () => {
  await withAncestryFixtures(async ({ db, userWorkspaceId, systemWorkspaceId }) => {
    const [userProject] = await db
      .insert(project)
      .values({ displayName: 'User Project', workspaceId: userWorkspaceId })
      .returning({ id: project.id })
    const userProjectId = userProject!.id

    const [userEnv] = await db
      .insert(environment)
      .values({ displayName: 'User Env', projectId: userProjectId })
      .returning({ id: environment.id })
    const userEnvironmentId = userEnv!.id

    const [systemProject] = await db
      .insert(project)
      .values({ displayName: 'System Project', workspaceId: systemWorkspaceId })
      .returning({ id: project.id })
    const systemProjectId = systemProject!.id

    try {
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'workspace', userWorkspaceId),
        WORKSPACE_KIND_USER,
      )
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'project', userProjectId),
        WORKSPACE_KIND_USER,
      )
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'environment', userEnvironmentId),
        WORKSPACE_KIND_USER,
      )
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'project', systemProjectId),
        WORKSPACE_KIND_SYSTEM,
      )
    } finally {
      await db.delete(environment).where(eq(environment.id, userEnvironmentId))
      await db.delete(project).where(eq(project.id, userProjectId))
      await db.delete(project).where(eq(project.id, systemProjectId))
    }
  })
})

test('resolveWorkspaceKindForEntity returns null for unknown entity types', async () => {
  await withAncestryFixtures(async ({ db }) => {
    assertEquals(
      await resolveWorkspaceKindForEntity(db, 'organization', crypto.randomUUID()),
      null,
    )
    assertEquals(
      await resolveWorkspaceKindForEntity(db, 'server', crypto.randomUUID()),
      null,
    )
  })
})

test('resolveWorkspaceKindForEntity resolves service and hosting descendants', async () => {
  await withAncestryFixtures(async ({ db, systemWorkspaceId }) => {
    const [systemProject] = await db
      .insert(project)
      .values({ displayName: 'System Service Project', workspaceId: systemWorkspaceId })
      .returning({ id: project.id })
    const systemProjectId = systemProject!.id

    const [systemEnv] = await db
      .insert(environment)
      .values({ displayName: 'System Service Env', projectId: systemProjectId })
      .returning({ id: environment.id })
    const systemEnvironmentId = systemEnv!.id

    const [systemService] = await db
      .insert(service)
      .values({
        environmentId: systemEnvironmentId,
        displayName: 'web',
        composeServiceName: 'web',
      })
      .returning({ id: service.id })
    const systemServiceId = systemService!.id

    const [systemHosting] = await db
      .insert(hosting)
      .values({ serviceId: systemServiceId, hostnames: ['app.example.test'] })
      .returning({ id: hosting.id })
    const systemHostingId = systemHosting!.id

    try {
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'service', systemServiceId),
        WORKSPACE_KIND_SYSTEM,
      )
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'hosting', systemHostingId),
        WORKSPACE_KIND_SYSTEM,
      )
    } finally {
      await db.delete(hosting).where(eq(hosting.id, systemHostingId))
      await db.delete(service).where(eq(service.id, systemServiceId))
      await db.delete(environment).where(eq(environment.id, systemEnvironmentId))
      await db.delete(project).where(eq(project.id, systemProjectId))
    }
  })
})

test('resolveWorkspaceKindForEntity resolves environment-scoped variables', async () => {
  await withAncestryFixtures(async ({ db, userWorkspaceId }) => {
    const [userProject] = await db
      .insert(project)
      .values({ displayName: 'Variable Project', workspaceId: userWorkspaceId })
      .returning({ id: project.id })
    const userProjectId = userProject!.id

    const [userEnv] = await db
      .insert(environment)
      .values({ displayName: 'Variable Env', projectId: userProjectId })
      .returning({ id: environment.id })
    const userEnvironmentId = userEnv!.id

    const [userVariable] = await db
      .insert(variable)
      .values({ environmentId: userEnvironmentId, key: 'KIND_VAR', value: '1' })
      .returning({ id: variable.id })
    const userVariableId = userVariable!.id

    try {
      assertEquals(
        await resolveWorkspaceKindForEntity(db, 'variable', userVariableId),
        WORKSPACE_KIND_USER,
      )
    } finally {
      await db.delete(variable).where(eq(variable.id, userVariableId))
      await db.delete(environment).where(eq(environment.id, userEnvironmentId))
      await db.delete(project).where(eq(project.id, userProjectId))
    }
  })
})
