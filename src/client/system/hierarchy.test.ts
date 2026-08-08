import { assertEquals } from 'jsr:@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
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
import { WORKSPACE_KIND_SYSTEM } from '../../lib/db/workspace-kind.ts'
import {
  deleteSystemEnvironmentSubtree,
  ensureSelfHostSystemHierarchy,
  ensureSystemHierarchy,
  ensureSystemWorkspace,
  findSystemEnvironmentForServer,
  isSystemSelfHostComposeServiceName,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_SELF_HOST_COMPONENT,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
} from './hierarchy.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withHierarchyFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping system hierarchy tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'System Hierarchy Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'System Hierarchy Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, organizationId, serverId })
  } finally {
    await cleanupOrgHierarchy(db, organizationId)
  }
}

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

test('ensureSystemHierarchy is idempotent for the same org/server', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const first = await ensureSystemHierarchy(db, { organizationId, serverId })
    const second = await ensureSystemHierarchy(db, { organizationId, serverId })

    assertEquals(second.workspaceId, first.workspaceId)
    assertEquals(second.projectId, first.projectId)
    assertEquals(second.environmentId, first.environmentId)
    assertEquals(second.serviceId, first.serviceId)
    assertEquals(second.containerRowId, first.containerRowId)
    assertEquals(second.containerName, first.containerName)
  })
})

test('hierarchy ensure reuses an install-created System workspace', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const installWorkspaceId = await ensureSystemWorkspace(db, organizationId)

    const ingress = await ensureSystemHierarchy(db, { organizationId, serverId })
    const selfHost = await ensureSelfHostSystemHierarchy(db, {
      organizationId,
      serverId,
    })

    assertEquals(ingress.workspaceId, installWorkspaceId)
    assertEquals(selfHost.workspaceId, installWorkspaceId)

    const systemRows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(
        eq(workspace.organizationId, organizationId),
        eq(workspace.kind, WORKSPACE_KIND_SYSTEM),
      ))
    assertEquals(systemRows.length, 1)
    assertEquals(systemRows[0]?.id, installWorkspaceId)
  })
})

test('ensureSystemHierarchy reuses workspace/project across servers', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const first = await ensureSystemHierarchy(db, { organizationId, serverId })

    const now = new Date().toISOString()
    const [secondServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'System Hierarchy Server 2',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    const secondServerId = secondServer!.id

    const second = await ensureSystemHierarchy(db, {
      organizationId,
      serverId: secondServerId,
    })

    assertEquals(second.workspaceId, first.workspaceId)
    assertEquals(second.projectId, first.projectId)
    assertEquals(second.environmentId === first.environmentId, false)
    assertEquals(second.serviceId === first.serviceId, false)
    assertEquals(second.containerRowId === first.containerRowId, false)
  })
})

test('concurrent ensureSystemHierarchy creates exact hierarchy row counts', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    await Promise.all([
      ensureSystemHierarchy(db, { organizationId, serverId }),
      ensureSystemHierarchy(db, { organizationId, serverId }),
      ensureSystemHierarchy(db, { organizationId, serverId }),
    ])

    const workspaceRows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        and(
          eq(workspace.organizationId, organizationId),
          eq(workspace.kind, WORKSPACE_KIND_SYSTEM),
        ),
      )
    assertEquals(workspaceRows.length, 1)

    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.workspaceId, workspaceRows[0]!.id))
    assertEquals(projectRows.length, 1)

    const environmentRows = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, projectRows[0]!.id))
    assertEquals(environmentRows.length, 1)

    const serviceRows = await db
      .select({ id: service.id })
      .from(service)
      .where(eq(service.environmentId, environmentRows[0]!.id))
    assertEquals(serviceRows.length, 1)

    const containerRows = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serviceId, serviceRows[0]!.id))
    assertEquals(containerRows.length, 1)
  })
})

test('ensureSelfHostSystemHierarchy is idempotent for the same org/server', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const first = await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })
    const second = await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })

    assertEquals(second.workspaceId, first.workspaceId)
    assertEquals(second.projectId, first.projectId)
    assertEquals(second.environmentId, first.environmentId)
    assertEquals(second.services.length, first.services.length)

    const firstByComposeName = new Map(
      first.services.map((svc) => [svc.composeServiceName, svc]),
    )
    for (const svc of second.services) {
      const matching = firstByComposeName.get(svc.composeServiceName)
      assertEquals(svc.serviceId, matching?.serviceId)
      assertEquals(svc.containerRowId, matching?.containerRowId)
      assertEquals(svc.containerName, matching?.containerName)
    }
  })
})

