/**
 * A member that comes back after another took over must never serve writes
 * (`ha-return-fence.ts`): the boot-hold answer and the return-fence sweep, with
 * every read and write behind a seam.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import {
  type BootHoldDeps,
  handleBootHoldReport,
  RETURN_FENCE_MAX_ATTEMPTS,
  returnFenceAction,
  runReturnFenceSweep,
} from './ha-return-fence.ts'
import type { ManagedMemberRow } from './members.ts'
import { managedMemberRow } from '../../test-fixtures/managed-member.ts'
import type { RecoveryRecord } from './recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW_ISO = '2026-10-06T12:00:00.000Z'
const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const MEM_OLD = '00000000-0000-4000-8000-000000000020'
const MEM_NEW = '00000000-0000-4000-8000-000000000021'
const SERVER_OLD = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_NEW = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const DB = {} as Db
const QUEUE: CommandQueue = { enqueue: () => Promise.resolve() }

const member = managedMemberRow

function recovery(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    id: 'rec-1',
    managedId: MANAGED_ID,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: MEM_OLD,
    targetMemberId: MEM_NEW,
    state: 'completed',
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    metadata: {},
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  }
}

type Spy = {
  starts: Array<{ memberId: string; action: string; metadata: Record<string, unknown> }>
  noted: string[]
}

function seams(
  members: ManagedMemberRow[],
  options: {
    inFlight?: RecoveryRecord | null
    latest?: RecoveryRecord | null
    enqueueFails?: boolean
  } = {}
): { deps: BootHoldDeps; spy: Spy } {
  const spy: Spy = { starts: [], noted: [] }
  return {
    spy,
    deps: {
      listMembers: () => Promise.resolve(members),
      inFlightRecovery: () => Promise.resolve(options.inFlight ?? null),
      latestRecovery: () => Promise.resolve(options.latest ?? null),
      enqueueLifecycle: (_db, _queue, params) => {
        spy.starts.push({
          memberId: params.member.id,
          action: params.action,
          metadata: params.metadata,
        })
        return Promise.resolve(options.enqueueFails ? null : 'cmd-1')
      },
      noteReplacedMemberFenced: (_db, _managedId, replaced) => {
        spy.noted.push(replaced.id)
        return Promise.resolve()
      },
    },
  }
}

function report(
  deps: BootHoldDeps,
  overrides: Partial<Parameters<typeof handleBootHoldReport>[1]> = {}
) {
  return handleBootHoldReport(
    DB,
    {
      managedId: MANAGED_ID,
      engine: 'postgres',
      sourceMemberId: MEM_OLD,
      reporterServerId: SERVER_OLD,
      commandQueue: QUEUE,
      ...overrides,
    },
    deps
  )
}

test('a held primary the control plane still calls primary is told to start', async () => {
  const { deps, spy } = seams([
    member(),
    member({ id: MEM_NEW, serverId: SERVER_NEW, role: 'replica' }),
  ])
  assertEquals(await report(deps), 'released')
  assertEquals(spy.starts, [
    { memberId: MEM_OLD, action: 'start', metadata: { bootHoldRelease: true } },
  ])
  assertEquals(spy.noted, [])
})

test('a held member that was replaced stays stopped and is noted, never started', async () => {
  const { deps, spy } = seams([
    member({ role: 'replica', status: 'needs_resync' }),
    member({ id: MEM_NEW, serverId: SERVER_NEW, role: 'primary' }),
  ])
  assertEquals(await report(deps), 'kept')
  assertEquals(spy.starts, [])
  assertEquals(spy.noted, [MEM_OLD])
})

test('power returns after the failover completed: the old primary is held, the new one keeps serving', async () => {
  const { deps, spy } = seams(
    [
      member({ role: 'replica', status: 'needs_resync' }),
      member({ id: MEM_NEW, serverId: SERVER_NEW, role: 'primary' }),
    ],
    { latest: recovery({ metadata: { fenceBasis: 'host-loss-attested' } }) }
  )
  assertEquals(await report(deps), 'kept')
  assertEquals(spy.starts.length, 0)
  // The new primary's own report is answered with a start, as for any primary.
  const newPrimary = await report(deps, { sourceMemberId: MEM_NEW, reporterServerId: SERVER_NEW })
  assertEquals(newPrimary, 'released')
  assertEquals(spy.starts[0]?.memberId, MEM_NEW)
})

test('a report from a server that does not host the named member is ignored', async () => {
  const { deps, spy } = seams([member()])
  assertEquals(await report(deps, { reporterServerId: SERVER_NEW }), 'ignored')
  assertEquals(await report(deps, { sourceMemberId: MEM_NEW }), 'ignored')
  assertEquals(await report(deps, { sourceMemberId: undefined }), 'ignored')
  assertEquals(spy.starts.length + spy.noted.length, 0)
})

test('while a recovery is in flight nothing is released or kept: the daemon asks again', async () => {
  const { deps, spy } = seams([member()], { inFlight: recovery({ state: 'promoting' }) })
  assertEquals(await report(deps), 'wait')
  assertEquals(spy.starts.length + spy.noted.length, 0)
})

test('a recovery that ended needing an operator keeps even a still-primary member stopped', async () => {
  const { deps, spy } = seams([member()], {
    latest: recovery({ state: 'failed', metadata: { needsOperator: true } }),
  })
  assertEquals(await report(deps), 'kept')
  assertEquals(spy.starts.length, 0)
})

test('a primary flagged needs_resync by a blocked failover is released: the control plane never replaced it', async () => {
  const { deps, spy } = seams([member({ status: 'needs_resync' })], {
    latest: recovery({ state: 'blocked', targetMemberId: null }),
  })
  assertEquals(await report(deps), 'released')
  assertEquals(spy.starts[0]?.memberId, MEM_OLD)
})

test('no command queue, or a queue that refuses, means the daemon keeps holding and asks again', async () => {
  const { deps, spy } = seams([member()])
  assertEquals(await report(deps, { commandQueue: undefined }), 'wait')
  const refused = seams([member()], { enqueueFails: true })
  assertEquals(await report(refused.deps), 'wait')
  assertEquals(spy.starts.length, 0)
})

// --- return fence sweep ----------------------------------------------------

type Demoted = Awaited<
  ReturnType<NonNullable<NonNullable<Parameters<typeof runReturnFenceSweep>[2]>['listDemoted']>>
>[number]

function demoted(metadata: unknown, changedAt: string | null = NOW_ISO): Demoted {
  return {
    member: member({ role: 'replica', status: 'needs_resync', metadata }),
    engine: 'postgres',
    serverStatusChangedAt: changedAt,
  }
}

test('a demoted member whose server is back gets one stop, marked so nothing is projected', async () => {
  const stops: Array<{ action: string; metadata: Record<string, unknown> }> = []
  const notes: Array<{ commandId: string; attempts: number }> = []
  const fenced = await runReturnFenceSweep(DB, QUEUE, {
    nowMs: () => Date.parse(NOW_ISO),
    listDemoted: () => Promise.resolve([demoted(null)]),
    enqueueLifecycle: (_db, _queue, params) => {
      stops.push({ action: params.action, metadata: params.metadata })
      return Promise.resolve('cmd-9')
    },
    noteReturnFence: (_db, _member, note) => {
      notes.push({ commandId: note.commandId, attempts: note.attempts })
      return Promise.resolve()
    },
  })
  assertEquals(fenced, [MEM_OLD])
  assertEquals(stops, [{ action: 'stop', metadata: { returnFence: true } }])
  assertEquals(notes, [{ commandId: 'cmd-9', attempts: 1 }])
})

test('the same reconnect is fenced once; a later reconnect is fenced again', async () => {
  const fencedAt = '2026-10-06T12:00:00.000Z'
  const note = { commandId: 'cmd-1', at: fencedAt, attempts: 1 }
  const ok = async () => ({ status: 'succeeded' })
  // Reconnected before the fence: nothing to do (the stop succeeded).
  assertEquals(await returnFenceAction(DB, { returnFence: note }, '2026-10-06T11:59:00.000Z', ok), {
    action: 'skip',
  })
  // Reconnected after the fence: it came back again, fence again.
  assertEquals(await returnFenceAction(DB, { returnFence: note }, '2026-10-06T12:05:00.000Z', ok), {
    action: 'send',
  })
  assertEquals(await returnFenceAction(DB, null, null, ok), { action: 'send' })
  assertEquals(await returnFenceAction(DB, { returnFence: { at: 5 } }, null, ok), {
    action: 'send',
  })
})

test('a stop that failed is retried a few times per reconnect, never for ever', async () => {
  const failed = async () => ({ status: 'failed' })
  const timedOut = async () => ({ status: 'timed_out' })
  const note = (attempts: number) => ({
    returnFence: { commandId: 'cmd-1', at: NOW_ISO, attempts },
  })
  assertEquals(await returnFenceAction(DB, note(1), '2026-10-06T11:00:00.000Z', failed), {
    action: 'retry',
    attempts: 2,
  })
  assertEquals(await returnFenceAction(DB, note(2), '2026-10-06T11:00:00.000Z', timedOut), {
    action: 'retry',
    attempts: 3,
  })
  assertEquals(
    await returnFenceAction(
      DB,
      note(RETURN_FENCE_MAX_ATTEMPTS),
      '2026-10-06T11:00:00.000Z',
      failed
    ),
    { action: 'skip' }
  )
  // Still running or queued: wait for it.
  assertEquals(
    await returnFenceAction(DB, note(1), '2026-10-06T11:00:00.000Z', async () => ({
      status: 'running',
    })),
    { action: 'skip' }
  )
})

test('a failing member never stops the others in the sweep', async () => {
  let calls = 0
  const fenced = await runReturnFenceSweep(DB, QUEUE, {
    listDemoted: () => Promise.resolve([demoted(null), demoted(null)]),
    enqueueLifecycle: () => {
      calls += 1
      return calls === 1 ? Promise.reject(new TypeError('queue down')) : Promise.resolve('cmd')
    },
    noteReturnFence: () => Promise.resolve(),
  })
  assertEquals(calls, 2)
  assertEquals(fenced.length, 1)
})

test('a failing listing is survived', async () => {
  assertEquals(
    await runReturnFenceSweep(DB, QUEUE, {
      listDemoted: () => Promise.reject(new TypeError('down')),
    }),
    []
  )
})
