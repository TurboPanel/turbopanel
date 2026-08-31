import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  binding,
  command,
  dispatch,
  container,
  environment,
  hosting,
  managed,
  organization,
  principal,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import {
  ensureManagedIngressHierarchy,
  ensureSelfHostSystemHierarchy,
  ensureSystemHierarchy,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
} from './hierarchy.ts'
import {
  buildSystemReconcilePayload,
  enqueueSystemReconcile,
  enqueueSystemReconcileIfConnected,
  resolveHostingIngressDesired,
  runSystemReconcileSweep,
  SYSTEM_RECONCILE_MIN_INTERVAL_MS,
} from './reconcile.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[]
} {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

async function cleanupOrg(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  serverId: string,
): Promise<void> {
  await db.delete(command).where(eq(command.serverId, serverId))

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
      const environmentRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(inArray(environment.projectId, projectIds))
      const environmentIds = environmentRows.map((row) => row.id)

      if (environmentIds.length > 0) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, environmentIds))
        const serviceIds = serviceRows.map((row) => row.id)
        if (serviceIds.length > 0) {
          await db.delete(container).where(inArray(container.serviceId, serviceIds))
          await db.delete(hosting).where(inArray(hosting.serviceId, serviceIds))
          await db.delete(service).where(inArray(service.id, serviceIds))
        }
        await db.delete(environment).where(inArray(environment.id, environmentIds))
      }
      await db.delete(project).where(inArray(project.id, projectIds))
    }
    await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
  }

  await db.delete(server).where(eq(server.id, serverId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

async function withReconcileFixtures(
  options: Readonly<{
    hostingEnabled?: boolean
    connected?: boolean
    /** When set, overrides the default `status_changed_at = now`. */
    statusChangedAt?: string
    /** Also provision the self-host (`turbopanel`) environment on this server. */
    selfHost?: boolean
    /**
     * Seed an HTTP hosting with hostnames on this server so shared Traefik
     * is demand-present (otherwise pending ingress inventory must not start).
     */
    httpIngressDemand?: boolean
  }>,
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
    queue: ReturnType<typeof createRecordingCommandQueue>
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping system reconcile tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'System Reconcile Sweep Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const hostingEnabled = options.hostingEnabled ?? true
  const connected = options.connected ?? true
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'System Reconcile Sweep Server',
      isConnected: connected,
      statusChangedAt: options.statusChangedAt ?? now,
      options: { hosting: { enabled: hostingEnabled } },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  await ensureSystemHierarchy(db, { organizationId, serverId })
  if (options.selfHost) {
    await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })
  }

  if (options.httpIngressDemand) {
    const [ws] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Tenant Workspace' })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({
        workspaceId: ws!.id,
        name: 'Tenant Project',
        metadata: { type: 'docker-compose' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({
        projectId: proj!.id,
        serverId,
        name: 'Production',
      })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({
        environmentId: env!.id,
        name: 'web',
        composeServiceName: 'web',
      })
      .returning({ id: service.id })
    await db.insert(hosting).values({
      serviceId: svc!.id,
      options: { hostnames: ['app.example.test'] },
    })
  }

  const queue = createRecordingCommandQueue()
  try {
    await fn({ db, organizationId, serverId, queue })
  } finally {
    await cleanupOrg(db, organizationId, serverId)
  }
}

test('resolveHostingIngressDesired requires demand or prior observation', () => {
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: true,
      hasHttpIngressDemand: false,
      ingressObserved: false,
    }),
    'absent',
  )
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: true,
      hasHttpIngressDemand: true,
      ingressObserved: false,
    }),
    'present',
  )
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: true,
      hasHttpIngressDemand: false,
      ingressObserved: true,
    }),
    'present',
  )
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: false,
      hasHttpIngressDemand: true,
      ingressObserved: true,
    }),
    'absent',
  )
})

