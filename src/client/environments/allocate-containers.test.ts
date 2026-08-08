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
import {
  allocateEnvironmentContainers,
  buildContainerServiceSpecs,
  ensureServiceIngressContainerAllocation,
  pruneUnexpectedPendingContainers,
  resolveAllocatedContainerName,
} from './allocate-containers.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveAllocatedContainerName prefers explicit name in every naming mode', () => {
  assertEquals(
    resolveAllocatedContainerName({
      explicitContainerName: 'my-app',
      serviceId: '01936b3e-aaaa-bbbb-cccc-123456789abc',
      ordinal: 1,
      instances: 1,
    }),
    'my-app',
  )
})

test('resolveAllocatedContainerName suffixes ordinal for multi-instance explicit names', () => {
  assertEquals(
    resolveAllocatedContainerName({
      explicitContainerName: 'my-app',
      serviceId: '01936b3e-aaaa-bbbb-cccc-123456789abc',
      ordinal: 2,
      instances: 3,
    }),
    'my-app-2',
  )
})

test('resolveAllocatedContainerName falls back to service id when no explicit name', () => {
  const serviceId = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  assertEquals(
    resolveAllocatedContainerName({
      explicitContainerName: undefined,
      serviceId,
      ordinal: 1,
      instances: 1,
    }),
    serviceId,
  )
  assertEquals(
    resolveAllocatedContainerName({
      explicitContainerName: undefined,
      serviceId,
      ordinal: 2,
      instances: 2,
    }),
    `${serviceId}-2`,
  )
})

async function withAllocationFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    otherServerId: string
    environmentId: string
    webServiceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping allocate-containers tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Allocate Containers Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Allocate Containers Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Allocate Containers Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedOtherServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Allocate Containers Server B',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const otherServerId = insertedOtherServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Allocate Containers Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Allocate Containers Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [webService] = await db
    .insert(service)
    .values({
      environmentId,
      name: 'web',
      composeServiceName: 'web',
    })
    .returning({ id: service.id })
  const webServiceId = webService!.id

  try {
    await fn({ db, serverId, otherServerId, environmentId, webServiceId })
  } finally {
    await db.delete(container).where(eq(container.serviceId, webServiceId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(server).where(eq(server.id, otherServerId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('allocateEnvironmentContainers uses explicit name in default uuid mode', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const allocations = await allocateEnvironmentContainers(db, {
      environmentId,
      serverId,
      containerNaming: 'uuid',
      containerServices: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          instances: 1,
          explicitContainerName: 'explicit-web',
        },
      ],
      environmentServiceIds: [webServiceId],
    })

    assertEquals(allocations.length, 1)
    assertEquals(allocations[0]!.containerName, 'explicit-web')

    const rows = await db
      .select({
        containerName: container.containerName,
        status: container.status,
      })
      .from(container)
      .where(
        and(
          eq(container.serviceId, webServiceId),
          eq(container.serverId, serverId),
        ),
      )
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.containerName, 'explicit-web')
    assertEquals(rows[0]!.status, 'pending')
  })
})

test('allocateEnvironmentContainers suffixes explicit names for multi-instance', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const allocations = await allocateEnvironmentContainers(db, {
      environmentId,
      serverId,
      containerNaming: 'uuid',
      containerServices: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          instances: 2,
          explicitContainerName: 'explicit-web',
        },
      ],
      environmentServiceIds: [webServiceId],
    })

    assertEquals(allocations.length, 2)
    const names = allocations
      .map((row) => row.containerName)
      .sort((a, b) => a.localeCompare(b))
    assertEquals(names, ['explicit-web-1', 'explicit-web-2'])
    assertEquals(
      allocations.map((row) => row.cloneComposeServiceName).sort((a, b) => a.localeCompare(b)),
      ['web-1', 'web-2'],
    )
  })
})

test('allocateEnvironmentContainers reuses rows on concurrent/repeated calls', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const specs = [
      {
        serviceId: webServiceId,
        composeServiceName: 'web',
        instances: 2,
        explicitContainerName: 'explicit-web',
      },
    ] as const

    const [first, second] = await Promise.all([
      allocateEnvironmentContainers(db, {
        environmentId,
        serverId,
        containerNaming: 'uuid',
        containerServices: specs,
        environmentServiceIds: [webServiceId],
      }),
      allocateEnvironmentContainers(db, {
        environmentId,
        serverId,
        containerNaming: 'uuid',
        containerServices: specs,
        environmentServiceIds: [webServiceId],
      }),
    ])

    assertEquals(first.length, 2)
    assertEquals(second.length, 2)

    const firstIds = first.map((row) => row.containerRowId).sort((a, b) => a.localeCompare(b))
    const secondIds = second.map((row) => row.containerRowId).sort((a, b) => a.localeCompare(b))
    assertEquals(firstIds, secondIds)

    const rows = await db
      .select({ id: container.id })
      .from(container)
      .where(
        and(
          eq(container.serviceId, webServiceId),
          eq(container.serverId, serverId),
        ),
      )
    assertEquals(rows.length, 2)
  })
})

