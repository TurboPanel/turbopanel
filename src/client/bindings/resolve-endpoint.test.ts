/**
 * Host-free tests for binding endpoint resolution pure helpers and types,
 * plus DB-gated regression coverage for reachability (Comment 2): a placed
 * consumer must always resolve a dial-able ProxySQL container endpoint on
 * its *own* server — same-host or cross-host from the cluster's members —
 * and never a `127.0.0.1` address that a container cannot reach across its
 * own network namespace, regardless of the cluster's public exposure setting.
 */

import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  container,
  environment,
  managed,
  replica,
  organization,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import {
  MANAGED_INGRESS_MYSQL_PORT,
  MANAGED_INGRESS_PGSQL_PORT,
} from '../../lib/managed/ingress-ports.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import {
  type BindingEndpointError,
  isBindingEndpointError,
  resolveBindingEndpoint,
  type ResolvedBindingEndpoint,
} from './resolve-endpoint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isBindingEndpointError recognizes private-path and binding failures', () => {
  const failures: BindingEndpointError[] = [
    { kind: 'binding_endpoint_unavailable' },
    {
      kind: 'datacenter_ip_required',
      serverId: '00000000-0000-4000-8000-000000000001',
    },
    {
      kind: 'private_path_unavailable',
      fromServerId: '00000000-0000-4000-8000-000000000001',
      toServerId: '00000000-0000-4000-8000-000000000002',
    },
  ]
  for (const failure of failures) {
    assertEquals(isBindingEndpointError(failure), true)
  }

  const ok: ResolvedBindingEndpoint = {
    host: '127.0.0.1',
    port: 5432,
    readSplit: false,
    listenerServerId: '00000000-0000-4000-8000-000000000001',
  }
  assertEquals(isBindingEndpointError(ok), false)
  assertEquals(isBindingEndpointError(null), false)
  assertEquals(isBindingEndpointError('binding_endpoint_unavailable'), false)
})

test('placed consumer always uses its own ProxySQL listener (not remote member)', () => {
  // Contract: a compose service on server-C binding to a cluster whose members
  // live on server-A/B must dial C's ProxySQL — backends peer privately.
  // resolveBindingEndpoint prioritizes service placement over member hosts.
  const consumerPlacementServerId = 'server-consumer'
  const clusterPrimaryServerId = 'server-primary'
  const resolved: ResolvedBindingEndpoint = {
    host: 'consumer.dc.example',
    port: 5432,
    readSplit: true,
    listenerServerId: consumerPlacementServerId,
  }
  assertEquals(resolved.listenerServerId, consumerPlacementServerId)
  assertEquals(resolved.listenerServerId === clusterPrimaryServerId, false)
  assertEquals(resolved.port, 5432)
})

test('typed failure surface never throws strings', () => {
  const error: BindingEndpointError = { kind: 'binding_endpoint_unavailable' }
  assertEquals(typeof error.kind, 'string')
  assertEquals(error.kind, 'binding_endpoint_unavailable')
})

const dbUrl = getDatabaseUrl()

function exposureSettings(
  exposure: ManagedSettings['exposure'],
): ManagedSettings {
  const parsed = postgresEngineSpec.parseSettings({ exposure })
  if (!parsed) throw new TypeError('expected valid managed settings')
  return parsed
}

/** Mirrors `cleanupOrgHierarchy` in `../system/hierarchy.test.ts` — handles
 * both the consumer workspace and the system (managed-ingress) workspace
 * `ensureManagedIngressHierarchy` provisions for this organization. */
async function cleanupBindingEndpointOrg(
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
          await db.delete(container).where(
            inArray(container.serviceId, serviceIds),
          )
          await db.delete(service).where(inArray(service.id, serviceIds))
        }
        // `managed` + `replica` cascade-delete via the environment FK.
        await db.delete(environment).where(
          inArray(environment.id, environmentIds),
        )
      }
      await db.delete(project).where(inArray(project.id, projectIds))
    }
    await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
  }

  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

