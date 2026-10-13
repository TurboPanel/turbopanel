/**
 * Host-free coverage for live deploy progress on the command row: payload
 * checks, the guarded write, and how a finished command settles its steps.
 */
import { assertEquals } from '@std/assert'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Db } from '../../db/connection.ts'
import type { CommandProgress } from '../../contracts/cell-protocol.ts'
import {
  MAX_DAEMON_WS_PROGRESS_JSON_BYTES,
  validateCommandProgress,
} from '../../contracts/cell-protocol.ts'
import {
  finalizeCommandProgress,
  finalizeStoredCommandProgress,
  parseStoredCommandProgress,
  recordCommandProgress,
} from './command-progress.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AT = '2026-10-12T10:00:00.000Z'
const SERVER_ID = '00000000-0000-4000-8000-000000000011'
const COMMAND_ID = '00000000-0000-4000-8000-000000000010'
const dialect = new PgDialect()

const PLAN: CommandProgress = {
  version: 1,
  steps: [
    { id: 'install-docker', label: 'Install Docker', state: 'ready' },
    { id: 'install-build-tool', label: 'Install the build tool', state: 'done' },
    { id: 'fetch', label: 'Fetch the code', state: 'running', startedAt: AT },
    { id: 'build', label: 'Build', state: 'pending' },
    { id: 'start', label: 'Start the app', state: 'pending' },
  ],
  current: 'fetch',
  updatedAt: AT,
}

function states(progress: CommandProgress): string[] {
  return progress.steps.map((step) => step.state)
}

type UpdateCall = { set: Record<string, unknown>; where: string; params: unknown[] }

/** A `db.update` double that records every set/where and answers `rows`. */
function fakeUpdateDb(rows: unknown[] | Error) {
  const calls: UpdateCall[] = []
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        const where = (predicate: SQL) => {
          const rendered = dialect.sqlToQuery(predicate)
          calls.push({ set: patch, where: rendered.sql, params: rendered.params })
          const outcome = rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)
          return Object.assign(outcome, { returning: () => outcome })
        }
        return { where }
      },
    }),
  } as unknown as Db
  return { db, calls }
}

test('validateCommandProgress accepts a plan and names what is wrong otherwise', () => {
  assertEquals(validateCommandProgress(PLAN), null)
  assertEquals(validateCommandProgress({ ...PLAN, version: 2 }), 'invalid progress version')
  assertEquals(validateCommandProgress({ ...PLAN, current: 7 }), 'invalid progress current')
  assertEquals(
    validateCommandProgress({
      ...PLAN,
      steps: [{ id: 'fetch', label: 'Fetch the code', state: 'paused' }],
    }),
    'invalid step 0 state'
  )
  assertEquals(
    validateCommandProgress({
      ...PLAN,
      steps: [{ id: 'fetch', label: 'x'.repeat(61), state: 'pending' }],
    }),
    'step 0 label exceeds max length'
  )
  assertEquals(
    validateCommandProgress({
      ...PLAN,
      steps: [{ id: 'fetch', label: 'Fetch the code', state: 'running', detail: 'd'.repeat(201) }],
    }),
    'step 0 detail exceeds max length'
  )
  assertEquals(
    validateCommandProgress({
      ...PLAN,
      steps: [{ id: 'i'.repeat(65), label: 'Fetch the code', state: 'pending' }],
    }),
    'step 0 id exceeds max length'
  )
})

test('validateCommandProgress caps the step count and the serialized size', () => {
  const step = { id: 'build', label: 'Build', state: 'pending' as const }
  assertEquals(
    validateCommandProgress({ ...PLAN, steps: Array.from({ length: 25 }, () => step) }),
    'progress steps exceed max entries'
  )
  // Every field within its own cap, but the whole payload past the byte budget.
  const wide = Array.from({ length: 24 }, (_, index) => ({
    id: `step-${index}-${'x'.repeat(50)}`,
    label: 'L'.repeat(60),
    state: 'pending' as const,
    detail: 'd'.repeat(200),
    startedAt: AT,
    finishedAt: AT,
  }))
  const oversized = { ...PLAN, steps: wide }
  assertEquals(JSON.stringify(oversized).length > MAX_DAEMON_WS_PROGRESS_JSON_BYTES, true)
  assertEquals(validateCommandProgress(oversized), 'progress exceeds max size')
})

test('parseStoredCommandProgress returns a typed plan or null', () => {
  assertEquals(parseStoredCommandProgress(PLAN), PLAN)
  assertEquals(parseStoredCommandProgress(null), null)
  assertEquals(parseStoredCommandProgress({ steps: [] }), null)
})

