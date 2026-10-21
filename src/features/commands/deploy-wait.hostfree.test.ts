/** Host-free coverage for the deploy's two clocks: queued, then running. */

import { assertEquals } from '@std/assert'
import type { DaemonCell, PendingRequestRecord } from '../../contracts/cell.ts'
import { awaitOutcomeWithAckDeadline } from './consumer.ts'
import {
  createDeployWaiter,
  DEPLOY_OFFLINE_LIMIT_MS,
  DEPLOY_QUEUE_HOLD_MS,
  DEPLOY_QUEUE_LIMIT_MS,
  DEPLOY_RUN_CAP_MS,
  DEPLOY_SIGNAL_GRACE_MS,
  deployRunState,
  deployWaitVerdict,
} from './deploy-wait.ts'

const test = Deno.test.bind(Deno)

const T0 = Date.parse('2026-10-21T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function plan(runningSince?: string | null) {
  return {
    version: 1,
    steps: [],
    current: null,
    updatedAt: iso(T0),
    ...(runningSince === undefined ? {} : { runningSince }),
  }
}

test('a server that says it is waiting for another build is queued, however long it waits', () => {
  const state = deployRunState({
    progress: plan(null),
    sentAt: iso(T0),
    nowMs: T0 + 3 * 60 * 60_000,
  })
  assertEquals(state, { state: 'queued' })
})

test('a server that says it started is running from that moment, not from when it was sent', () => {
  const started = T0 + 40 * 60_000
  const state = deployRunState({
    progress: plan(iso(started)),
    sentAt: iso(T0),
    nowMs: started + 1000,
  })
  assertEquals(state, { state: 'running', sinceMs: started })
})

test('a server that reports nothing gets a short grace, then counts as running since it was sent', () => {
  const sentAt = iso(T0)
  assertEquals(deployRunState({ progress: null, sentAt, nowMs: T0 + 1000 }), { state: 'queued' })
  assertEquals(deployRunState({ progress: plan(), sentAt, nowMs: T0 + DEPLOY_SIGNAL_GRACE_MS }), {
    state: 'running',
    sinceMs: T0,
  })
})

function verdict(over: Partial<Parameters<typeof deployWaitVerdict>[0]>) {
  return deployWaitVerdict({
    requestStatus: 'acked',
    progress: plan(null),
    sentAt: iso(T0),
    nowMs: T0,
    holdUntilMs: T0 + DEPLOY_QUEUE_HOLD_MS,
    ...over,
  })
}

test('a queued deploy keeps waiting, then hands the wait back, then gives up at the queue limit', () => {
  assertEquals(verdict({ nowMs: T0 + 60_000 }), null)
  assertEquals(verdict({ nowMs: T0 + DEPLOY_QUEUE_HOLD_MS }), 'handoff')
  assertEquals(
    verdict({ nowMs: T0 + DEPLOY_QUEUE_LIMIT_MS, holdUntilMs: T0 + DEPLOY_QUEUE_LIMIT_MS + 1 }),
    'queue_limit'
  )
})

test('the run cap counts only from when the deploy started', () => {
  const started = T0 + 2 * 60 * 60_000
  const progress = plan(iso(started))
  assertEquals(verdict({ progress, nowMs: started + DEPLOY_RUN_CAP_MS - 1 }), null)
  assertEquals(verdict({ progress, nowMs: started + DEPLOY_RUN_CAP_MS }), 'run_cap')
})

test('a running deploy is never handed back, even past the hold', () => {
  const progress = plan(iso(T0))
  assertEquals(verdict({ progress, nowMs: T0 + DEPLOY_QUEUE_HOLD_MS + 1000 }), null)
})

test('a deploy that never reached an offline server fails at the offline limit, not before', () => {
  const over = { requestStatus: 'queued', holdUntilMs: T0 + DEPLOY_OFFLINE_LIMIT_MS + 1 }
  assertEquals(verdict({ ...over, nowMs: T0 + DEPLOY_OFFLINE_LIMIT_MS - 1 }), null)
  assertEquals(verdict({ ...over, nowMs: T0 + DEPLOY_OFFLINE_LIMIT_MS }), 'offline')
})

function request(status: string): PendingRequestRecord {
  return {
    serverId: 's1',
    requestId: 'r1',
    requestKind: 'command-dispatch',
    status,
    createdAt: iso(T0),
    expiresAt: iso(T0 + 1000),
  } as PendingRequestRecord
}

function waiterHarness(statuses: string[], progress: () => unknown, holdMs = 60_000) {
  let nowMs = T0
  const cell = {
    // A round that finds nothing ends after the poll interval, as a real cell does.
    waitForRequest: (_id: string, ms: number) => {
      nowMs += ms
      return Promise.resolve(null)
    },
    getRequest: () =>
      Promise.resolve(
        statuses.length === 0
          ? null
          : request(statuses.length > 1 ? statuses.shift()! : statuses[0])
      ),
  } as unknown as DaemonCell
  const waiter = createDeployWaiter({
    sentAt: iso(T0),
    readProgress: () => Promise.resolve(progress()),
    now: () => nowMs,
    holdMs,
    pollMs: 10_000,
  })
  return { cell, waiter, now: () => nowMs }
}

test('the waiter returns the outcome as soon as the request finishes', async () => {
  const h = waiterHarness(['acked', 'acked', 'done'], () => plan(null))
  const result = await h.waiter.wait(h.cell, 'r1', 0)
  assertEquals(result?.status, 'done')
  assertEquals(h.waiter.verdict, 'none')
  assertEquals(h.now(), T0 + 30_000)
})

test('the waiter stops at once when the server no longer has the request', async () => {
  const h = waiterHarness([], () => plan(null))
  assertEquals(await h.waiter.wait(h.cell, 'r1', 0), null)
  assertEquals(h.waiter.verdict, 'lost')
})

test('the waiter hands a deploy that is still queued back after the hold', async () => {
  const h = waiterHarness(['acked'], () => plan(null), 60_000)
  assertEquals(await h.waiter.wait(h.cell, 'r1', 0), null)
  assertEquals(h.waiter.verdict, 'handoff')
  assertEquals(h.now(), T0 + 60_000)
})

test('the waiter stops a running deploy at the run cap measured from its start', async () => {
  const started = T0 + 30_000
  const h = waiterHarness(['acked'], () => plan(iso(started)), 60_000)
  assertEquals(await h.waiter.wait(h.cell, 'r1', 0), null)
  assertEquals(h.waiter.verdict, 'run_cap')
  assertEquals(h.now(), started + DEPLOY_RUN_CAP_MS)
})

test('the ack deadline still fails a deploy the server never acknowledged', async () => {
  const cell = {
    waitForRequest: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(request('sent')),
    dropDaemonConnection: () => Promise.resolve(),
    expireRequest: () => Promise.resolve(request('expired')),
  } as unknown as DaemonCell
  const waiter = createDeployWaiter({ sentAt: iso(T0), readProgress: () => Promise.resolve(null) })
  const result = await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000, waiter)
  assertEquals(result?.status, 'failed')
  assertEquals(waiter.verdict, 'none')
})