test('runSystemReconcileSweep skips pending hosting-ingress without HTTP demand', async () => {
  await withReconcileFixtures({}, async ({ db, queue }) => {
    // Hierarchy leaves ingress pending / null container_id with no hostings.
    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 0)
    assertEquals(queue.envelopes.length, 0)
  })
})

test('runSystemReconcileSweep enqueues for connected hosting-enabled non-running ingress with HTTP demand', async () => {
  await withReconcileFixtures({ httpIngressDemand: true }, async ({ db, serverId, queue }) => {
    // Hierarchy leaves ingress pending / null container_id — eligible for sweep.
    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 1)
    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.serverId, serverId)
    assertEquals(queue.envelopes[0]?.type, 'system.reconcile')
  })
})

test('runSystemReconcileSweep skips when hosting is disabled', async () => {
  await withReconcileFixtures({ hostingEnabled: false }, async ({ db, queue }) => {
    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 0)
    assertEquals(queue.envelopes.length, 0)
  })
})

test('runSystemReconcileSweep skips steady-state running ingress when not recently reconnected', async () => {
  const staleOnlineAt = new Date(
    Date.now() - SYSTEM_RECONCILE_MIN_INTERVAL_MS - 60_000,
  ).toISOString()
  await withReconcileFixtures(
    { statusChangedAt: staleOnlineAt },
    async ({ db, serverId, queue }) => {
      await db
        .update(container)
        .set({ status: 'running', containerId: 'running-cid' })
        .where(eq(container.serverId, serverId))

      const result = await runSystemReconcileSweep(db, queue)
      assertEquals(result.enqueued, 0)
      assertEquals(queue.envelopes.length, 0)
    },
  )
})

test('runSystemReconcileSweep enqueues for recently reconnected server with running ingress', async () => {
  await withReconcileFixtures({}, async ({ db, serverId, queue }) => {
    // status_changed_at is recent (fixture default = now); inventory still
    // says running from before the offline window — must still reconcile
    // because the ingress was already observed (no HTTP demand required).
    await db
      .update(container)
      .set({ status: 'running', containerId: 'stale-running-cid' })
      .where(eq(container.serverId, serverId))

    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 1)
    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.serverId, serverId)
    assertEquals(queue.envelopes[0]?.type, 'system.reconcile')

    // Throttle: a second sweep within the window must not enqueue again.
    const secondQueue = createRecordingCommandQueue()
    const second = await runSystemReconcileSweep(db, secondQueue)
    assertEquals(second.enqueued, 0)
    assertEquals(secondQueue.envelopes.length, 0)
  })
})

test('runSystemReconcileSweep skips when a recent system.reconcile exists', async () => {
  await withReconcileFixtures({ httpIngressDemand: true }, async ({ db, serverId, queue }) => {
    const first = await enqueueSystemReconcile(db, queue, {
      serverId,
      actorType: 'system',
      actorId: serverId,
    })
    assertEquals(first.ok, true)

    const secondQueue = createRecordingCommandQueue()
    const result = await runSystemReconcileSweep(db, secondQueue)
    assertEquals(result.enqueued, 0)
    assertEquals(secondQueue.envelopes.length, 0)

    // Sanity: throttle window constant is positive.
    assertEquals(SYSTEM_RECONCILE_MIN_INTERVAL_MS > 0, true)
  })
})

