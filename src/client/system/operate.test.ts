import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { createNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { command, organization, server } from '../../lib/db/schema.ts'
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
    enqueue: async (envelope) => {
      envelopes.push(envelope)
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
    .values({ displayName: 'System Operate Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'System Operate Server',
      connected: true,
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