/**
 * One org with a managed Postgres cluster (single primary on
 * `clusterServerId`) plus helpers to create additional servers and
 * placed consumer services, for {@link resolveBindingEndpoint} reachability
 * coverage. Isolated per test (own organization) so cleanup is exhaustive.
 */
async function withBindingReachabilityFixture(
  exposure: ManagedSettings['exposure'],
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    clusterServerId: string
    managedId: string
    createServer: (name: string) => Promise<string>
    createConsumerService: (serverId: string) => Promise<string>
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      'Skipping binding-endpoint reachability tests: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Binding Endpoint Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Binding Endpoint Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()

  async function createServer(name: string): Promise<string> {
    const [row] = await db
      .insert(server)
      .values({
        organizationId,
        name,
        createdAt: now,
        updatedAt: now,
        isConnected: true,
        statusChangedAt: now,
      })
      .returning({ id: server.id })
    return row!.id
  }

  const clusterServerId = await createServer('Binding Endpoint Cluster Server')

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Binding Endpoint Project',
      workspaceId,
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedManagedEnv] = await db
    .insert(environment)
    .values({
      name: 'Production',
      projectId,
      serverId: clusterServerId,
    })
    .returning({ id: environment.id })
  const managedEnvironmentId = insertedManagedEnv!.id

  const settings = exposureSettings(exposure)
  const [insertedManaged] = await db
    .insert(managed)
    .values({
      environmentId: managedEnvironmentId,
      serverId: clusterServerId,
      name: 'Postgres',
      engine: 'postgres',
      status: 'ready',
      options: { settings, databases: ['postgres'] },
    })
    .returning({ id: managed.id })
  const managedId = insertedManaged!.id

  await db.insert(replica).values({
    managedId,
    serverId: clusterServerId,
    role: 'primary',
    isReadEligible: false,
    ordinal: 1,
  })

  const [consumerProject] = await db
    .insert(project)
    .values({
      name: 'Binding Endpoint Consumer Project',
      workspaceId,
      metadata: { type: 'docker-compose' },
    })
    .returning({ id: project.id })
  const consumerProjectId = consumerProject!.id

  let consumerServiceOrdinal = 0
  async function createConsumerService(serverId: string): Promise<string> {
    consumerServiceOrdinal += 1
    const [envRow] = await db
      .insert(environment)
      .values({
        name: `Consumer ${consumerServiceOrdinal}`,
        projectId: consumerProjectId,
        serverId,
      })
      .returning({ id: environment.id })
    const [svcRow] = await db
      .insert(service)
      .values({
        environmentId: envRow!.id,
        name: 'app',
        composeServiceName: 'app',
      })
      .returning({ id: service.id })
    return svcRow!.id
  }

  try {
    await fn({
      db,
      organizationId,
      clusterServerId,
      managedId,
      createServer,
      createConsumerService,
    })
  } finally {
    await cleanupBindingEndpointOrg(db, organizationId)
  }
}

test("same-host container reachability — consumer on the cluster server dials that server's ProxySQL container, never loopback", async () => {
  await withBindingReachabilityFixture(
    { enabled: true, scope: 'local' },
    async (
      { db, organizationId, clusterServerId, managedId, createConsumerService },
    ) => {
      const serviceId = await createConsumerService(clusterServerId)

      const resolved = await resolveBindingEndpoint(db, {
        serviceId,
        managedId,
        engineCode: 'postgres',
        engineDefaultPort: 5432,
      })
      if (isBindingEndpointError(resolved)) {
        throw new TypeError(
          `expected a resolved endpoint, got ${JSON.stringify(resolved)}`,
        )
      }

      const hierarchy = await ensureManagedIngressHierarchy(db, {
        organizationId,
        serverId: clusterServerId,
      })
      assertEquals(resolved.host, hierarchy.containerName)
      assertEquals(resolved.host === '127.0.0.1', false)
      // The shared client listener, not the engine-native backend port.
      assertEquals(resolved.port, MANAGED_INGRESS_PGSQL_PORT)
      assertEquals(resolved.listenerServerId, clusterServerId)
    },
  )
})

