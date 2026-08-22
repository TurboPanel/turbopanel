/**
 * Host-free coverage for deployment target records (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { deployment } from './schema.ts'
import {
  listEnvironmentDeploymentTargets,
  markDeploymentApplied,
  markDeploymentFailed,
  pruneDrainedDeployments,
  serializeDeploymentTarget,
  upsertDeploymentTargets,
  type DeploymentOutcome,
  type DeploymentTargetRecord,
} from './deployment-records.ts'

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
const serverA = '00000000-0000-4000-8000-00000000000a'
const serverB = '00000000-0000-4000-8000-00000000000b'

const baseRow = {
  id: '00000000-0000-4000-8000-000000000010',
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:01.000Z',
  metadata: null as unknown,
  options: null as unknown,
  environmentId: envId,
  serverId: serverA,
  desiredGeneration: 1,
  appliedGeneration: 1,
  desiredHash: 'abc',
  status: 'applied',
  lastCommandId: null as string | null,
  finishedAt: null as string | null,
  durationMs: null as number | null,
  outcome: null as DeploymentOutcome | null,
}

function createDeploymentDb(opts?: {
  rows?: Array<typeof baseRow>
  returning?: Array<typeof baseRow>
}): Db & {
  inserts: Array<Record<string, unknown>>
  conflictSets: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
  deletes: number
} {
  const inserts: Array<Record<string, unknown>> = []
  const conflictSets: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  let deletes = 0
  const rows = opts?.rows ?? []

  const db = {
    inserts,
    conflictSets,
    updates,
    get deletes() {
      return deletes
    },
    select: () => ({
      from: (table: unknown) => {
        if (table !== deployment) return { where: () => thenableRows([]) }
        return {
          where: () => thenableRows(rows),
        }
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const list = Array.isArray(values) ? values : [values]
        for (const row of list) inserts.push(row)
        return {
          onConflictDoUpdate: (conflict: { set: Record<string, unknown> }) => {
            conflictSets.push(conflict.set)
            return Promise.resolve()
          },
        }
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return {
          where: () => thenableRows(opts?.returning ?? [{ ...baseRow, ...patch }]),
        }
      },
    }),
    delete: () => {
      deletes += 1
      return {
        where: () => thenableRows([]),
      }
    },
  }

  return db as unknown as Db & {
    inserts: Array<Record<string, unknown>>
    conflictSets: Array<Record<string, unknown>>
    updates: Array<Record<string, unknown>>
    deletes: number
  }
}

test('upsertDeploymentTargets never writes applied_generation', async () => {
  const db = createDeploymentDb()
  await upsertDeploymentTargets(db, {
    environmentId: envId,
    targets: [
      { serverId: serverA, desiredGeneration: 3, desiredHash: 'deadbeef', status: 'pending' },
    ],
  })

  assertEquals(db.inserts.length, 1)
  const inserted = db.inserts[0]
  if (!inserted) throw new TypeError('expected insert values')
  assertEquals('appliedGeneration' in inserted, false)
  assertEquals(inserted.desiredGeneration, 3)
  assertEquals(inserted.desiredHash, 'deadbeef')
  assertEquals(inserted.status, 'pending')

  assertEquals(db.conflictSets.length, 1)
  const conflict = db.conflictSets[0]
  if (!conflict) throw new TypeError('expected onConflictDoUpdate set')
  assertEquals('appliedGeneration' in conflict, false)
  assertEquals('desiredGeneration' in conflict, true)
  assertEquals('desiredHash' in conflict, true)
  assertEquals('status' in conflict, true)
  assertEquals('updatedAt' in conflict, true)
})

test('markDeploymentFailed merges metadata.error and updates one row', async () => {
  const db = createDeploymentDb({
    returning: [{
      ...baseRow,
      status: 'failed',
      metadata: { error: 'compose rejected' },
    }],
  })

  const record = await markDeploymentFailed(db, {
    environmentId: envId,
    serverId: serverA,
    error: 'compose rejected',
    commandId: '00000000-0000-4000-8000-000000000099',
  })

  assertEquals(db.updates.length, 1)
  const patch = db.updates[0]
  if (!patch) throw new TypeError('expected update patch')
  assertEquals(patch.status, 'failed')
  assertEquals(patch.lastCommandId, '00000000-0000-4000-8000-000000000099')
  assertEquals(patch.metadata === undefined, false)
  assertEquals(record?.status, 'failed')
})

test('markDeploymentApplied clears metadata.error and sets applied_generation', async () => {
  const db = createDeploymentDb({
    returning: [{
      ...baseRow,
      status: 'applied',
      appliedGeneration: 4,
      metadata: { error: null },
    }],
  })

  const record = await markDeploymentApplied(db, {
    environmentId: envId,
    serverId: serverA,
    generation: 4,
  })

  assertEquals(db.updates.length, 1)
  const patch = db.updates[0]
  if (!patch) throw new TypeError('expected update patch')
  assertEquals(patch.status, 'applied')
  assertEquals(patch.appliedGeneration, 4)
  assertEquals(record?.appliedGeneration, 4)
})

test('pruneDrainedDeployments deletes named rows when serverIds is set', async () => {
  const db = createDeploymentDb()
  await pruneDrainedDeployments(db, {
    environmentId: envId,
    serverIds: [serverA, serverB],
  })
  assertEquals(db.deletes, 1)
})

test('pruneDrainedDeployments skips delete when serverIds is empty', async () => {
  const db = createDeploymentDb()
  await pruneDrainedDeployments(db, {
    environmentId: envId,
    serverIds: [],
  })
  assertEquals(db.deletes, 0)
})

test('pruneDrainedDeployments deletes draining rows when serverIds is omitted', async () => {
  const db = createDeploymentDb()
  await pruneDrainedDeployments(db, { environmentId: envId })
  assertEquals(db.deletes, 1)
})

test('listEnvironmentDeploymentTargets sorts by serverId then id', async () => {
  const db = createDeploymentDb({
    rows: [
      { ...baseRow, id: 'z', serverId: serverB },
      { ...baseRow, id: 'a', serverId: serverA },
      { ...baseRow, id: 'b', serverId: serverA },
    ],
  })
  const listed = await listEnvironmentDeploymentTargets(db, envId)
  assertEquals(listed.map((row) => `${row.serverId}:${row.id}`), [
    `${serverA}:a`,
    `${serverA}:b`,
    `${serverB}:z`,
  ])
})

test('serializeDeploymentTarget flattens nullable columns', () => {
  const record: DeploymentTargetRecord = serializeDeploymentTarget({
    ...baseRow,
    appliedGeneration: null,
    desiredHash: null,
    lastCommandId: null,
    metadata: null,
    options: null,
  })
  assertEquals(record.appliedGeneration, null)
  assertEquals(record.desiredHash, null)
  assertEquals(record.lastCommandId, null)
  assertEquals(record.status, 'applied')
})
