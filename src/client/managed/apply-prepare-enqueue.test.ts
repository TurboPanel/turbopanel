import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { managed } from '../../lib/db/schema.ts'
import {
  enqueueManagedApply,
  enqueueManagedDestroy,
  enqueueManagedLifecycle,
  enqueueTypedCommand,
} from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

type CommandRow = {
  id: string
  serverId: string
  actorType: string
  actorId: string
  name: string
  status: string
  attempts: number
  payload: unknown
  metadata: Record<string, unknown>
  result: unknown
  createdAt: string
  updatedAt: string
}

function createEnqueueDb(): {
  db: Db
  managedUpdates: Array<Record<string, unknown>>
  commandRows: CommandRow[]
  commandUpdates: Array<{ id: string; patch: Record<string, unknown> }>
} {
  const managedUpdates: Array<Record<string, unknown>> = []
  const commandRows: CommandRow[] = []
  const commandUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []

  const db = {
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (table === managed) {
            managedUpdates.push(patch)
            return Promise.resolve(undefined)
          }

          const id = commandRows[0]?.id ?? 'cmd-1'
          commandUpdates.push({ id, patch })
          const row = commandRows.find((entry) => entry.id === id)
          if (row) {
            Object.assign(row, patch)
            if (patch.metadata !== undefined) {
              row.metadata = {
                ...row.metadata,
                ...(patch.metadata as Record<string, unknown>),
              }
            }
          }

          return {
            returning: () => Promise.resolve(row ? [row] : []),
          }
        },
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: () => {
          const created: CommandRow = {
            id: 'cmd-00000000-0000-4000-8000-000000000099',
            serverId: row.serverId as string,
            actorType: row.actorType as string,
            actorId: row.actorId as string,
            name: row.name as string,
            status: 'queued',
            attempts: 0,
            payload: row.payload,
            metadata: row.metadata as Record<string, unknown>,
            result: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }
          commandRows.push(created)
          return Promise.resolve([created])
        },
      }),
    }),
  } as unknown as Db

  return { db, managedUpdates, commandRows, commandUpdates }
}

function recordingQueue(fail = false): CommandQueue {
  let enqueued = 0
  return {
    enqueue: async () => {
      enqueued += 1
      if (fail) {
        throw new Error('Command queue unavailable')
      }
    },
    get enqueueCount() {
      return enqueued
    },
  } as CommandQueue & { enqueueCount: number }
}

test('enqueueTypedCommand queues a command and returns ids', async () => {
  const c = mockContext()
  const { db, managedUpdates } = createEnqueueDb()
  const queue = recordingQueue()

  const result = await enqueueTypedCommand(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    type: 'managed.backup',
    payload: { managedId: 'managed-1', action: 'create' },
    expiresAtMs: 60_000,
  })

  if (result instanceof Response) {
    throw new TypeError('expected queued response')
  }
  assertEquals(result.ok, true)
  assertEquals(result.status, 'queued')
  assertEquals(result.serverId, 'server-1')
  assertEquals(result.commandId, 'cmd-00000000-0000-4000-8000-000000000099')
  assertEquals(managedUpdates.length, 0)
  assertEquals((queue as CommandQueue & { enqueueCount: number }).enqueueCount, 1)
})

test('enqueueTypedCommand flips managed.status to applying when setApplying is true', async () => {
  const c = mockContext()
  const { db, managedUpdates } = createEnqueueDb()
  const queue = recordingQueue()

  await enqueueTypedCommand(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    type: 'managed.restore',
    payload: { managedId: 'managed-1' },
    expiresAtMs: 60_000,
    managedId: 'managed-1',
    setApplying: true,
  })

  assertEquals(managedUpdates.length, 1)
  assertEquals(managedUpdates[0]?.status, 'applying')
})

test('enqueueTypedCommand returns 503 and marks failed when the queue is unavailable', async () => {
  const c = mockContext()
  const { db, managedUpdates, commandUpdates } = createEnqueueDb()
  const queue = recordingQueue(true)

  const result = await enqueueTypedCommand(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    type: 'managed.apply',
    payload: { managedId: 'managed-1' },
    expiresAtMs: 60_000,
    managedId: 'managed-1',
    setApplying: true,
  })

  if (!(result instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(result.status, 503)
  assertEquals(await result.json(), { error: 'Command queue unavailable' })
  assertEquals(managedUpdates.length, 2)
  assertEquals(managedUpdates[0]?.status, 'applying')
  assertEquals(managedUpdates[1]?.status, 'failed')
  assertEquals(commandUpdates.some((entry) => entry.patch.status === 'failed'), true)
})

test('enqueueManagedApply delegates to managed.apply with setApplying', async () => {
  const c = mockContext()
  const { db, managedUpdates } = createEnqueueDb()
  const queue = recordingQueue()

  const result = await enqueueManagedApply(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    managedId: 'managed-1',
    payload: { managedId: 'managed-1', engine: 'postgres' } as never,
  })

  if (result instanceof Response) {
    throw new TypeError('expected queued response')
  }
  assertEquals(result.commandId, 'cmd-00000000-0000-4000-8000-000000000099')
  assertEquals(managedUpdates[0]?.status, 'applying')
})

test('enqueueManagedLifecycle and enqueueManagedDestroy enqueue without setApplying', async () => {
  const c = mockContext()
  const { db, managedUpdates } = createEnqueueDb()
  const queue = recordingQueue()

  const lifecycle = await enqueueManagedLifecycle(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    managedId: 'managed-1',
    action: 'restart',
  })
  if (lifecycle instanceof Response) {
    throw new TypeError('expected lifecycle enqueue response')
  }
  assertEquals(lifecycle.status, 'queued')

  const destroy = await enqueueManagedDestroy(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    managedId: 'managed-1',
    removeVolumes: true,
    deleteAfterDestroy: true,
  })
  if (destroy instanceof Response) {
    throw new TypeError('expected destroy enqueue response')
  }
  assertEquals(destroy.status, 'queued')
  assertEquals(managedUpdates.length, 0)
})
