/** Host-free coverage for the deploy's two clocks: queued, then running. */

import { assertEquals } from '@std/assert'
import type { DaemonCell, PendingRequestRecord } from '../../contracts/cell.ts'
import { awaitOutcomeWithAckDeadline } from './consumer.ts'
import {
  createDeployWaiter,
  DEPLOY_INVOCATION_LIMIT_MS,
  DEPLOY_OFFLINE_LIMIT_MS,
  DEPLOY_PAUSED_SILENCE_MS,
  DEPLOY_REQUEST_TTL_SECONDS,
  DEPLOY_WAIT_LIMIT_MS,
  DEPLOY_QUEUE_HOLD_MS,
  DEPLOY_QUEUE_LIMIT_MS,
  DEPLOY_RECONCILE_WINDOW_MS,
  DEPLOY_RUN_CAP_MS,
  DEPLOY_RUN_SILENCE_MS,
  DEPLOY_SIGNAL_GRACE_MS,
  DEPLOY_DEFAULT_TIMEOUT_MS,
  deployIsChecking,
  deployRunState,
  deployUnreachableMessage,
  deployWaitMessage,
  deployWaitVerdict,
} from './deploy-wait.ts'
import { shiftedRunningSince } from './deploy-limits.ts'

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
    endAtMs: T0 + DEPLOY_INVOCATION_LIMIT_MS,
    silentMs: 0,
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
  const endAtMs = started + 2 * DEPLOY_RUN_CAP_MS
  assertEquals(verdict({ progress, endAtMs, nowMs: started + DEPLOY_RUN_CAP_MS - 1 }), null)
  assertEquals(verdict({ progress, endAtMs, nowMs: started + DEPLOY_RUN_CAP_MS }), 'run_cap')
})

test('a running deploy is kept past the hold but handed back before the invocation limit', () => {
  const progress = plan(iso(T0 + 4 * 60_000))
  assertEquals(verdict({ progress, nowMs: T0 + DEPLOY_QUEUE_HOLD_MS + 1000 }), null)
  assertEquals(verdict({ progress, nowMs: T0 + DEPLOY_INVOCATION_LIMIT_MS }), 'handoff')
})

test('a deploy the server said was waiting, then went quiet, is given up on', () => {
  const quiet = { silentMs: DEPLOY_PAUSED_SILENCE_MS - 1, nowMs: T0 + 60_000 }
  assertEquals(verdict(quiet), null)
  assertEquals(verdict({ ...quiet, silentMs: DEPLOY_PAUSED_SILENCE_MS }), 'silent')
  // A server that never said anything is not judged by silence.
  assertEquals(verdict({ progress: null, silentMs: DEPLOY_PAUSED_SILENCE_MS * 10 }), null)
})

test('a deploy request outlives the queue limit in the cell', () => {
  assertEquals(DEPLOY_REQUEST_TTL_SECONDS * 1000 > DEPLOY_QUEUE_LIMIT_MS + DEPLOY_RUN_CAP_MS, true)
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

function waiterHarness(
  statuses: string[],
  progress: () => unknown,
  holdMs = 60_000,
  commandStatus = () => 'sent'
) {
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
    readCommand: () =>
      Promise.resolve({ status: commandStatus(), progress: progress(), updatedAt: iso(T0) }),
    now: () => nowMs,
    holdMs,
    endMs: 3_600_000,
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
  const waiter = createDeployWaiter({ sentAt: iso(T0), readCommand: () => Promise.resolve(null) })
  const result = await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000, waiter)
  assertEquals(result?.status, 'failed')
  assertEquals(waiter.verdict, 'none')
})

test('the waiter stops when the command was already finished by someone else', async () => {
  let status = 'sent'
  const h = waiterHarness(
    ['acked'],
    () => plan(null),
    600_000,
    () => status
  )
  status = 'cancelled'
  assertEquals(await h.waiter.wait(h.cell, 'r1', 0), null)
  assertEquals(h.waiter.verdict, 'settled')
})

const REPORTING = { recovery: true as const }
const STARTED = T0 + 60_000
const RUNNING = plan(iso(STARTED))

test('a server that keeps reporting may run past ten minutes, up to the deploy time limit', () => {
  const endAtMs = STARTED + 10 * DEPLOY_DEFAULT_TIMEOUT_MS
  const base = { ...REPORTING, progress: RUNNING, endAtMs }
  assertEquals(verdict({ ...base, nowMs: STARTED + DEPLOY_RUN_CAP_MS + 1 }), null)
  assertEquals(verdict({ ...base, nowMs: STARTED + DEPLOY_DEFAULT_TIMEOUT_MS - 1 }), null)
  assertEquals(verdict({ ...base, nowMs: STARTED + DEPLOY_DEFAULT_TIMEOUT_MS }), 'run_cap')
  const hour = 60 * 60_000
  assertEquals(verdict({ ...base, runCapMs: hour, nowMs: STARTED + hour - 1 }), null)
  assertEquals(verdict({ ...base, runCapMs: hour, nowMs: STARTED + hour }), 'run_cap')
})

