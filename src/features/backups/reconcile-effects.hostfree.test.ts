import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { applyBackupsReconcileSideEffect, reportedNextRuns } from './reconcile-effects.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '0192f1de-7c3b-7e4a-9f10-00000000000a'
const B = '0192f1de-7c3b-7e4a-9f10-00000000000b'
const OTHER = '0192f1de-7c3b-7e4a-9f10-0000000000ff'

function entry(policyId: string) {
  return {
    policyId,
    targetKind: 'managed',
    managedId: '0192f1de-7c3b-7e4a-9f10-000000000001',
    engine: 'postgres',
    artifactExtension: 'dump',
    onCalendar: '*-*-* 03:00:00',
    retentionKeep: 7,
    enabled: true,
  }
}

function result(nextRuns: unknown[]) {
  return { policiesApplied: 2, unitsChanged: [], unitsRemoved: [], nextRuns, warnings: [] }
}

test('reportedNextRuns keeps scheduled policies the command sent', () => {
  const payload = { policies: [entry(A), entry(B)] }
  assertEquals(
    reportedNextRuns(
      payload,
      result([
        { policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' },
        { policyId: B },
        { policyId: OTHER, nextRunAt: '2026-10-06T09:00:00.000Z' },
      ])
    ),
    [{ policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' }]
  )
})

test('reportedNextRuns refuses a result that is not the reconcile shape', () => {
  assertThrows(() => reportedNextRuns({ policies: [entry(A)] }, { nextRuns: 'soon' }))
})

const dialect = new PgDialect()

type UpdateCall = { values: Record<string, unknown>; where: SQL }

/** A `Db` whose `update().set().where()` chain records each write (or throws). */
function fakeDb(failure?: Error) {
  const calls: UpdateCall[] = []
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: SQL) => {
          if (failure) return Promise.reject(failure)
          calls.push({ values, where })
          return Promise.resolve()
        },
      }),
    }),
  }
  return { db: db as unknown as Db, calls }
}

const record = (type = 'server.backups.reconcile') => ({
  id: 'cmd-1',
  type,
  payload: { policies: [entry(A), entry(B)] },
})

test('applyBackupsReconcileSideEffect stores only the next runs of policies the command carried', async () => {
  const { db, calls } = fakeDb()
  await applyBackupsReconcileSideEffect(
    db,
    record(),
    result([
      { policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' },
      { policyId: B },
      { policyId: OTHER, nextRunAt: '2026-10-06T09:00:00.000Z' },
    ])
  )
  assertEquals(calls.length, 1)
  const [call] = calls
  assertEquals(call.values.nextRunAt, '2026-10-06T08:25:35.000Z')
  assertEquals(dialect.sqlToQuery(call.where).params, [A])
})

test('applyBackupsReconcileSideEffect leaves updated_at as the operator left it', async () => {
  const { db, calls } = fakeDb()
  await applyBackupsReconcileSideEffect(
    db,
    record(),
    result([{ policyId: B, nextRunAt: '2026-10-06T10:00:00.000Z' }])
  )
  assertEquals(Object.keys(calls[0].values).sort(), ['nextRunAt', 'updatedAt'])
  // `updated_at = updated_at`, not a new timestamp and not the `$onUpdate` now().
  assertEquals(dialect.sqlToQuery(calls[0].values.updatedAt as SQL).sql, '"retention"."updated_at"')
})

test('applyBackupsReconcileSideEffect ignores other command types', async () => {
  const { db, calls } = fakeDb()
  await applyBackupsReconcileSideEffect(
    db,
    record('server.backups.run'),
    result([{ policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' }])
  )
  assertEquals(calls, [])
})

test('applyBackupsReconcileSideEffect logs a database error and never fails the command', async () => {
  const { db } = fakeDb(new Error('connection reset'))
  const lines: string[] = []
  const decoder = new TextDecoder()
  const original = Deno.stderr.writeSync
  Deno.stderr.writeSync = (data: Uint8Array) => {
    lines.push(decoder.decode(data))
    return data.length
  }
  try {
    await applyBackupsReconcileSideEffect(
      db,
      record(),
      result([{ policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' }])
    )
  } finally {
    Deno.stderr.writeSync = original
  }
  assertEquals(lines.length, 1)
  assertStringIncludes(lines[0], 'backups reconcile side effect failed for command cmd-1')
  assertStringIncludes(lines[0], 'connection reset')
})

test('applyBackupsReconcileSideEffect logs a result that is not the reconcile shape', async () => {
  const { db, calls } = fakeDb()
  const original = Deno.stderr.writeSync
  Deno.stderr.writeSync = (data: Uint8Array) => data.length
  try {
    await applyBackupsReconcileSideEffect(db, record(), { nextRuns: 'soon' })
  } finally {
    Deno.stderr.writeSync = original
  }
  assertEquals(calls, [])
})