test('ensureSelfHostSystemHierarchy provisions database/queue/analytics with pending uuid-named containers', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const result = await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })

    assertEquals(result.services.length, SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES.length)
    assertEquals(
      result.services.map((svc) => svc.composeServiceName).sort(),
      [...SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES].sort(),
    )
    // Pinned against a literal, independent of the constant under test — host-native
    // components (Caddy, Redis, the instance, turbopaneld) must never appear here.
    // Their status/restart lives on the server Control tab, not the container table.
    assertEquals(
      result.services.map((svc) => svc.composeServiceName).sort(),
      ['analytics', 'database', 'queue'],
    )

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, result.projectId))
      .limit(1)
    assertEquals(
      (projectRow?.metadata as Record<string, unknown> | null)?.component,
      SYSTEM_SELF_HOST_COMPONENT,
    )
    // No organizationId/serverId leak into project metadata — those columns
    // (workspace.organization_id / environment.server_id) are the source of
    // truth.
    assertEquals(
      'organizationId' in ((projectRow?.metadata as Record<string, unknown>) ?? {}),
      false,
    )

    for (const svc of result.services) {
      // Container name is the service's own uuid (containerNaming: 'uuid').
      assertEquals(svc.containerName, svc.serviceId)

      const [containerRow] = await db
        .select({
          status: container.status,
          containerId: container.containerId,
          role: container.role,
          serverId: container.serverId,
          containerName: container.containerName,
          metadata: container.metadata,
        })
        .from(container)
        .where(eq(container.id, svc.containerRowId))
        .limit(1)

      assertEquals(containerRow?.status, 'pending')
      assertEquals(containerRow?.containerId, null)
      assertEquals(containerRow?.role, 'system')
      assertEquals(containerRow?.serverId, serverId)
      assertEquals(containerRow?.containerName, svc.serviceId)
      assertEquals(
        'organizationId' in ((containerRow?.metadata as Record<string, unknown>) ?? {}),
        false,
      )
      assertEquals(
        'serverId' in ((containerRow?.metadata as Record<string, unknown>) ?? {}),
        false,
      )
    }
  })
})

test('ensureSystemHierarchy and ensureSelfHostSystemHierarchy coexist for the same server', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const ingress = await ensureSystemHierarchy(db, { organizationId, serverId })
    const selfHost = await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })

    // Same system workspace, distinct projects/environments/services.
    assertEquals(selfHost.workspaceId, ingress.workspaceId)
    assertEquals(selfHost.projectId === ingress.projectId, false)
    assertEquals(selfHost.environmentId === ingress.environmentId, false)

    const workspaceRows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        and(
          eq(workspace.organizationId, organizationId),
          eq(workspace.kind, WORKSPACE_KIND_SYSTEM),
        ),
      )
    assertEquals(workspaceRows.length, 1)

    const environmentRows = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.serverId, serverId))
    assertEquals(environmentRows.length, 2)
  })
})

test('concurrent ensureSelfHostSystemHierarchy creates exact hierarchy row counts', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    await Promise.all([
      ensureSelfHostSystemHierarchy(db, { organizationId, serverId }),
      ensureSelfHostSystemHierarchy(db, { organizationId, serverId }),
      ensureSelfHostSystemHierarchy(db, { organizationId, serverId }),
    ])

    const workspaceRows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        and(
          eq(workspace.organizationId, organizationId),
          eq(workspace.kind, WORKSPACE_KIND_SYSTEM),
        ),
      )
    assertEquals(workspaceRows.length, 1)

    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.workspaceId, workspaceRows[0]!.id))
    assertEquals(projectRows.length, 1)

    const environmentRows = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, projectRows[0]!.id))
    assertEquals(environmentRows.length, 1)

    const serviceRows = await db
      .select({ id: service.id })
      .from(service)
      .where(eq(service.environmentId, environmentRows[0]!.id))
    assertEquals(serviceRows.length, SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES.length)

    const serviceIds = serviceRows.map((row) => row.id)
    const containerRows = await db
      .select({ id: container.id })
      .from(container)
      .where(inArray(container.serviceId, serviceIds))
    assertEquals(containerRows.length, SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES.length)
  })
})

test('isSystemSelfHostComposeServiceName recognizes self-host compose services', () => {
  for (const name of SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES) {
    assertEquals(isSystemSelfHostComposeServiceName(name), true)
  }
  assertEquals(isSystemSelfHostComposeServiceName('traefik'), false)
  assertEquals(isSystemSelfHostComposeServiceName('redis'), false)
})

test('findSystemEnvironmentForServer filters by project component', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const ingress = await ensureSystemHierarchy(db, { organizationId, serverId })
    const selfHost = await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })

    assertEquals(
      await findSystemEnvironmentForServer(db, serverId, SYSTEM_HOSTING_INGRESS_COMPONENT),
      ingress.environmentId,
    )
    assertEquals(
      await findSystemEnvironmentForServer(db, serverId, SYSTEM_SELF_HOST_COMPONENT),
      selfHost.environmentId,
    )
    assertEquals(
      await findSystemEnvironmentForServer(db, serverId, 'missing-component'),
      null,
    )

    const firstMatch = await findSystemEnvironmentForServer(db, serverId)
    assertEquals(
      firstMatch === ingress.environmentId || firstMatch === selfHost.environmentId,
      true,
    )
  })
})

test('deleteSystemEnvironmentSubtree removes services and containers but keeps shared project', async () => {
  await withHierarchyFixtures(async ({ db, organizationId, serverId }) => {
    const ingress = await ensureSystemHierarchy(db, { organizationId, serverId })

    await db.transaction(async (tx) => {
      await deleteSystemEnvironmentSubtree(tx, ingress.environmentId)
    })

    const environmentRows = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.id, ingress.environmentId))
    assertEquals(environmentRows.length, 0)

    const serviceRows = await db
      .select({ id: service.id })
      .from(service)
      .where(eq(service.id, ingress.serviceId))
    assertEquals(serviceRows.length, 0)

    const containerRows = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.id, ingress.containerRowId))
    assertEquals(containerRows.length, 0)

    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, ingress.projectId))
    assertEquals(projectRows.length, 1)
  })
})