test('a quiet server is checked on, not failed, until the whole reconcile window has passed', () => {
  const base = {
    ...REPORTING,
    progress: RUNNING,
    nowMs: STARTED + 2 * DEPLOY_DEFAULT_TIMEOUT_MS,
    endAtMs: STARTED + 10 * DEPLOY_RECONCILE_WINDOW_MS,
  }
  // Past the time limit, but the server is not reporting: that is not a timeout.
  assertEquals(verdict({ ...base, silentMs: DEPLOY_RUN_SILENCE_MS }), null)
  assertEquals(verdict({ ...base, silentMs: DEPLOY_RECONCILE_WINDOW_MS - 1 }), null)
  assertEquals(verdict({ ...base, silentMs: DEPLOY_RECONCILE_WINDOW_MS }), 'unreachable')
})

test('a server without signs of life keeps the fixed ten minute cap', () => {
  const base = { progress: RUNNING, endAtMs: STARTED + DEPLOY_RECONCILE_WINDOW_MS }
  assertEquals(
    verdict({ ...base, nowMs: STARTED + DEPLOY_RUN_CAP_MS - 1, silentMs: 9 * 60_000 }),
    null
  )
  assertEquals(verdict({ ...base, nowMs: STARTED + DEPLOY_RUN_CAP_MS }), 'run_cap')
})

test('a deploy is "checking" only when it runs, its server sends signs of life, and it went quiet', () => {
  const base = { progress: RUNNING, sentAt: iso(T0), nowMs: STARTED + 20 * 60_000 }
  const quiet = { ...base, silentMs: DEPLOY_RUN_SILENCE_MS, recovery: true }
  assertEquals(deployIsChecking(quiet), true)
  assertEquals(deployIsChecking({ ...quiet, silentMs: DEPLOY_RUN_SILENCE_MS - 1 }), false)
  assertEquals(deployIsChecking({ ...quiet, recovery: false }), false)
  assertEquals(deployIsChecking({ ...quiet, progress: plan(null) }), false)
})

test('quiet time is added to the run clock only after the silence threshold', () => {
  const runningSince = iso(T0)
  const lastHeardMs = T0 + 10 * 60_000
  assertEquals(
    shiftedRunningSince({ runningSince, lastHeardMs, nowMs: lastHeardMs + DEPLOY_RUN_SILENCE_MS }),
    null
  )
  assertEquals(
    shiftedRunningSince({ runningSince, lastHeardMs, nowMs: lastHeardMs + 20 * 60_000 }),
    iso(T0 + 20 * 60_000)
  )
  assertEquals(shiftedRunningSince({ runningSince: null, lastHeardMs, nowMs: T0 }), null)
})

test('the waiter marks a quiet deploy as checking, once', async () => {
  const updatedAt = T0
  const marks: string[] = []
  let nowMs = T0 + 20 * 60_000
  const cell = {
    waitForRequest: (_id: string, ms: number) => {
      nowMs += ms
      return Promise.resolve(null)
    },
    getRequest: () => Promise.resolve(request('acked')),
  } as unknown as DaemonCell
  const waiter = createDeployWaiter({
    sentAt: iso(T0),
    readCommand: () =>
      Promise.resolve({
        status: 'running',
        progress: plan(iso(STARTED)),
        updatedAt: iso(updatedAt),
      }),
    now: () => nowMs,
    holdMs: 60_000,
    endMs: 60_000,
    pollMs: 10_000,
    recovery: true,
    onContactLost: (at) => {
      marks.push(at)
      return Promise.resolve()
    },
  })
  assertEquals(await waiter.wait(cell, 'r1', 0), null)
  assertEquals(waiter.verdict, 'handoff')
  assertEquals(marks, [iso(T0)])
})

test('the messages say what is true about each way a deploy can end without a result', () => {
  const waiter = (verdict: string, recovery: boolean) =>
    ({ verdict, recovery, runCapMs: 45 * 60_000, lastProgress: plan(iso(STARTED)) }) as never
  assertEquals(deployWaitMessage(waiter('none', true)), undefined)
  assertEquals(deployWaitMessage(waiter('handoff', true)), undefined)
  assertEquals(deployWaitMessage(waiter('run_cap', true))?.includes('45 minutes'), true)
  const legacy = deployWaitMessage(waiter('run_cap', false))
  assertEquals(legacy?.includes('No result came back'), true)
  assertEquals(legacy?.includes('stopped waiting for it'), false)
  assertEquals(
    deployUnreachableMessage('Build running').includes('Last known step: Build running.'),
    true
  )
  assertEquals(deployUnreachableMessage(null).includes('Last known step'), false)
})

test('the request outlives the whole wait, and a deploy is given up on before it runs out', () => {
  assertEquals(DEPLOY_REQUEST_TTL_SECONDS * 1000 > DEPLOY_WAIT_LIMIT_MS, true)
  const sentAt = '2026-10-22T00:00:00.000Z'
  const sentMs = Date.parse(sentAt)
  const nowMs = sentMs + DEPLOY_WAIT_LIMIT_MS
  // Reporting all along, with quiet gaps keeping the run clock short.
  const progress = {
    version: 1,
    steps: [],
    current: null,
    updatedAt: sentAt,
    runningSince: new Date(nowMs - 60_000).toISOString(),
  }
  const verdict = (silentMs: number) =>
    deployWaitVerdict({
      requestStatus: 'acked',
      progress,
      sentAt,
      nowMs,
      holdUntilMs: 0,
      endAtMs: Number.POSITIVE_INFINITY,
      silentMs,
      recovery: true,
    })
  assertEquals(verdict(0), 'run_cap')
  assertEquals(verdict(10 * 60_000), 'unreachable')
  assertEquals(nowMs < sentMs + DEPLOY_REQUEST_TTL_SECONDS * 1000, true)
})
