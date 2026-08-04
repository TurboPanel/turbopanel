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

test('reconcileEnvironmentContainers fills pre-allocated row without inserting another', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const [preallocated] = await db
      .insert(container)
      .values({
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc',
        status: 'pending',
        composeServiceName: 'web',
        ordinal: 1,
      })
      .returning({ id: container.id })

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'docker-cid-1',
          containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc',
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        id: container.id,
        containerId: container.containerId,
        status: container.status,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, preallocated!.id)
    assertEquals(rows[0]!.containerId, 'docker-cid-1')
    assertEquals(rows[0]!.status, 'running')
  })
})

test('reconcileEnvironmentContainers rename/rebuild keeps one row by name match', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const [existing] = await db
      .insert(container)
      .values({
        serviceId: webServiceId,
        serverId,
        containerId: 'old-cid',
        containerName: 'stable-name',
        status: 'running',
        composeServiceName: 'web',
        ordinal: 1,
      })
      .returning({ id: container.id })

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          composeServiceName: 'web',
          containerId: 'new-cid',
          containerName: 'stable-name',
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        id: container.id,
        containerId: container.containerId,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, existing!.id)
    assertEquals(rows[0]!.containerId, 'new-cid')
  })
})

test('reconcileEnvironmentContainers maps multi-instance clone reports to ordinals', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: 'cid-a',
        status: 'pending',
        composeServiceName: 'web-1',
        ordinal: 1,
      },
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: 'cid-b',
        status: 'pending',
        composeServiceName: 'web-2',
        ordinal: 2,
      },
    ])

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          composeServiceName: 'web-2',
          containerId: 'docker-2',
          containerName: 'cid-b',
          status: 'running',
        },
        {
          composeServiceName: 'web-1',
          containerId: 'docker-1',
          containerName: 'cid-a',
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        ordinal: container.ordinal,
        containerId: container.containerId,
        composeServiceName: container.composeServiceName,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 2)
    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]))
    assertEquals(byOrdinal.get(1)?.containerId, 'docker-1')
    assertEquals(byOrdinal.get(1)?.composeServiceName, 'web-1')
    assertEquals(byOrdinal.get(2)?.containerId, 'docker-2')
    assertEquals(byOrdinal.get(2)?.composeServiceName, 'web-2')
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

test('reconcileEnvironmentContainers deletes stale pending outside current instances', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    await db
      .update(service)
      .set({ options: { instances: 2 } })
      .where(eq(service.id, webServiceId))

    // Ordinals 1–2 are current pre-allocations; ordinal 3 is stale after a
    // scale-down path that skipped allocation cleanup.
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: 'cid-1',
        status: 'pending',
        composeServiceName: 'web-1',
        ordinal: 1,
      },
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: 'cid-2',
        status: 'pending',
        composeServiceName: 'web-2',
        ordinal: 2,
      },
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: 'cid-stale',
        status: 'pending',
        composeServiceName: 'web-3',
        ordinal: 3,
      },
    ])

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          composeServiceName: 'web-1',
          containerId: 'docker-1',
          containerName: 'cid-1',
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        ordinal: container.ordinal,
        containerId: container.containerId,
        status: container.status,
        containerName: container.containerName,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 2)
    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]))
    assertEquals(byOrdinal.get(1)?.containerId, 'docker-1')
    assertEquals(byOrdinal.get(1)?.status, 'running')
    assertEquals(byOrdinal.get(2)?.containerId, null)
    assertEquals(byOrdinal.get(2)?.status, 'pending')
    assertEquals(byOrdinal.get(2)?.containerName, 'cid-2')
    assertEquals(byOrdinal.has(3), false)
  })
})

