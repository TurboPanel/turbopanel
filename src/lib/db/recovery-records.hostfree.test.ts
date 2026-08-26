/**
 * Host-free coverage for managed HA recovery journal records (no Postgres).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { recovery } from './schema.ts'
import {
  findInFlightRecovery,
  findLatestRecovery,
  findRecoveryById,
  insertRecovery,
  updateRecovery,
} from './recovery-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const managedId = '00000000-0000-4000-8000-000000000001'
const recoveryId = '00000000-0000-4000-8000-000000000010'
const sourceMemberId = '00000000-0000-4000-8000-000000000020'
const targetMemberId = '00000000-0000-4000-8000-000000000021'

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

type RecoveryRow = {
  id: string
  createdAt: string
  updatedAt: string
  metadata: unknown
  options: unknown
  managedId: string
  kind: string
  sourcePrimaryMemberId: string
  targetMemberId: string | null
  state: string
  startedAt: string
  completedAt: string | null
}

function baseRow(overrides: Partial<RecoveryRow> = {}): RecoveryRow {
  return {
    id: recoveryId,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:01.000Z',
    metadata: { fenced: true },
    options: null,
    managedId,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: sourceMemberId,
    targetMemberId,
    state: 'promoting',
    startedAt: '2020-01-01T00:00:02.000Z',
    completedAt: null,
    ...overrides,
  }
}

function createRecoveryDb(opts?: {
  selectQueues?: unknown[][]
  insertReturning?: RecoveryRow[]
  updateReturning?: RecoveryRow[]
}): Db & {
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
} {
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const selectQueues = [...(opts?.selectQueues ?? [])]

  const db = {
    inserts,
    updates,
    select: () => ({
      from: (table: unknown) => {
        if (table !== recovery) return { where: () => thenableRows([]) }
        const rows = selectQueues.shift() ?? []
        return {
          where: () => thenableRows(rows),
        }
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values)
        return {
          returning: () =>
            Promise.resolve(
              opts?.insertReturning ?? [{
                ...baseRow(),
                ...values,
                id: recoveryId,
              }],
            ),
        }
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return {
          where: () =>
            thenableRows(
              opts?.updateReturning ?? [{ ...baseRow(), ...patch }],
            ),
        }
      },
    }),
  }

  return db as unknown as Db & {
    inserts: Array<Record<string, unknown>>
    updates: Array<Record<string, unknown>>
  }
}

test('findRecoveryById serializes a valid row and drops invalid kinds', async () => {
  const valid = await findRecoveryById(
    createRecoveryDb({ selectQueues: [[baseRow()]] }),
    recoveryId,
  )
  if (!valid) throw new TypeError('expected a recovery record')
  assertEquals(valid.id, recoveryId)
  assertEquals(valid.kind, 'automatic-failover')
  assertEquals(valid.metadata, { fenced: true })

  const invalid = await findRecoveryById(
    createRecoveryDb({ selectQueues: [[baseRow({ kind: 'not-a-kind' })]] }),
    recoveryId,
  )
  assertEquals(invalid, null)

  const missing = await findRecoveryById(
    createRecoveryDb({ selectQueues: [[]] }),
    recoveryId,
  )
  assertEquals(missing, null)
})

test('findInFlightRecovery returns the newest non-terminal row', async () => {
  const inflight = await findInFlightRecovery(
    createRecoveryDb({
      selectQueues: [[baseRow({ state: 'fencing', startedAt: '2020-01-02T00:00:00.000Z' })]],
    }),
    managedId,
  )
  if (!inflight) throw new TypeError('expected an in-flight recovery')
  assertEquals(inflight.state, 'fencing')

  const none = await findInFlightRecovery(
    createRecoveryDb({ selectQueues: [[]] }),
    managedId,
  )
  assertEquals(none, null)
})

test('findLatestRecovery prefers in-flight over terminal history', async () => {
  const inflight = await findLatestRecovery(
    createRecoveryDb({
      selectQueues: [[baseRow({ state: 'detecting' })]],
    }),
    managedId,
  )
  if (!inflight) throw new TypeError('expected an in-flight recovery')
  assertEquals(inflight.state, 'detecting')

  const terminal = await findLatestRecovery(
    createRecoveryDb({
      selectQueues: [
        [],
        [baseRow({ state: 'completed', completedAt: '2020-01-03T00:00:00.000Z' })],
      ],
    }),
    managedId,
  )
  if (!terminal) throw new TypeError('expected a terminal recovery')
  assertEquals(terminal.state, 'completed')
  assertEquals(terminal.completedAt, '2020-01-03T00:00:00.000Z')
})

test('insertRecovery writes defaults and returns a serialized row', async () => {
  const db = createRecoveryDb()
  const created = await insertRecovery(db, {
    managedId,
    kind: 'switchover',
    sourcePrimaryMemberId: sourceMemberId,
    targetMemberId,
    metadata: { promoteCommandId: 'cmd-1' },
  })

  assertEquals(created.kind, 'switchover')
  assertEquals(created.state, 'detecting')
  assertEquals(created.targetMemberId, targetMemberId)
  assertEquals(created.metadata, { promoteCommandId: 'cmd-1' })
  assertEquals(created.completedAt, null)
  assertEquals(db.inserts.length, 1)
  assertEquals(db.inserts[0]?.managedId, managedId)
  assertEquals(db.inserts[0]?.kind, 'switchover')
  assertEquals(db.inserts[0]?.state, 'detecting')
})

test('insertRecovery rejects an empty returning row', async () => {
  const db = createRecoveryDb({ insertReturning: [] })
  await assertRejects(
    () =>
      insertRecovery(db, {
        managedId,
        kind: 'disaster-recovery',
        sourcePrimaryMemberId: sourceMemberId,
      }),
    Error,
    'Failed to create recovery',
  )
})

test('insertRecovery rejects an unserializable returning row', async () => {
  const db = createRecoveryDb({
    insertReturning: [baseRow({ kind: 'not-a-kind' })],
  })
  await assertRejects(
    () =>
      insertRecovery(db, {
        managedId,
        kind: 'disaster-recovery',
        sourcePrimaryMemberId: sourceMemberId,
      }),
    Error,
    'Failed to serialize recovery',
  )
})

test('updateRecovery stamps completedAt on terminal states and honors explicit patches', async () => {
  const db = createRecoveryDb({
    updateReturning: [baseRow({
      state: 'completed',
      completedAt: '2020-01-04T00:00:00.000Z',
      metadata: { fenced: true, drainApplied: true },
      targetMemberId: null,
    })],
  })

  const updated = await updateRecovery(db, recoveryId, {
    state: 'completed',
    targetMemberId: null,
    metadata: { fenced: true, drainApplied: true },
  })
  if (!updated) throw new TypeError('expected an updated recovery')
  assertEquals(updated.state, 'completed')
  assertEquals(updated.completedAt, '2020-01-04T00:00:00.000Z')
  assertEquals(updated.targetMemberId, null)
  assertEquals(updated.metadata.drainApplied, true)
  assertEquals(typeof db.updates[0]?.updatedAt, 'string')
  assertEquals(db.updates[0]?.completedAt !== undefined, true)

  const explicit = createRecoveryDb({
    updateReturning: [baseRow({
      state: 'failed',
      completedAt: '2020-01-05T00:00:00.000Z',
    })],
  })
  const failed = await updateRecovery(explicit, recoveryId, {
    state: 'failed',
    completedAt: '2020-01-05T00:00:00.000Z',
  })
  if (!failed) throw new TypeError('expected an updated recovery')
  assertEquals(failed.completedAt, '2020-01-05T00:00:00.000Z')
  assertEquals(explicit.updates[0]?.completedAt, '2020-01-05T00:00:00.000Z')
})

test('updateRecovery returns null when no row matches', async () => {
  const updated = await updateRecovery(
    createRecoveryDb({ updateReturning: [] }),
    recoveryId,
    { state: 'verifying' },
  )
  assertEquals(updated, null)
})