test('recordCommandProgress writes a valid plan guarded by server and live status', async () => {
  const { db, calls } = fakeUpdateDb([{ id: COMMAND_ID }])
  assertEquals(
    await recordCommandProgress(db, { serverId: SERVER_ID, commandId: COMMAND_ID, progress: PLAN }),
    'stored'
  )
  assertEquals(calls.length, 1)
  assertEquals(calls[0].set.progress, PLAN)
  assertEquals(typeof calls[0].set.updatedAt, 'string')
  // The predicate pins the command id, the attached server and a non-terminal status.
  assertEquals(calls[0].where.includes('"command"."server_id" ='), true)
  assertEquals(calls[0].where.includes('"command"."status" not in'), true)
  assertEquals(calls[0].params.slice(0, 2), [COMMAND_ID, SERVER_ID])
  assertEquals(calls[0].params.slice(2), ['succeeded', 'failed', 'timed_out', 'cancelled'])
})

test('recordCommandProgress drops a malformed plan without touching the database', async () => {
  const { db, calls } = fakeUpdateDb([{ id: COMMAND_ID }])
  const result = await recordCommandProgress(db, {
    serverId: SERVER_ID,
    commandId: COMMAND_ID,
    progress: { ...PLAN, steps: 'nope' },
  })
  assertEquals(result, 'invalid')
  assertEquals(calls.length, 0)
})

test('recordCommandProgress reports not-applied for another server or a finished command', async () => {
  // The guarded update matches no row: wrong server, or the command already ended.
  const { db } = fakeUpdateDb([])
  assertEquals(
    await recordCommandProgress(db, { serverId: 'other', commandId: COMMAND_ID, progress: PLAN }),
    'not-applied'
  )
  // A database error never escapes a progress frame.
  const { db: broken } = fakeUpdateDb(new Error('connection reset'))
  assertEquals(
    await recordCommandProgress(broken, {
      serverId: SERVER_ID,
      commandId: COMMAND_ID,
      progress: PLAN,
    }),
    'not-applied'
  )
})

test('finalizeCommandProgress settles unfinished steps by outcome', () => {
  const succeeded = finalizeCommandProgress(PLAN, 'succeeded', AT)
  assertEquals(states(succeeded), ['ready', 'done', 'done', 'done', 'done'])
  assertEquals(succeeded.current, null)
  assertEquals(succeeded.updatedAt, AT)
  // The running step gets a finish stamp; a step the daemon never started does not.
  assertEquals(succeeded.steps[2].finishedAt, AT)
  assertEquals(succeeded.steps[3].finishedAt, undefined)

  assertEquals(states(finalizeCommandProgress(PLAN, 'failed', AT)), [
    'ready',
    'done',
    'failed',
    'skipped',
    'skipped',
  ])
  assertEquals(states(finalizeCommandProgress(PLAN, 'timed_out', AT)), [
    'ready',
    'done',
    'failed',
    'skipped',
    'skipped',
  ])
  assertEquals(states(finalizeCommandProgress(PLAN, 'cancelled', AT)), [
    'ready',
    'done',
    'skipped',
    'skipped',
    'skipped',
  ])
})

test('finalizeCommandProgress leaves a settled or live plan alone', () => {
  const settled = finalizeCommandProgress(PLAN, 'failed', AT)
  // Idempotent: a second pass has nothing to change and returns the same object.
  assertEquals(finalizeCommandProgress(settled, 'failed', AT) === settled, true)
  assertEquals(finalizeCommandProgress(PLAN, 'running', AT) === PLAN, true)
  // A plan the daemon already closed (no current step) only needs its current cleared.
  const closed = { ...settled, current: 'fetch' }
  assertEquals(finalizeCommandProgress(closed, 'failed', AT).current, null)
})

test('finalizeStoredCommandProgress writes back only when the plan changed', async () => {
  const { db, calls } = fakeUpdateDb([])
  const written = await finalizeStoredCommandProgress(db, {
    commandId: COMMAND_ID,
    status: 'cancelled',
    progress: PLAN,
    at: AT,
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].set.progress, written)
  assertEquals(calls[0].set.updatedAt, AT)
  assertEquals(calls[0].params, [COMMAND_ID])
  assertEquals(states(written!), ['ready', 'done', 'skipped', 'skipped', 'skipped'])

  // Already settled: no second write. No plan at all: nothing to do.
  assertEquals(
    await finalizeStoredCommandProgress(db, {
      commandId: COMMAND_ID,
      status: 'cancelled',
      progress: written,
      at: AT,
    }),
    written
  )
  assertEquals(
    await finalizeStoredCommandProgress(db, {
      commandId: COMMAND_ID,
      status: 'failed',
      progress: null,
      at: AT,
    }),
    null
  )
  assertEquals(calls.length, 1)
})