test('buildContainerServiceSpecs skips non-container compose names and reads instances', () => {
  const serviceId = '01936b3e-4444-5555-6666-123456789abc'
  const specs = buildContainerServiceSpecs(
    [{
      id: serviceId,
      composeServiceName: 'web',
      options: { instances: 3 },
    }, {
      id: '01936b3e-bbbb-cccc-dddd-123456789abc',
      composeServiceName: 'site',
      options: {},
    }],
    new Set(['web']),
    new Map([['web', 'explicit-web']]),
  )
  assertEquals(specs.length, 1)
  assertEquals(specs[0]?.serviceId, serviceId)
  assertEquals(specs[0]?.instances, 3)
  assertEquals(specs[0]?.explicitContainerName, 'explicit-web')
})

test('allocateEnvironmentContainers skips custom naming without explicit container name', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const allocations = await allocateEnvironmentContainers(db, {
      environmentId,
      serverId,
      containerNaming: 'custom',
      containerServices: [{
        serviceId: webServiceId,
        composeServiceName: 'web',
        instances: 1,
      }],
      environmentServiceIds: [webServiceId],
    })
    assertEquals(allocations, [])

    const rows = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serviceId, webServiceId))
    assertEquals(rows.length, 0)
  })
})

test('ensureServiceIngressContainerAllocation is idempotent and re-homes server', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    otherServerId,
    webServiceId,
  }) => {
    const first = await ensureServiceIngressContainerAllocation(db, {
      serviceId: webServiceId,
      serverId,
      composeServiceName: `${webServiceId}-in`,
    })
    const second = await ensureServiceIngressContainerAllocation(db, {
      serviceId: webServiceId,
      serverId: otherServerId,
      composeServiceName: `${webServiceId}-in`,
    })

    assertEquals(first.containerRowId, second.containerRowId)
    assertEquals(first.containerName, `${webServiceId}-in`)
    assertEquals(second.containerName, `${webServiceId}-in`)

    const rows = await db
      .select({
        id: container.id,
        serverId: container.serverId,
        role: container.role,
        composeServiceName: container.composeServiceName,
      })
      .from(container)
      .where(eq(container.serviceId, webServiceId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.role, 'ingress')
    assertEquals(rows[0]?.serverId, otherServerId)
    assertEquals(rows[0]?.composeServiceName, `${webServiceId}-in`)
  })
})

test('pruneUnexpectedPendingContainers removes stale pending rows but keeps keepIds', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    webServiceId,
  }) => {
    const [kept] = await db
      .insert(container)
      .values({
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: 'keep-me',
        status: 'pending',
        role: 'service',
        composeServiceName: 'web',
        ordinal: 1,
      })
      .returning({ id: container.id })
    await db.insert(container).values({
      serviceId: webServiceId,
      serverId,
      containerId: null,
      containerName: 'stale',
      status: 'pending',
      role: 'service',
      composeServiceName: 'web-stale',
      ordinal: 2,
    })

    await pruneUnexpectedPendingContainers(db, {
      serviceIds: [webServiceId],
      keepIds: new Set([kept!.id]),
    })

    const rows = await db
      .select({ id: container.id, containerName: container.containerName })
      .from(container)
      .where(eq(container.serviceId, webServiceId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.id, kept!.id)
    assertEquals(rows[0]?.containerName, 'keep-me')
  })
})

test('allocateEnvironmentContainers re-homes rows when placement server changes', async () => {
  await withAllocationFixtures(async ({
    db,
    serverId,
    otherServerId,
    environmentId,
    webServiceId,
  }) => {
    const specs = [
      {
        serviceId: webServiceId,
        composeServiceName: 'web',
        instances: 1,
      },
    ] as const

    const first = await allocateEnvironmentContainers(db, {
      environmentId,
      serverId,
      containerNaming: 'uuid',
      containerServices: specs,
      environmentServiceIds: [webServiceId],
    })

    assertEquals(first.length, 1)
    const firstRowId = first[0]!.containerRowId
    const firstName = first[0]!.containerName
    assertEquals(firstName, webServiceId)

    const second = await allocateEnvironmentContainers(db, {
      environmentId,
      serverId: otherServerId,
      containerNaming: 'uuid',
      containerServices: specs,
      environmentServiceIds: [webServiceId],
    })

    assertEquals(second.length, 1)
    assertEquals(second[0]!.containerRowId, firstRowId)
    assertEquals(second[0]!.containerName, firstName)

    const rows = await db
      .select({
        id: container.id,
        serverId: container.serverId,
        containerName: container.containerName,
        status: container.status,
      })
      .from(container)
      .where(eq(container.serviceId, webServiceId))

    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, firstRowId)
    assertEquals(rows[0]!.serverId, otherServerId)
    assertEquals(rows[0]!.containerName, firstName)
    assertEquals(rows[0]!.status, 'pending')

    const staleOnFirstServer = await db
      .select({ id: container.id })
      .from(container)
      .where(
        and(
          eq(container.serviceId, webServiceId),
          eq(container.serverId, serverId),
        ),
      )
    assertEquals(staleOnFirstServer.length, 0)
  })
})
