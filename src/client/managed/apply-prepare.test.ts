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
} from '../../lib/db/schema.ts'
import { ensureManagedContainerAllocation } from './allocate-managed-container.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withManagedAllocationFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    otherServerId: string
    environmentId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping apply-prepare allocation tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Managed Allocate Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Managed Allocate Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Managed Allocate Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedOtherServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Managed Allocate Other Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const otherServerId = insertedOtherServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Managed Allocate Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Managed Allocate Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await fn({ db, serverId, otherServerId, environmentId })
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(container).where(eq(container.serverId, otherServerId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(server).where(eq(server.id, otherServerId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('ensureManagedContainerAllocation creates service + ordinal-1 container named <id>-1', async () => {
  await withManagedAllocationFixtures(async ({ db, serverId, environmentId }) => {
    const allocation = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
    })

    assertEquals(allocation.containerName, `${allocation.containerRowId}-1`)

    const services = await db
      .select({
        id: service.id,
        composeServiceName: service.composeServiceName,
        displayName: service.displayName,
      })
      .from(service)
      .where(eq(service.environmentId, environmentId))
    assertEquals(services.length, 1)
    assertEquals(services[0]!.id, allocation.serviceId)
    assertEquals(services[0]!.composeServiceName, 'postgres')
    assertEquals(services[0]!.displayName, 'postgres')

    const rows = await db
      .select({
        id: container.id,
        containerName: container.containerName,
        status: container.status,
        ordinal: container.ordinal,
        containerId: container.containerId,
      })
      .from(container)
      .where(
        and(
          eq(container.serviceId, allocation.serviceId),
          eq(container.serverId, serverId),
        ),
      )
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, allocation.containerRowId)
    assertEquals(rows[0]!.containerName, `${allocation.containerRowId}-1`)
    assertEquals(rows[0]!.status, 'pending')
    assertEquals(rows[0]!.ordinal, 1)
    assertEquals(rows[0]!.containerId, null)
  })
})

test('ensureManagedContainerAllocation is idempotent on re-apply', async () => {
  await withManagedAllocationFixtures(async ({ db, serverId, environmentId }) => {
    const first = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
    })
    const second = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
    })

    assertEquals(second.serviceId, first.serviceId)
    assertEquals(second.containerRowId, first.containerRowId)
    assertEquals(second.containerName, first.containerName)

    const rows = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serviceId, first.serviceId))
    assertEquals(rows.length, 1)
  })
})

test('ensureManagedContainerAllocation prunes stray pending rows on another server', async () => {
  await withManagedAllocationFixtures(async ({
    db,
    serverId,
    otherServerId,
    environmentId,
  }) => {
    const first = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId: otherServerId,
      composeServiceName: 'postgres',
    })

    const rePin = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
    })

    assertEquals(rePin.serviceId, first.serviceId)
    assertEquals(rePin.containerRowId, first.containerRowId)
    assertEquals(rePin.containerName, first.containerName)
    assertEquals(rePin.containerName, `${rePin.containerRowId}-1`)

    const rows = await db
      .select({
        id: container.id,
        serverId: container.serverId,
        status: container.status,
      })
      .from(container)
      .where(eq(container.serviceId, first.serviceId))

    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, first.containerRowId)
    assertEquals(rows[0]!.serverId, serverId)
    assertEquals(rows[0]!.status, 'pending')
  })
})

test('ensureManagedContainerAllocation restores exited null-id ordinal-1 row to pending', async () => {
  await withManagedAllocationFixtures(async ({ db, serverId, environmentId }) => {
    const first = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
    })

    await db
      .update(container)
      .set({ status: 'exited', containerId: null })
      .where(eq(container.id, first.containerRowId))

    const second = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
    })

    assertEquals(second.containerRowId, first.containerRowId)
    assertEquals(second.containerName, first.containerName)
    assertEquals(second.serviceId, first.serviceId)

    const [row] = await db
      .select({
        id: container.id,
        status: container.status,
        containerId: container.containerId,
        containerName: container.containerName,
        composeServiceName: container.composeServiceName,
      })
      .from(container)
      .where(eq(container.id, first.containerRowId))
      .limit(1)

    assertEquals(row!.id, first.containerRowId)
    assertEquals(row!.status, 'pending')
    assertEquals(row!.containerId, null)
    assertEquals(row!.containerName, `${first.containerRowId}-1`)
    assertEquals(row!.composeServiceName, 'postgres')
  })
})
