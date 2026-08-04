import { assertEquals } from 'jsr:@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  command,
  container,
  environment,
  organization,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import {
  ensureSelfHostSystemHierarchy,
  ensureSystemHierarchy,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
} from './hierarchy.ts'
import {
  buildSystemReconcilePayload,
  enqueueSystemReconcile,
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
    enqueue: async (envelope) => {
      envelopes.push(envelope)
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
    .values({ displayName: 'System Reconcile Sweep Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const hostingEnabled = options.hostingEnabled ?? true
  const connected = options.connected ?? true
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'System Reconcile Sweep Server',
      connected,
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

  const queue = createRecordingCommandQueue()
  try {
    await fn({ db, organizationId, serverId, queue })
  } finally {
    await cleanupOrg(db, organizationId, serverId)
  }
}

test('runSystemReconcileSweep enqueues for connected hosting-enabled non-running ingress', async () => {
  await withReconcileFixtures({}, async ({ db, serverId, queue }) => {
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
    // says running from before the offline window — must still reconcile.
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
  await withReconcileFixtures({}, async ({ db, serverId, queue }) => {
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
  await withReconcileFixtures({ selfHost: true }, async ({ db, serverId }) => {
    const payloads = await buildSystemReconcilePayload(db, { serverId })
    assertEquals(payloads.length, 2)

    const hostingIngress = payloads.find((p) =>
      p.components.some((c) => c.component === 'hosting-ingress'))
    const selfHost = payloads.find((p) =>
      p.components.some((c) => c.component === 'database'))

    assertEquals(hostingIngress !== undefined, true)
    assertEquals(selfHost !== undefined, true)
    assertEquals(hostingIngress?.environmentId === selfHost?.environmentId, false)

    // hosting-ingress: one component, role ingress, containerName `${serviceId}-ingress`.
    assertEquals(hostingIngress?.components.length, 1)
    const ingressComponent = hostingIngress?.components[0]
    assertEquals(ingressComponent?.role, 'ingress')
    assertEquals(ingressComponent?.desired, 'present')
    assertEquals(ingressComponent?.containerName, `${ingressComponent?.serviceId}-ingress`)

    // self-host: three components (database/queue/analytics), role app,
    // containerName = serviceId, always desired 'present'.
    assertEquals(selfHost?.components.length, SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES.length)
    assertEquals(
      selfHost?.components.map((c) => c.component).sort(),
      [...SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES].sort(),
    )
    for (const component of selfHost?.components ?? []) {
      assertEquals(component.role, 'app')
      assertEquals(component.desired, 'present')
      assertEquals(component.containerName, component.serviceId)
      assertEquals(component.composeServiceName, component.component)
    }
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