test('reconcileEnvironmentContainers keeps app + ingress rows under one service', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: `${webServiceId}-1`,
        status: 'pending',
        role: 'app',
        composeServiceName: 'web',
        ordinal: 1,
      },
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: `${webServiceId}-ingress`,
        status: 'pending',
        role: 'ingress',
        composeServiceName: 'web-ingress',
        ordinal: 1,
      },
    ])

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          containerId: 'cid-app',
          containerName: `${webServiceId}-1`,
          status: 'running',
        },
        {
          serviceId: webServiceId,
          composeServiceName: 'web-ingress',
          containerId: 'cid-ingress',
          containerName: `${webServiceId}-ingress`,
          status: 'running',
          role: 'ingress',
        },
      ],
    })

    const rows = await db
      .select({
        role: container.role,
        containerId: container.containerId,
        status: container.status,
        ordinal: container.ordinal,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 2)
    const byRole = new Map(rows.map((row) => [row.role, row]))
    assertEquals(byRole.get('app')?.containerId, 'cid-app')
    assertEquals(byRole.get('app')?.status, 'running')
    assertEquals(byRole.get('app')?.ordinal, 1)
    assertEquals(byRole.get('ingress')?.containerId, 'cid-ingress')
    assertEquals(byRole.get('ingress')?.status, 'running')
    assertEquals(byRole.get('ingress')?.ordinal, 1)
  })
})

test('reconcileEnvironmentContainers classifies ingress by containerName when role omitted', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: `${webServiceId}-1`,
        status: 'pending',
        role: 'app',
        composeServiceName: 'web',
        ordinal: 1,
      },
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: `${webServiceId}-ingress`,
        status: 'pending',
        role: 'ingress',
        composeServiceName: 'web-ingress',
        ordinal: 1,
      },
    ])

    const existing = await db
      .select({
        id: container.id,
        role: container.role,
        containerName: container.containerName,
      })
      .from(container)
      .where(eq(container.serverId, serverId))
    const appId = existing.find((row) => row.role === 'app')!.id
    const ingressId = existing.find((row) => row.role === 'ingress')!.id

    // Omit role; composeServiceName does not end with -ingress — only the
    // containerName suffix must classify this report as ingress. Use a name
    // that does not match the pre-allocated ingress row so matching goes
    // through (service, role, ordinal) rather than container_name.
    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          containerId: 'cid-ingress-by-name',
          containerName: `host-${webServiceId}-ingress`,
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        id: container.id,
        role: container.role,
        containerId: container.containerId,
        containerName: container.containerName,
        status: container.status,
        ordinal: container.ordinal,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 2)
    const byRole = new Map(rows.map((row) => [row.role, row]))
    assertEquals(byRole.get('app')?.id, appId)
    assertEquals(byRole.get('app')?.containerId, null)
    assertEquals(byRole.get('app')?.status, 'pending')
    assertEquals(byRole.get('app')?.containerName, `${webServiceId}-1`)
    assertEquals(byRole.get('ingress')?.id, ingressId)
    assertEquals(byRole.get('ingress')?.containerId, 'cid-ingress-by-name')
    assertEquals(byRole.get('ingress')?.status, 'running')
    assertEquals(byRole.get('ingress')?.ordinal, 1)
    assertEquals(
      byRole.get('ingress')?.containerName,
      `host-${webServiceId}-ingress`,
    )
  })
})

test('reconcileEnvironmentContainers leaves pending ingress intact on app-only report', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    await db.insert(container).values([
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: `${webServiceId}-1`,
        status: 'pending',
        role: 'app',
        composeServiceName: 'web',
        ordinal: 1,
      },
      {
        serviceId: webServiceId,
        serverId,
        containerId: null,
        containerName: `${webServiceId}-ingress`,
        status: 'pending',
        role: 'ingress',
        composeServiceName: 'web-ingress',
        ordinal: 1,
      },
    ])

    const ingressId = (await db
      .select({ id: container.id })
      .from(container)
      .where(
        and(
          eq(container.serverId, serverId),
          eq(container.role, 'ingress'),
        ),
      ))[0]!.id

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          containerId: 'cid-app-only',
          containerName: `${webServiceId}-1`,
          status: 'running',
        },
      ],
    })

    const rows = await db
      .select({
        id: container.id,
        role: container.role,
        containerId: container.containerId,
        status: container.status,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 2)
    const byRole = new Map(rows.map((row) => [row.role, row]))
    assertEquals(byRole.get('app')?.containerId, 'cid-app-only')
    assertEquals(byRole.get('app')?.status, 'running')
    assertEquals(byRole.get('ingress')?.id, ingressId)
    assertEquals(byRole.get('ingress')?.containerId, null)
    assertEquals(byRole.get('ingress')?.status, 'pending')
  })
})

