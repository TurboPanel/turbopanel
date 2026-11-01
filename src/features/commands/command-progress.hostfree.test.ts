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
    'unknown value: step 0 state'
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

test('validateCommandProgress ties current to the one running step and keeps ids unique', () => {
  assertEquals(
    validateCommandProgress({ ...PLAN, current: null }),
    'progress current does not match the running step'
  )
  assertEquals(
    validateCommandProgress({ ...PLAN, current: 'build' }),
    'progress current does not match the running step'
  )
  const settled = { ...PLAN, steps: PLAN.steps.map((step) => ({ ...step, state: 'done' })) }
  assertEquals(validateCommandProgress({ ...settled, current: null }), null)
  assertEquals(
    validateCommandProgress({ ...settled, current: 'fetch' }),
    'progress current does not match the running step'
  )
  assertEquals(
    validateCommandProgress({
      ...PLAN,
      steps: PLAN.steps.map((step) => (step.id === 'build' ? { ...step, state: 'running' } : step)),
    }),
    'more than one running step'
  )
  assertEquals(
    validateCommandProgress({ ...PLAN, steps: [...PLAN.steps, PLAN.steps[3]] }),
    'duplicate step id build'
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
  const oversized = { ...PLAN, steps: wide, current: null }
  assertEquals(JSON.stringify(oversized).length > MAX_DAEMON_WS_PROGRESS_JSON_BYTES, true)
  assertEquals(validateCommandProgress(oversized), 'progress exceeds max size')
})

test('parseStoredCommandProgress returns a typed plan or null', () => {
  assertEquals(parseStoredCommandProgress(PLAN), PLAN)
  assertEquals(parseStoredCommandProgress(null), null)
  assertEquals(parseStoredCommandProgress({ steps: [] }), null)
  assertEquals(parseStoredCommandProgress({ ...PLAN, current: 3 }), null)
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
  assertEquals(calls[0].params.slice(2, 6), ['succeeded', 'failed', 'timed_out', 'cancelled'])
})

test('recordCommandProgress never replaces a newer stored plan with an older frame', async () => {
  // Frames are handled one connection each, so two sent a few milliseconds
  // apart can finish in either order; the older one must not win.
  const { db, calls } = fakeUpdateDb([{ id: COMMAND_ID }])
  await recordCommandProgress(db, { serverId: SERVER_ID, commandId: COMMAND_ID, progress: PLAN })
  assertEquals(calls[0].where.includes(`'updatedAt'`), true)
  assertEquals(calls[0].params.includes(PLAN.updatedAt), true)
})

test('recordCommandProgress stores only the fields it knows', async () => {
  const { db, calls } = fakeUpdateDb([{ id: COMMAND_ID }])
  const padded = {
    ...PLAN,
    extra: 'later',
    steps: PLAN.steps.map((step) => ({ ...step, note: 'ignored' })),
  }
  await recordCommandProgress(db, { serverId: SERVER_ID, commandId: COMMAND_ID, progress: padded })
  assertEquals(calls[0].set.progress, PLAN)
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
  const { db, calls } = fakeUpdateDb([{ id: COMMAND_ID }])
  const written = await finalizeStoredCommandProgress(db, {
    commandId: COMMAND_ID,
    status: 'cancelled',
    progress: PLAN,
    at: AT,
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].set.progress, written)
  assertEquals(calls[0].set.updatedAt, AT)
  assertEquals(calls[0].params, [COMMAND_ID, PLAN.updatedAt])
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

test('finalizeStoredCommandProgress survives a failed write-back', async () => {
  // The terminal transition already committed; a cleanup hiccup must not undo it.
  const { db } = fakeUpdateDb(new Error('connection reset'))
  const written = await finalizeStoredCommandProgress(db, {
    commandId: COMMAND_ID,
    status: 'failed',
    progress: PLAN,
    at: AT,
  })
  assertEquals(states(written!), ['ready', 'done', 'failed', 'skipped', 'skipped'])
})

test('validateCommandProgress accepts runningSince as a time, null, or absent, and rejects anything else', () => {
  const base = { version: 1, steps: [], current: null, updatedAt: '2026-10-21T10:00:00.000Z' }
  assertEquals(validateCommandProgress(base), null)
  assertEquals(validateCommandProgress({ ...base, runningSince: null }), null)
  assertEquals(validateCommandProgress({ ...base, runningSince: '2026-10-21T10:00:01.000Z' }), null)
  assertEquals(
    validateCommandProgress({ ...base, runningSince: 'soon' }),
    'invalid progress runningSince'
  )
  assertEquals(
    validateCommandProgress({ ...base, runningSince: 5 }),
    'invalid progress runningSince'
  )
})

const CERT_NOTE = 'Requested in the background; the Certificate panel shows progress: example.test'

const CERT_RUNNING: CommandProgress = {
  version: 1,
  steps: [
    { id: 'build', label: 'Build', state: 'done', startedAt: AT, finishedAt: AT },
    { id: 'certificates', label: 'Set up certificates', state: 'running', startedAt: AT },
  ],
  current: 'certificates',
  updatedAt: AT,
}

const CERT_DONE: CommandProgress = {
  version: 1,
  steps: [
    { id: 'build', label: 'Build', state: 'done', startedAt: AT, finishedAt: AT },
    {
      id: 'certificates',
      label: 'Set up certificates',
      state: 'done',
      startedAt: AT,
      finishedAt: AT,
      detail: CERT_NOTE,
    },
  ],
  current: null,
  updatedAt: AT,
}

/**
 * A db double that holds one command row and applies updates the way the
 * guards read: a `status not in (...)` update never touches a finished row.
 */
function fakeRowDb(
  row: { status: string; serverId: string; progress: unknown; updatedAt: string },
  afterFirstSelect?: () => void
) {
  const writes: Record<string, unknown>[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: (predicate: SQL) => ({
          limit: () => {
            const { params } = dialect.sqlToQuery(predicate)
            const { sql } = dialect.sqlToQuery(predicate)
            const found =
              !sql.includes('server_id') || params.includes(row.serverId) ? [{ ...row }] : []
            const hook = afterFirstSelect
            afterFirstSelect = undefined
            hook?.()
            return Promise.resolve(found)
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: SQL) => {
          const { sql, params } = dialect.sqlToQuery(predicate)
          const guardedUpdatedAt = sql.includes(`->>'updatedAt' =`)
          const current = (row.progress as { updatedAt?: string } | null)?.updatedAt
          const blocked =
            (sql.includes('not in') && params.includes(row.status)) ||
            (guardedUpdatedAt && !params.includes(current))
          const applied = !blocked
          if (applied) {
            writes.push(patch)
            Object.assign(row, patch)
          }
          const outcome = Promise.resolve(applied ? [{ id: COMMAND_ID }] : [])
          return Object.assign(outcome, { returning: () => outcome })
        },
      }),
    }),
  } as unknown as Db
  return { db, row, writes }
}

test('a settled frame that arrives after the command finished keeps the step note', async () => {
  // The result won the race: the panel already settled the running step.
  const settled = finalizeCommandProgress(CERT_RUNNING, 'succeeded', '2026-10-12T10:00:05.000Z')
  const { db, row } = fakeRowDb({
    status: 'succeeded',
    serverId: SERVER_ID,
    progress: settled,
    updatedAt: AT,
  })
  const result = await recordCommandProgress(db, {
    serverId: SERVER_ID,
    commandId: COMMAND_ID,
    progress: CERT_DONE,
  })
  assertEquals(result, 'stored')
  const stored = parseStoredCommandProgress(row.progress)
  assertEquals(stored?.steps[1].state, 'done')
  assertEquals(stored?.steps[1].detail, CERT_NOTE)
  assertEquals(stored?.current, null)
})

test('a late frame never reopens a finished command or overwrites a settled step', async () => {
  const settled = finalizeCommandProgress(CERT_DONE, 'succeeded', '2026-10-12T10:00:05.000Z')
  const { db, row } = fakeRowDb({
    status: 'succeeded',
    serverId: SERVER_ID,
    progress: settled,
    updatedAt: AT,
  })
  // An older frame with the step still running adds nothing.
  assertEquals(
    await recordCommandProgress(db, {
      serverId: SERVER_ID,
      commandId: COMMAND_ID,
      progress: CERT_RUNNING,
    }),
    'not-applied'
  )
  // Another server's frame adds nothing either.
  assertEquals(
    await recordCommandProgress(db, {
      serverId: 'other',
      commandId: COMMAND_ID,
      progress: CERT_DONE,
    }),
    'not-applied'
  )
  assertEquals(row.progress, settled)
})

test('a step note replaces the live line the step showed while it ran', async () => {
  const live: CommandProgress = {
    ...CERT_RUNNING,
    steps: [CERT_RUNNING.steps[0], { ...CERT_RUNNING.steps[1], detail: 'Checking names' }],
  }
  const settled = finalizeCommandProgress(live, 'succeeded', '2026-10-12T10:00:05.000Z')
  const { db, row } = fakeRowDb({
    status: 'succeeded',
    serverId: SERVER_ID,
    progress: settled,
    updatedAt: AT,
  })
  await recordCommandProgress(db, {
    serverId: SERVER_ID,
    commandId: COMMAND_ID,
    progress: CERT_DONE,
  })
  assertEquals(parseStoredCommandProgress(row.progress)?.steps[1].detail, CERT_NOTE)
})

test('the terminal settle does not erase a note that landed first', async () => {
  // The result row committed, but its settle has not been written yet.
  const { db, row } = fakeRowDb({
    status: 'succeeded',
    serverId: SERVER_ID,
    progress: CERT_RUNNING,
    updatedAt: AT,
  })
  await recordCommandProgress(db, {
    serverId: SERVER_ID,
    commandId: COMMAND_ID,
    progress: CERT_DONE,
  })
  const returned = await finalizeStoredCommandProgress(db, {
    commandId: COMMAND_ID,
    status: 'succeeded',
    progress: CERT_RUNNING,
    at: '2026-10-12T10:00:05.000Z',
  })
  assertEquals(returned?.steps[1].detail, CERT_NOTE)
  const stored = parseStoredCommandProgress(row.progress)
  assertEquals(stored?.steps[1].state, 'done')
  assertEquals(stored?.steps[1].detail, CERT_NOTE)
})

test('a late note retries when the terminal settle wins the write', async () => {
  // The late handler reads the unsettled plan; the settle then lands before its write.
  const settled = finalizeCommandProgress(CERT_RUNNING, 'succeeded', '2026-10-12T10:00:05.000Z')
  const { db, row } = fakeRowDb(
    { status: 'succeeded', serverId: SERVER_ID, progress: CERT_RUNNING, updatedAt: AT },
    () => {
      row.progress = settled
    }
  )
  const result = await recordCommandProgress(db, {
    serverId: SERVER_ID,
    commandId: COMMAND_ID,
    progress: CERT_DONE,
  })
  assertEquals(result, 'stored')
  assertEquals(parseStoredCommandProgress(row.progress)?.steps[1].detail, CERT_NOTE)
})
