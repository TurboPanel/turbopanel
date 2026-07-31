import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  container,
  environment,
  hosting,
  organization,
  project,
  server,
  service,
  workspace,
} from './schema.ts'
import {
  deleteProjectCascade,
  isActiveContainerStatus,
  PROJECT_HAS_RUNNING_SERVICES_ERROR,
} from './project-delete.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('isActiveContainerStatus treats stopped Docker states as inactive', () => {
  assertEquals(isActiveContainerStatus('exited'), false)
  assertEquals(isActiveContainerStatus('dead'), false)
  assertEquals(isActiveContainerStatus('removing'), false)
  assertEquals(isActiveContainerStatus('running'), true)
  assertEquals(isActiveContainerStatus('restarting'), true)
  assertEquals(isActiveContainerStatus('created'), true)
  assertEquals(isActiveContainerStatus('paused'), true)
  assertEquals(isActiveContainerStatus(undefined), true)
  assertEquals(isActiveContainerStatus(''), true)
  assertEquals(isActiveContainerStatus('unknown'), true)
})

test('deleteProjectCascade rejects when containers are still active', async () => {
  if (!dbUrl) {
    console.warn('Skipping project cascade tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const now = new Date().toISOString()

  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Project Delete Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  const [ws] = await db
    .insert(workspace)
    .values({ displayName: 'Project Delete Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id

  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Project Delete Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = srv!.id

  const [proj] = await db
    .insert(project)
    .values({ displayName: 'Running Project', workspaceId })
    .returning({ id: project.id })
  const projectId = proj!.id

  const [env] = await db
    .insert(environment)
    .values({ displayName: 'Production', projectId })
    .returning({ id: environment.id })
  const environmentId = env!.id

  const [svc] = await db
    .insert(service)
    .values({ displayName: 'web', environmentId, composeServiceName: 'web' })
    .returning({ id: service.id })
  const serviceId = svc!.id

  await db.insert(container).values({
    serviceId,
    serverId,
    containerId: 'cid-running',
    containerName: 'proj-web-1',
    status: 'running',
    composeServiceName: 'web',
  })

  try {
    const result = await deleteProjectCascade(db, projectId)
    assertEquals(result, {
      ok: false,
      error: PROJECT_HAS_RUNNING_SERVICES_ERROR,
    })

    const [stillThere] = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    assertEquals(stillThere?.id, projectId)
  } finally {
    await db.delete(container).where(eq(container.serviceId, serviceId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('deleteProjectCascade rejects when an ingress container is still running', async () => {
  if (!dbUrl) {
    console.warn('Skipping project cascade tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const now = new Date().toISOString()

  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Ingress Active Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  const [ws] = await db
    .insert(workspace)
    .values({ displayName: 'Ingress Active Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id

  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Ingress Active Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = srv!.id

  const [proj] = await db
    .insert(project)
    .values({ displayName: 'Ingress Running Project', workspaceId })
    .returning({ id: project.id })
  const projectId = proj!.id

  const [env] = await db
    .insert(environment)
    .values({ displayName: 'Production', projectId })
    .returning({ id: environment.id })
  const environmentId = env!.id

  const [svc] = await db
    .insert(service)
    .values({ displayName: 'web', environmentId, composeServiceName: 'web' })
    .returning({ id: service.id })
  const serviceId = svc!.id

  await db.insert(container).values([
    {
      serviceId,
      serverId,
      containerId: 'cid-app-exited',
      containerName: `${serviceId}-1`,
      status: 'exited',
      role: 'app',
      composeServiceName: 'web',
      ordinal: 1,
    },
    {
      serviceId,
      serverId,
      containerId: 'cid-ingress-running',
      containerName: `${serviceId}-ingress`,
      status: 'running',
      role: 'ingress',
      composeServiceName: 'web-ingress',
      ordinal: 1,
    },
  ])

  try {
    const blocked = await deleteProjectCascade(db, projectId)
    assertEquals(blocked, {
      ok: false,
      error: PROJECT_HAS_RUNNING_SERVICES_ERROR,
    })

    await db
      .update(container)
      .set({ status: 'exited' })
      .where(eq(container.serviceId, serviceId))

    const result = await deleteProjectCascade(db, projectId)
    assertEquals(result, { ok: true })

    const remainingContainers = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serviceId, serviceId))
    assertEquals(remainingContainers.length, 0)

    const [goneProject] = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    assertEquals(goneProject, undefined)
  } finally {
    await db.delete(container).where(eq(container.serviceId, serviceId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('deleteProjectCascade removes children when containers are stopped', async () => {
  if (!dbUrl) {
    console.warn('Skipping project cascade tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const now = new Date().toISOString()

  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Project Cascade Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  const [ws] = await db
    .insert(workspace)
    .values({ displayName: 'Project Cascade Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id

  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Project Cascade Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = srv!.id

  const [proj] = await db
    .insert(project)
    .values({ displayName: 'Stopped Project', workspaceId })
    .returning({ id: project.id })
  const projectId = proj!.id

  const [env] = await db
    .insert(environment)
    .values({ displayName: 'Production', projectId })
    .returning({ id: environment.id })
  const environmentId = env!.id

  const [svc] = await db
    .insert(service)
    .values({ displayName: 'web', environmentId, composeServiceName: 'web' })
    .returning({ id: service.id })
  const serviceId = svc!.id

  const [hst] = await db
    .insert(hosting)
    .values({
      serviceId,
      displayName: 'web',
      options: { hostnames: ['example.test'] },
    })
    .returning({ id: hosting.id })
  const hostingId = hst!.id

  await db.insert(container).values({
    serviceId,
    serverId,
    containerId: 'cid-exited',
    containerName: 'proj-web-1',
    status: 'exited',
    composeServiceName: 'web',
  })

  try {
    const result = await deleteProjectCascade(db, projectId)
    assertEquals(result, { ok: true })

    const [goneProject] = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    assertEquals(goneProject, undefined)

    const [goneEnv] = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.id, environmentId))
      .limit(1)
    assertEquals(goneEnv, undefined)

    const [goneHosting] = await db
      .select({ id: hosting.id })
      .from(hosting)
      .where(eq(hosting.id, hostingId))
      .limit(1)
    assertEquals(goneHosting, undefined)
  } finally {
    // Best-effort cleanup when the cascade under test did not run.
    await db.delete(container).where(eq(container.serviceId, serviceId))
    await db.delete(hosting).where(eq(hosting.id, hostingId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
