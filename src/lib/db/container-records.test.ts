import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  container,
  environment,
  organization,
  project,
  server,
  service,
  workspace,
} from './schema.ts'
import { reconcileEnvironmentContainers } from './container-records.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withReconcileFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    environmentId: string
    webServiceId: string
    workerServiceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping container reconcile tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Container Reconcile Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Container Reconcile Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Container Reconcile Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Container Reconcile Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Container Reconcile Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [webService] = await db
    .insert(service)
    .values({
      displayName: 'web',
      environmentId,
      composeServiceName: 'web',
    })
    .returning({ id: service.id })
  const webServiceId = webService!.id

  const [workerService] = await db
    .insert(service)
    .values({
      displayName: 'worker',
      environmentId,
      composeServiceName: 'worker',
    })
    .returning({ id: service.id })
  const workerServiceId = workerService!.id

  try {
    await fn({
      db,
      serverId,
      environmentId,
      webServiceId,
      workerServiceId,
    })
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('reconcileEnvironmentContainers drops rows for services absent from the report', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
    workerServiceId,
  }) => {
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: 'cid-web',
        containerName: 'proj-web-1',
        status: 'running',
        composeServiceName: 'web',
      },
      {
        serviceId: workerServiceId,
        serverId,
        containerId: 'cid-worker',
        containerName: 'proj-worker-1',
        status: 'running',
        composeServiceName: 'worker',
      },
    ])

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          containerId: 'cid-web-new',
          containerName: 'proj-web-2',
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        serviceId: container.serviceId,
        containerId: container.containerId,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.serviceId, webServiceId)
    assertEquals(rows[0]!.containerId, 'cid-web-new')
  })
})

test('reconcileEnvironmentContainers creates missing services from the report', async () => {
  if (!dbUrl) {
    console.warn('Skipping container reconcile tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Container Reconcile Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Container Reconcile Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Container Reconcile Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Container Reconcile Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Container Reconcile Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          composeServiceName: 'nginx',
          containerId: 'cid-nginx',
          containerName: 'proj-nginx-1',
          status: 'running',
        },
      ],
    })

    const serviceRows = await db
      .select({
        id: service.id,
        displayName: service.displayName,
        composeServiceName: service.composeServiceName,
      })
      .from(service)
      .where(eq(service.environmentId, environmentId))

    assertEquals(serviceRows.length, 1)
    assertEquals(serviceRows[0]!.displayName, 'nginx')
    assertEquals(serviceRows[0]!.composeServiceName, 'nginx')

    const containerRows = await db
      .select({
        serviceId: container.serviceId,
        containerId: container.containerId,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(containerRows.length, 1)
    assertEquals(containerRows[0]!.serviceId, serviceRows[0]!.id)
    assertEquals(containerRows[0]!.containerId, 'cid-nginx')
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('reconcileEnvironmentContainers clears all rows on authoritative empty report', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
    workerServiceId,
  }) => {
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: 'cid-web',
        containerName: 'proj-web-1',
        status: 'running',
        composeServiceName: 'web',
      },
      {
        serviceId: workerServiceId,
        serverId,
        containerId: 'cid-worker',
        containerName: 'proj-worker-1',
        status: 'exited',
        composeServiceName: 'worker',
      },
    ])

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [],
    })

    const rows = await db
      .select({ id: container.id })
      .from(container)
      .where(
        and(
          eq(container.serverId, serverId),
        ),
      )

    assertEquals(rows.length, 0)
  })
})
