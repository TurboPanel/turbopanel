import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { createNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
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
import { ensureSystemHierarchy } from './hierarchy.ts'
import { systemComponentOperations } from './operate.ts'

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

async function withOperateFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
    environmentId: string
    actorId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping system operate tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'System Operate Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'System Operate Server',
      isConnected: true,
      statusChangedAt: now,
      options: { hosting: { enabled: true } },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id
  const actorId = crypto.randomUUID()

  const hierarchy = await ensureSystemHierarchy(db, { organizationId, serverId })

  try {
    await fn({
      db,
      organizationId,
      serverId,
      environmentId: hierarchy.environmentId,
      actorId,
    })
  } finally {
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
}

test('restart enqueues a scoped system.reconcile restart command', async () => {
  await withOperateFixtures(async ({ db, serverId, environmentId, actorId }) => {
    const queue = createRecordingCommandQueue()
    const result = await systemComponentOperations.restart({
      db,
      commandQueue: queue,
      serverId,
      environmentId,
      component: 'hosting-ingress',
      actorId,
    })

    assertEquals(result.ok, true)
    if (!result.ok) return
    assertEquals(result.serverId, serverId)
    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.type, 'system.reconcile')
    assertEquals(queue.envelopes[0]?.serverId, serverId)
  })
})

test('restart returns not_provisioned when the environment is unknown', async () => {
  await withOperateFixtures(async ({ db, serverId, actorId }) => {
    const queue = createRecordingCommandQueue()
    const result = await systemComponentOperations.restart({
      db,
      commandQueue: queue,
      serverId,
      environmentId: crypto.randomUUID(),
      component: 'hosting-ingress',
      actorId,
    })

    assertEquals(result, { ok: false, reason: 'not_provisioned' })
    assertEquals(queue.envelopes.length, 0)
  })
})

test('restart maps enqueue failures to transport_unavailable', async () => {
  await withOperateFixtures(async ({ db, serverId, environmentId, actorId }) => {
    const result = await systemComponentOperations.restart({
      db,
      commandQueue: createNoopCommandQueue(),
      serverId,
      environmentId,
      component: 'hosting-ingress',
      actorId,
    })

    assertEquals(result, { ok: false, reason: 'transport_unavailable' })
  })
})