test('reconcileEnvironmentContainers app+ingress report is idempotent', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
  }) => {
    const report = [
      {
        serviceId: webServiceId,
        composeServiceName: 'web',
        containerId: 'cid-app',
        containerName: `${webServiceId}-1`,
        status: 'running' as const,
      },
      {
        serviceId: webServiceId,
        composeServiceName: 'web-ingress',
        containerId: 'cid-ingress',
        containerName: `${webServiceId}-ingress`,
        status: 'running' as const,
        role: 'ingress' as const,
      },
    ]

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: report,
    })

    const first = await db
      .select({
        id: container.id,
        role: container.role,
        containerId: container.containerId,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(first.length, 2)
    const firstIds = first.map((row) => row.id).sort((a, b) => a.localeCompare(b))

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: report,
    })

    const second = await db
      .select({
        id: container.id,
        role: container.role,
        containerId: container.containerId,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(second.length, 2)
    assertEquals(
      second.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
      firstIds,
    )
    const byRole = new Map(second.map((row) => [row.role, row]))
    assertEquals(byRole.get('app')?.containerId, 'cid-app')
    assertEquals(byRole.get('ingress')?.containerId, 'cid-ingress')
  })
})

test('reconcileEnvironmentContainers resets rather than deletes on empty report', async () => {
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
      .select({
        containerId: container.containerId,
        status: container.status,
        containerName: container.containerName,
      })
      .from(container)
      .where(
        and(
          eq(container.serverId, serverId),
        ),
      )

    assertEquals(rows.length, 2)
    for (const row of rows) {
      assertEquals(row.containerId, null)
      assertEquals(row.status, 'exited')
    }
    assertEquals(
      rows.map((r) => r.containerName).sort((a, b) => a.localeCompare(b)),
      ['proj-web-1', 'proj-worker-1'],
    )
  })
})

test('reconcileEnvironmentContainers resets unmatched expected allocations instead of deleting', async () => {
  await withReconcileFixtures(async ({
    db,
    serverId,
    environmentId,
    webServiceId,
    workerServiceId,
  }) => {
    const [webRow] = await db
      .insert(container)
      .values({
        serviceId: webServiceId,
        serverId,
        containerId: 'cid-web',
        containerName: webServiceId,
        status: 'running',
        role: 'app',
        composeServiceName: 'web',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const [workerRow] = await db
      .insert(container)
      .values({
        serviceId: workerServiceId,
        serverId,
        containerId: 'cid-worker',
        containerName: workerServiceId,
        status: 'running',
        role: 'app',
        composeServiceName: 'worker',
        ordinal: 1,
      })
      .returning({ id: container.id })

    await reconcileEnvironmentContainers(db, {
      serverId,
      environmentId,
      containers: [
        {
          serviceId: webServiceId,
          composeServiceName: 'web',
          containerId: 'cid-web-new',
          containerName: webServiceId,
          status: 'running',
          role: 'app',
        },
      ],
      expectedAllocations: [
        { serviceId: webServiceId, role: 'app', ordinal: 1 },
        { serviceId: workerServiceId, role: 'app', ordinal: 1 },
      ],
    })

    const rows = await db
      .select({
        id: container.id,
        serviceId: container.serviceId,
        containerId: container.containerId,
        status: container.status,
      })
      .from(container)
      .where(eq(container.serverId, serverId))

    assertEquals(rows.length, 2)
    const byService = new Map(rows.map((row) => [row.serviceId, row]))
    assertEquals(byService.get(webServiceId)?.id, webRow!.id)
    assertEquals(byService.get(webServiceId)?.containerId, 'cid-web-new')
    assertEquals(byService.get(webServiceId)?.status, 'running')
    assertEquals(byService.get(workerServiceId)?.id, workerRow!.id)
    assertEquals(byService.get(workerServiceId)?.containerId, null)
    assertEquals(byService.get(workerServiceId)?.status, 'exited')
  })
})