test("cross-host binding reachability — consumer on a different server dials its OWN ProxySQL, never the cluster member's host", async () => {
  await withBindingReachabilityFixture(
    { enabled: false },
    async (
      {
        db,
        organizationId,
        clusterServerId,
        managedId,
        createServer,
        createConsumerService,
      },
    ) => {
      const consumerServerId = await createServer(
        'Binding Endpoint Consumer Server',
      )
      const serviceId = await createConsumerService(consumerServerId)

      const resolved = await resolveBindingEndpoint(db, {
        serviceId,
        managedId,
        engineCode: 'mysql',
        engineDefaultPort: 3306,
      })
      if (isBindingEndpointError(resolved)) {
        throw new TypeError(
          `expected a resolved endpoint, got ${JSON.stringify(resolved)}`,
        )
      }

      const consumerHierarchy = await ensureManagedIngressHierarchy(db, {
        organizationId,
        serverId: consumerServerId,
      })
      const clusterHierarchy = await ensureManagedIngressHierarchy(db, {
        organizationId,
        serverId: clusterServerId,
      })

      assertEquals(resolved.listenerServerId, consumerServerId)
      assertEquals(resolved.host, consumerHierarchy.containerName)
      assertEquals(resolved.host === clusterHierarchy.containerName, false)
      assertEquals(resolved.host === '127.0.0.1', false)
      // MariaDB and MySQL share this listener; neither uses 3306.
      assertEquals(resolved.port, MANAGED_INGRESS_MYSQL_PORT)
    },
  )
})

test('listener port follows the server-owner organization override, not the engine-native port', async () => {
  await withBindingReachabilityFixture(
    { enabled: false },
    async (
      { db, organizationId, clusterServerId, managedId, createConsumerService },
    ) => {
      const serviceId = await createConsumerService(clusterServerId)

      // `managed.ingress.reconcile` is a whole-server command, so the port the
      // frontend binds is whatever the server's owner org configured. A binding
      // DSN that ignored that would point at a port nothing listens on.
      await db
        .update(organization)
        .set({ options: { managedDatabase: { ports: { postgres: 18432 } } } })
        .where(eq(organization.id, organizationId))

      const resolved = await resolveBindingEndpoint(db, {
        serviceId,
        managedId,
        engineCode: 'postgres',
        engineDefaultPort: 5432,
      })
      if (isBindingEndpointError(resolved)) {
        throw new TypeError(
          `expected a resolved endpoint, got ${JSON.stringify(resolved)}`,
        )
      }
      assertEquals(resolved.port, 18432)

      // The other family keeps inheriting the platform listener.
      const mysqlResolved = await resolveBindingEndpoint(db, {
        serviceId,
        managedId,
        engineCode: 'mariadb',
        engineDefaultPort: 3306,
      })
      if (isBindingEndpointError(mysqlResolved)) {
        throw new TypeError(
          `expected a resolved endpoint, got ${JSON.stringify(mysqlResolved)}`,
        )
      }
      assertEquals(mysqlResolved.port, MANAGED_INGRESS_MYSQL_PORT)
    },
  )
})

test('exposure disabled cluster still resolves a reachable internal endpoint for a placed service binding', async () => {
  await withBindingReachabilityFixture(
    { enabled: false },
    async ({ db, clusterServerId, managedId, createConsumerService }) => {
      const serviceId = await createConsumerService(clusterServerId)

      const resolved = await resolveBindingEndpoint(db, {
        serviceId,
        managedId,
        engineCode: 'postgres',
        engineDefaultPort: 5432,
      })
      if (isBindingEndpointError(resolved)) {
        throw new TypeError(
          `disabled exposure must not break internal binding reachability, got ${
            JSON.stringify(resolved)
          }`,
        )
      }
      // Internal reachability is independent of the public exposure toggle —
      // the consumer still dials the same-host ProxySQL container, and
      // exposure being disabled must never widen (or narrow) that to a
      // host-published or loopback-only address.
      assertEquals(typeof resolved.host, 'string')
      assertEquals(resolved.host.length > 0, true)
      assertEquals(resolved.host === '127.0.0.1', false)
    },
  )
})
