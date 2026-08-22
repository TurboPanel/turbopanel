import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import { createNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  getCommandRecord,
} from '../../lib/db/command-records.ts'
import { command, organization, server } from '../../lib/db/schema.ts'
import {
  assertDispatchInfrastructure,
  enqueueCommandOrCompensate,
} from './command-dispatch.ts'

const dbUrl = getDatabaseUrl()

function mockContext(bindings: Record<string, unknown> = {}): Context {
  const store = new Map<string, unknown>(Object.entries(bindings))
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
    get(key: string) {
      return store.get(key)
    },
    set(key: string, value: unknown) {
      store.set(key, value)
    },
  } as unknown as Context
}

function createRecordingQueue(
  behavior?: { enqueue?: () => Promise<void> },
): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: behavior?.enqueue ?? (async (envelope) => {
      envelopes.push(envelope)
    }),
  }
}

it('assertDispatchInfrastructure returns 503 when registry is missing', async () => {
  const queue = createRecordingQueue()
  const response = assertDispatchInfrastructure(mockContext({ commandQueue: queue }))
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 503)
    assertEquals(await response.json(), { error: 'Daemon cell registry unavailable' })
  }
})

it('assertDispatchInfrastructure returns 503 when command queue is noop', async () => {
  const response = assertDispatchInfrastructure(mockContext({
    daemonCellRegistry: {},
    commandQueue: createNoopCommandQueue(),
  }))
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 503)
    assertEquals(await response.json(), { error: 'Command queue unavailable' })
  }
})

it('assertDispatchInfrastructure returns the queue when dispatch infra is present', () => {
  const queue = createRecordingQueue()
  const registry = { getCell: () => ({}) }
  const result = assertDispatchInfrastructure(mockContext({
    daemonCellRegistry: registry,
    commandQueue: queue,
  }))
  assertEquals(result, queue)
})

it('assertDispatchInfrastructure returns 503 when command queue binding is missing', async () => {
  const response = assertDispatchInfrastructure(mockContext({
    daemonCellRegistry: {},
  }))
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 503)
    assertEquals(await response.json(), { error: 'Command queue unavailable' })
  }
})

it('enqueueCommandOrCompensate returns null when enqueue succeeds', async () => {
  const queue = createRecordingQueue()
  const record = {
    id: 'cmd-1',
    queuedAt: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  } as Awaited<ReturnType<typeof createCommandRecord>>
  const response = await enqueueCommandOrCompensate(
    {} as never,
    queue,
    record,
    {
      commandId: record.id,
      serverId: 'server-1',
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    },
    mockContext(),
  )
  assertEquals(response, null)
  assertEquals(queue.envelopes.length, 1)
  assertEquals(queue.envelopes[0]?.commandId, 'cmd-1')
})

it('enqueueCommandOrCompensate marks the command failed when enqueue throws', async () => {
  if (!dbUrl) {
    console.warn('Skipping enqueueCommandOrCompensate test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Command Dispatch Org' })
    .returning({ id: organization.id })
  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId: insertedOrg!.id,
      name: 'Dispatch Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const record = await createCommandRecord(db, {
    serverId,
    actorType: 'user',
    actorId: crypto.randomUUID(),
    type: 'daemon.ping',
    payload: {},
  })

  const queue = createRecordingQueue({
    enqueue: async () => {
      throw new Error('broker down')
    },
  })

  const response = await enqueueCommandOrCompensate(
    db,
    queue,
    record,
    {
      commandId: record.id,
      serverId,
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    },
    mockContext(),
  )

  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 503)
    assertEquals(await response.json(), { error: 'Command queue unavailable' })
  }

  const updated = await getCommandRecord(db, record.id)
  assertEquals(updated?.status, 'failed')
  assertEquals(updated?.error, 'Command queue unavailable')

  await db.delete(command).where(eq(command.serverId, serverId))
  await db.delete(server).where(eq(server.id, serverId))
  await db.delete(organization).where(eq(organization.id, insertedOrg!.id))
})