test('buildSystemReconcilePayload returns one payload per system environment', async () => {
  await withReconcileFixtures({ selfHost: true, httpIngressDemand: true }, async ({ db, serverId }) => {
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    assertEquals(payloads.length, 2)

    const hostingIngress = payloads.find((p) =>
      p.components.some((c) => c.component === 'hosting-ingress'))
    const selfHost = payloads.find((p) =>
      p.components.some((c) => c.component === 'database'))

    assertEquals(hostingIngress !== undefined, true)
    assertEquals(selfHost !== undefined, true)
    assertEquals(hostingIngress?.environmentId === selfHost?.environmentId, false)

    // hosting-ingress: one component, role ingress, containerName `${serviceId}-in`.
    assertEquals(hostingIngress?.components.length, 1)
    const ingressComponent = hostingIngress?.components[0]
    assertEquals(ingressComponent?.role, 'ingress')
    assertEquals(ingressComponent?.desired, 'present')
    assertEquals(ingressComponent?.containerName, `${ingressComponent?.serviceId}-in`)

    // self-host: three components (database/queue/analytics), role system,
    // containerName = serviceId, always desired 'present'.
    assertEquals(selfHost?.components.length, SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES.length)
    assertEquals(
      selfHost?.components.map((c) => c.component).sort(),
      [...SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES].sort(),
    )
    for (const component of selfHost?.components ?? []) {
      assertEquals(component.role, 'turbopanel')
      assertEquals(component.desired, 'present')
      assertEquals(component.containerName, component.serviceId)
      assertEquals(component.composeServiceName, component.component)
    }
  })
})

test('buildSystemReconcilePayload keeps hosting-ingress absent without demand even when enabled', async () => {
  await withReconcileFixtures({}, async ({ db, serverId }) => {
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    const hostingIngress = payloads.find((p) =>
      p.components.some((c) => c.component === 'hosting-ingress'))
    assertEquals(hostingIngress?.components[0]?.desired, 'absent')
  })
})

test('buildSystemReconcilePayload marks self-host components present even when hosting is disabled', async () => {
  await withReconcileFixtures(
    { hostingEnabled: false, selfHost: true },
    async ({ db, serverId }) => {
      const payloads = await buildSystemReconcilePayload(db, { serverId })
      assertEquals(payloads.length, 2)

      const hostingIngress = payloads.find((p) =>
        p.components.some((c) => c.component === 'hosting-ingress'))
      const selfHost = payloads.find((p) =>
        p.components.some((c) => c.component === 'database'))

      assertEquals(hostingIngress?.components[0]?.desired, 'absent')
      for (const component of selfHost?.components ?? []) {
        assertEquals(component.desired, 'present')
      }
    },
  )
})

test('enqueueSystemReconcile creates one command per system environment when unscoped', async () => {
  await withReconcileFixtures({ selfHost: true }, async ({ db, serverId, queue }) => {
    const result = await enqueueSystemReconcile(db, queue, {
      serverId,
      actorType: 'system',
      actorId: serverId,
    })

    assertEquals(result.ok, true)
    if (!result.ok) return
    assertEquals(result.commandIds.length, 2)
    assertEquals(result.commandId, result.commandIds[0])
    assertEquals(queue.envelopes.length, 2)
    for (const envelope of queue.envelopes) {
      assertEquals(envelope.serverId, serverId)
      assertEquals(envelope.type, 'system.reconcile')
    }
  })
})

test('enqueueSystemReconcile scoped to environmentId enqueues exactly one command', async () => {
  await withReconcileFixtures({ selfHost: true }, async ({ db, serverId, queue }) => {
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    const selfHostEnvironmentId = payloads.find((p) =>
      p.components.some((c) => c.component === 'database'))?.environmentId
    assertEquals(typeof selfHostEnvironmentId, 'string')

    const result = await enqueueSystemReconcile(db, queue, {
      serverId,
      actorType: 'user',
      actorId: serverId,
      environmentId: selfHostEnvironmentId,
    })

    assertEquals(result.ok, true)
    if (!result.ok) return
    assertEquals(result.commandIds.length, 1)
    assertEquals(queue.envelopes.length, 1)
  })
})

test('enqueueSystemReconcileIfConnected skips when the daemon is offline', async () => {
  await withReconcileFixtures(
    { connected: false, selfHost: true },
    async ({ db, serverId, queue }) => {
      const result = await enqueueSystemReconcileIfConnected(db, queue, serverId)
      assertEquals(result, { ok: false, reason: 'not_connected' })
      assertEquals(queue.envelopes.length, 0)
    },
  )
})

