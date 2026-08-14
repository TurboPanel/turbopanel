/**
 * Host-free coverage for task records (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { task } from './schema.ts'
import { listEnvironmentTasks, replaceEnvironmentTasks, serializeTask } from './task-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    orderBy: () => thenableRows(rows),
    returning: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

const envId = '00000000-0000-4000-8000-000000000001'
const serviceA = '00000000-0000-4000-8000-0000000000aa'
const serviceB = '00000000-0000-4000-8000-0000000000bb'
const serverA = '00000000-0000-4000-8000-00000000000a'
const serverB = '00000000-0000-4000-8000-00000000000b'

type ExistingTask = {
  id: string
  serviceId: string
  slot: number
}

function createTaskDb(opts?: { existing?: ExistingTask[] }): Db & {
  inserts: Array<Record<string, unknown>>
  conflictSets: Array<Record<string, unknown>>
  deletedIds: unknown[]
} {
  const inserts: Array<Record<string, unknown>> = []
  const conflictSets: Array<Record<string, unknown>> = []
  const deletedIds: unknown[] = []
  const existing = opts?.existing ?? []

  const db = {
    inserts,
    conflictSets,
    deletedIds,
    select: () => ({
      from: (table: unknown) => {
        if (table !== task) return { where: () => thenableRows([]) }
        return {
          where: () => thenableRows(existing),
        }
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values)
        return {
          onConflictDoUpdate: (conflict: { set: Record<string, unknown> }) => {
            conflictSets.push(conflict.set)
            return Promise.resolve()
          },
        }
      },
    }),
    delete: () => ({
      where: (clause: unknown) => {
        deletedIds.push(clause)
        return thenableRows([])
      },
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
  }

  return db as unknown as Db & {
    inserts: Array<Record<string, unknown>>
    conflictSets: Array<Record<string, unknown>>
    deletedIds: unknown[]
  }
}

test('sticky re-plan leaves server_id untouched and only bumps generation', async () => {
  const db = createTaskDb({
    existing: [{ id: 'task-1', serviceId: serviceA, slot: 0 }],
  })

  await replaceEnvironmentTasks(db, {
    environmentId: envId,
    generation: 7,
    tasks: [{
      serviceId: serviceA,
      serverId: serverA,
      slot: 0,
      desiredState: 'running',
    }],
  })

  assertEquals(db.conflictSets.length, 1)
  const set = db.conflictSets[0]
  if (!set) throw new TypeError('expected onConflictDoUpdate set')
  assertEquals(set.serverId, serverA)
  assertEquals(set.generation, 7)
  assertEquals(set.desiredState, 'running')
  assertEquals(db.deletedIds.length, 0)
})

test('replaceEnvironmentTasks deletes removed (serviceId, slot) pairs', async () => {
  const db = createTaskDb({
    existing: [
      { id: 'keep', serviceId: serviceA, slot: 0 },
      { id: 'drop', serviceId: serviceA, slot: 1 },
    ],
  })

  await replaceEnvironmentTasks(db, {
    environmentId: envId,
    generation: 2,
    tasks: [{ serviceId: serviceA, serverId: serverA, slot: 0 }],
  })

  assertEquals(db.deletedIds.length, 1)
})

test('replaceEnvironmentTasks writes caller serverId when the planner moves a slot', async () => {
  const db = createTaskDb({
    existing: [{ id: 'task-1', serviceId: serviceA, slot: 0 }],
  })

  await replaceEnvironmentTasks(db, {
    environmentId: envId,
    generation: 3,
    tasks: [{ serviceId: serviceA, serverId: serverB, slot: 0 }],
  })

  const set = db.conflictSets[0]
  if (!set) throw new TypeError('expected onConflictDoUpdate set')
  assertEquals(set.serverId, serverB)
  assertEquals(set.generation, 3)
})

test('listEnvironmentTasks orders by serviceId then slot', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          thenableRows([
            {
              id: '2',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
              metadata: null,
              options: null,
              environmentId: envId,
              serviceId: serviceB,
              serverId: serverA,
              slot: 0,
              generation: 1,
              desiredState: 'running',
            },
            {
              id: '1',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
              metadata: null,
              options: null,
              environmentId: envId,
              serviceId: serviceA,
              serverId: serverA,
              slot: 1,
              generation: 1,
              desiredState: 'running',
            },
            {
              id: '0',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
              metadata: null,
              options: null,
              environmentId: envId,
              serviceId: serviceA,
              serverId: serverA,
              slot: 0,
              generation: 1,
              desiredState: 'running',
            },
          ]),
      }),
    }),
  } as unknown as Db

  const listed = await listEnvironmentTasks(db, envId)
  assertEquals(
    listed.map((row) => `${row.serviceId}:${String(row.slot)}`),
    [`${serviceA}:0`, `${serviceA}:1`, `${serviceB}:0`],
  )
})

test('serializeTask defaults unknown desiredState to running', () => {
  const record = serializeTask({
    id: 't',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    metadata: null,
    options: null,
    environmentId: envId,
    serviceId: serviceA,
    serverId: serverA,
    slot: 0,
    generation: 0,
    desiredState: 'nope',
    address: null,
  })
  assertEquals(record.desiredState, 'running')
  assertEquals(record.slot, 0)
  assertEquals(record.address, null)
})

test('replaceEnvironmentTasks writes and patches task.address including explicit null', async () => {
  const db = createTaskDb({
    existing: [{ id: 'task-1', serviceId: serviceA, slot: 0 }],
  })

  await replaceEnvironmentTasks(db, {
    environmentId: envId,
    generation: 4,
    tasks: [{
      serviceId: serviceA,
      serverId: serverA,
      slot: 0,
      address: '203.0.113.10',
    }],
  })

  assertEquals(db.inserts[0]?.address, '203.0.113.10')
  assertEquals(db.conflictSets[0]?.address, '203.0.113.10')

  await replaceEnvironmentTasks(db, {
    environmentId: envId,
    generation: 5,
    tasks: [{
      serviceId: serviceA,
      serverId: serverA,
      slot: 0,
      address: null,
    }],
  })

  assertEquals(db.inserts[1]?.address, null)
  assertEquals(db.conflictSets[1]?.address, null)
})

test('serializeTask and listEnvironmentTasks surface a persisted address', async () => {
  const record = serializeTask({
    id: 't',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    metadata: null,
    options: null,
    environmentId: envId,
    serviceId: serviceA,
    serverId: serverA,
    slot: 0,
    generation: 1,
    desiredState: 'running',
    address: '203.0.113.10',
  })
  assertEquals(record.address, '203.0.113.10')

  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          thenableRows([{
            id: '0',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z',
            metadata: null,
            options: null,
            environmentId: envId,
            serviceId: serviceA,
            serverId: serverA,
            slot: 0,
            generation: 1,
            desiredState: 'running',
            address: '203.0.113.10',
          }]),
      }),
    }),
  } as unknown as Db

  const listed = await listEnvironmentTasks(db, envId)
  assertEquals(listed[0]?.address, '203.0.113.10')
})