test('enqueueSystemReconcileIfConnected enqueues when the daemon is connected', async () => {
  await withReconcileFixtures({ selfHost: true }, async ({ db, serverId, queue }) => {
    const result = await enqueueSystemReconcileIfConnected(db, queue, serverId)
    assertEquals(result.ok, true)
    if (!result.ok) return
    assertEquals(result.commandIds.length > 0, true)
    assertEquals(queue.envelopes.length, result.commandIds.length)
    for (const envelope of queue.envelopes) {
      assertEquals(envelope.serverId, serverId)
      assertEquals(envelope.type, 'system.reconcile')
    }
  })
})

test('runSystemReconcileSweep enqueues for self-host containers missing a Docker id', async () => {
  await withReconcileFixtures({ selfHost: true }, async ({ db, queue }) => {
    // Hierarchy leaves self-host containers pending / null container_id —
    // eligible for sweep alongside the (also pending) hosting-ingress row.
    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 1)
    // A single enqueue reconciles every system environment on the server.
    assertEquals(queue.envelopes.length, 2)
  })
})

test('buildSystemReconcilePayload returns empty when no system hierarchy exists', async () => {
  if (!dbUrl) {
    console.warn('Skipping reconcile empty-payload test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Reconcile Empty Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Reconcile Empty Server',
      isConnected: true,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    assertEquals(payloads, [])
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('enqueueSystemReconcile returns not_provisioned without hierarchy', async () => {
  if (!dbUrl) {
    console.warn('Skipping reconcile not_provisioned test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const queue = createRecordingCommandQueue()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Reconcile Not Provisioned Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Reconcile Not Provisioned Server',
      isConnected: true,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const result = await enqueueSystemReconcile(db, queue, {
      serverId,
      actorType: 'user',
      actorId: serverId,
    })
    assertEquals(result, { ok: false, reason: 'not_provisioned' })
    assertEquals(queue.envelopes.length, 0)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('enqueueSystemReconcile passes restart action into the command payload', async () => {
  await withReconcileFixtures({}, async ({ db, serverId, queue }) => {
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    const environmentId = payloads[0]?.environmentId
    assertEquals(typeof environmentId, 'string')

    const result = await enqueueSystemReconcile(db, queue, {
      serverId,
      actorType: 'user',
      actorId: serverId,
      environmentId,
      action: 'restart',
    })

    assertEquals(result.ok, true)
    if (!result.ok) return
    assertEquals(result.commandIds.length, 1)

    const [record] = await db
      .select({ payload: dispatch.payload })
      .from(dispatch)
      .where(eq(dispatch.commandId, result.commandId))
      .limit(1)
    const payload = record?.payload as { action?: string } | null
    assertEquals(payload?.action, 'restart')
  })
})

/**
 * Consumer-only server: a tenant service on this host is bound to a managed
 * cluster whose members all live elsewhere, so no local `replica` row exists.
 * Only the managed-ingress (ProxySQL) hierarchy is provisioned, so any sweep
 * enqueue must come from the managed-ingress candidate branch.
 */
async function withConsumerOnlyManagedFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    queue: ReturnType<typeof createRecordingCommandQueue>
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      'Skipping consumer-only managed-ingress tests: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Managed Consumer Sweep Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Managed Consumer Sweep Server',
      isConnected: true,
      statusChangedAt: now,
      // Hosting off so the hosting-ingress branch can never be the reason a
      // candidate row appears.
      options: { hosting: { enabled: false } },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  await ensureManagedIngressHierarchy(db, { organizationId, serverId })

  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'Tenant Workspace' })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws!.id,
      name: 'Tenant Project',
      metadata: { type: 'docker-compose' },
    })
    .returning({ id: project.id })
  // Consumer environment pinned to this server; the cluster lives elsewhere.
  const [consumerEnv] = await db
    .insert(environment)
    .values({ projectId: proj!.id, serverId, name: 'Production' })
    .returning({ id: environment.id })
  const [consumerSvc] = await db
    .insert(service)
    .values({
      environmentId: consumerEnv!.id,
      name: 'app',
      composeServiceName: 'app',
    })
    .returning({ id: service.id })

  // Managed cluster with no `replica` row on this server (no members at all).
  const [clusterEnv] = await db
    .insert(environment)
    .values({ projectId: proj!.id, serverId: null, name: 'Managed' })
    .returning({ id: environment.id })
  const [cluster] = await db
    .insert(managed)
    .values({
      environmentId: clusterEnv!.id,
      serverId: null,
      name: 'app-db',
      engine: 'postgres',
      status: 'ready',
    })
    .returning({ id: managed.id })
  const [account] = await db
    .insert(principal)
    .values({
      kind: 'database',
      provider: 'postgres',
      username: 'appuser',
      appliedUsername: 'appuser',
      managedId: cluster!.id,
    })
    .returning({ id: principal.id })
  const [bound] = await db
    .insert(binding)
    .values({
      principalId: account!.id,
      serviceId: consumerSvc!.id,
      databaseName: 'appdb',
    })
    .returning({ id: binding.id })

  const queue = createRecordingCommandQueue()
  try {
    await fn({ db, serverId, queue })
  } finally {
    await db.delete(binding).where(eq(binding.id, bound!.id))
    await db.delete(principal).where(eq(principal.id, account!.id))
    await db.delete(managed).where(eq(managed.id, cluster!.id))
    await cleanupOrg(db, organizationId, serverId)
  }
}

test('runSystemReconcileSweep enqueues for a consumer-only managed-ingress server', async () => {
  await withConsumerOnlyManagedFixtures(async ({ db, serverId, queue }) => {
    // ProxySQL row is still pending / has no Docker id — post-boot self-heal.
    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 1)
    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.serverId, serverId)
    assertEquals(queue.envelopes[0]?.type, 'system.reconcile')

    // The payload for that server wants ProxySQL up on bound consumers alone.
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    assertEquals(payloads.length, 1)
    assertEquals(payloads[0]?.components[0]?.desired, 'present')

    // Throttle: a second sweep inside the window must not enqueue again.
    const secondQueue = createRecordingCommandQueue()
    const second = await runSystemReconcileSweep(db, secondQueue)
    assertEquals(second.enqueued, 0)
    assertEquals(secondQueue.envelopes.length, 0)
  })
})

test('runSystemReconcileSweep re-observes a consumer-only ProxySQL after reconnect', async () => {
  await withConsumerOnlyManagedFixtures(async ({ db, serverId, queue }) => {
    // Inventory still says running from before the offline window; only the
    // recent `status_changed_at` (fixture default = now) makes it a candidate.
    await db
      .update(container)
      .set({ status: 'running', containerId: 'stale-proxysql-cid' })
      .where(eq(container.serverId, serverId))

    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 1)
    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.serverId, serverId)
  })
})

test('runSystemReconcileSweep skips a steady-state consumer-only ProxySQL', async () => {
  await withConsumerOnlyManagedFixtures(async ({ db, serverId, queue }) => {
    const staleOnlineAt = new Date(
      Date.now() - SYSTEM_RECONCILE_MIN_INTERVAL_MS - 60_000,
    ).toISOString()
    await db
      .update(server)
      .set({ statusChangedAt: staleOnlineAt })
      .where(eq(server.id, serverId))
    await db
      .update(container)
      .set({ status: 'running', containerId: 'running-proxysql-cid' })
      .where(eq(container.serverId, serverId))

    const result = await runSystemReconcileSweep(db, queue)
    assertEquals(result.enqueued, 0)
    assertEquals(queue.envelopes.length, 0)
  })
})
