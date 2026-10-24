/**
 * How long a deploy may wait, and how long it may run.
 *
 * A deploy has two clocks that never overlap:
 *
 * - **Queued**: the deploy is in the command queue, or on the server waiting
 *   for another build to free the host. Nothing is wrong with a deploy that
 *   waits, so this clock is long ({@link DEPLOY_QUEUE_LIMIT_MS}). A server that
 *   stays offline is the one exception ({@link DEPLOY_OFFLINE_LIMIT_MS}).
 * - **Running**: the server reports `runningSince` on its step plan
 *   (`command.progress`) when it begins the work, and `null` while it waits for
 *   another build. The run cap ({@link DEPLOY_RUN_CAP_MS}) counts from
 *   `runningSince` only.
 *
 * A server that does not report `runningSince` (an older build) is treated as
 * running from the moment the command was sent once {@link DEPLOY_SIGNAL_GRACE_MS}
 * has passed, which is the deadline the panel always had.
 *
 * Pure helpers and the wait loop live here; `consumer.ts` and `stale-sweep.ts`
 * call them so the two never disagree.
 */
import type { DaemonCell, PendingRequestRecord } from '../../contracts/cell.ts'
import { parseStoredCommandProgress } from './command-progress.ts'
import {
  DEPLOY_DEFAULT_TIMEOUT_MS,
  DEPLOY_MAX_TIMEOUT_MS,
  DEPLOY_RECONCILE_WINDOW_MS,
  DEPLOY_RUN_CAP_MS,
  DEPLOY_RUN_SILENCE_MS,
} from './deploy-limits.ts'
import { TERMINAL_COMMAND_STATUSES } from './types.ts'

export {
  DEPLOY_DEFAULT_TIMEOUT_MS,
  DEPLOY_RECONCILE_WINDOW_MS,
  DEPLOY_RUN_CAP_MS,
  DEPLOY_RUN_SILENCE_MS,
} from './deploy-limits.ts'

/** The longest a deploy may wait, in the queue or for the server, before it starts. */
export const DEPLOY_QUEUE_LIMIT_MS = 6 * 60 * 60_000

/**
 * The longest the control plane waits for a deploy from when it was sent, in any
 * state: the queue limit, the longest deploy time limit an organization can set (240 minutes) and one whole reconcile window.
 * Quiet time does not count on the run clock, so a deploy that keeps going
 * quiet could otherwise be waited on for ever; past this it is given up on.
 */
export const DEPLOY_WAIT_LIMIT_MS =
  DEPLOY_QUEUE_LIMIT_MS + DEPLOY_MAX_TIMEOUT_MS + DEPLOY_RECONCILE_WINDOW_MS

/**
 * How long the cell keeps a deploy's request: the whole wait limit plus a margin,
 * so the request is still there for every wait, every hand-off and a result
 * that arrives late. The deploy is given up on before the request expires.
 */
export const DEPLOY_REQUEST_TTL_SECONDS = Math.ceil(DEPLOY_WAIT_LIMIT_MS / 1000) + 30 * 60

/** How long a deploy sent to an offline server waits for it to come back. */
export const DEPLOY_OFFLINE_LIMIT_MS = 15 * 60_000

/** How long a server may stay silent about `runningSince` before it counts as an older build. */
export const DEPLOY_SIGNAL_GRACE_MS = 2 * 60_000

/**
 * How long one consumer run keeps waiting for a deploy that has not started.
 * Then it puts the message back on the queue and lets go, because a queue
 * consumer cannot be held for hours. The next run picks the wait up again.
 */
export const DEPLOY_QUEUE_HOLD_MS = 2 * 60_000

/**
 * The longest one consumer run waits for a deploy in any state. Past it the run
 * hands the wait back to the queue, so a run never nears the ~15 minute
 * wall-time limit of a Workers queue consumer; a deploy that runs longer is
 * waited on by the runs that follow.
 */
export const DEPLOY_INVOCATION_LIMIT_MS = 12 * 60_000

/**
 * A deploy the server says is waiting for another build is re-announced about
 * once a minute. This much silence means the server is gone or restarted and
 * lost the deploy, so the control plane stops waiting.
 */
export const DEPLOY_PAUSED_SILENCE_MS = 5 * 60_000

/** How often the wait loop looks at the request and the command row. */
export const DEPLOY_WAIT_POLL_MS = 5_000

export type DeployRunState = { state: 'queued' } | { state: 'running'; sinceMs: number }

function toMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Is a delivered deploy waiting or running, and since when does it run?
 * `sentAt` is when the command was put on the server's connection.
 */
export function deployRunState(input: {
  progress: unknown
  sentAt: string | null
  nowMs: number
}): DeployRunState {
  const runningSince = parseStoredCommandProgress(input.progress)?.runningSince
  if (typeof runningSince === 'string') {
    const sinceMs = toMs(runningSince)
    if (sinceMs !== null) return { state: 'running', sinceMs }
  }
  const sentMs = toMs(input.sentAt)
  const legacy = runningSince === undefined && sentMs !== null
  if (legacy && input.nowMs >= sentMs + DEPLOY_SIGNAL_GRACE_MS) {
    return { state: 'running', sinceMs: sentMs }
  }
  return { state: 'queued' }
}

export type DeployWaitVerdict =
  /** The wait ended with a result, or has not ended. */
  | 'none'
  /** Ran longer than the run cap. */
  | 'run_cap'
  /** The server went quiet during the run and never reported a result inside the reconcile window. */
  | 'unreachable'
  /** Waited longer than the queue limit without starting. */
  | 'queue_limit'
  /** Never reached the server and it stayed offline. */
  | 'offline'
  /** The server said it was waiting for another build, then went quiet. */
  | 'silent'
  /** The server no longer has the request, so no result can arrive. */
  | 'lost'
  /** Someone else (a cancel, the sweep) already finished the command. */
  | 'settled'
  /** Still waiting: put the message back and let go. */
  | 'handoff'

/** What the waiter decides at one look; `null` means keep waiting. */
export function deployWaitVerdict(input: {
  requestStatus: string
  progress: unknown
  sentAt: string | null
  nowMs: number
  holdUntilMs: number
  endAtMs: number
  /** Time since the command row last changed. */
  silentMs: number
  /**
   * The server keeps sending signs of life (`command-recovery-v1`). Without it a
   * quiet running deploy is normal and only the fixed run cap applies.
   */
  recovery?: boolean
  /** The longest a deploy may run while the server reports; the fixed cap without `recovery`. */
  runCapMs?: number
}): DeployWaitVerdict | null {
  const sentMs = toMs(input.sentAt) ?? input.nowMs
  const handoff = input.nowMs >= input.holdUntilMs ? 'handoff' : null
  if (input.requestStatus === 'queued') {
    // Not delivered: the server is offline and the request waits in its outbox.
    return input.nowMs >= sentMs + DEPLOY_OFFLINE_LIMIT_MS ? 'offline' : handoff
  }
  const run = deployRunState(input)
  if (run.state === 'running') return runningVerdict(input, run.sinceMs)
  if (input.nowMs >= sentMs + DEPLOY_QUEUE_LIMIT_MS) return 'queue_limit'
  const paused = parseStoredCommandProgress(input.progress)?.runningSince === null
  if (paused && input.silentMs >= DEPLOY_PAUSED_SILENCE_MS) return 'silent'
  return handoff
}

/**
 * A running deploy. With `command-recovery-v1` the run cap holds only while the
 * server keeps reporting, and a server that goes quiet is checked on for the
 * reconcile window before the deploy is given up on. Without it the fixed cap
 * is all there is.
 */
function runningVerdict(
  input: Parameters<typeof deployWaitVerdict>[0],
  sinceMs: number
): DeployWaitVerdict | null {
  const handoff = input.nowMs >= input.endAtMs ? 'handoff' : null
  if (input.recovery !== true) {
    return input.nowMs >= sinceMs + DEPLOY_RUN_CAP_MS ? 'run_cap' : handoff
  }
  if (input.silentMs >= DEPLOY_RECONCILE_WINDOW_MS) return 'unreachable'
  const quiet = input.silentMs >= DEPLOY_RUN_SILENCE_MS
  const sentMs = toMs(input.sentAt)
  if (sentMs !== null && input.nowMs >= sentMs + DEPLOY_WAIT_LIMIT_MS) {
    return quiet ? 'unreachable' : 'run_cap'
  }
  if (!quiet && input.nowMs >= sinceMs + (input.runCapMs ?? DEPLOY_DEFAULT_TIMEOUT_MS)) {
    return 'run_cap'
  }
  return handoff
}

/** Is a running deploy quiet: no sign of life from a server that should send them? */
export function deployIsChecking(input: {
  progress: unknown
  sentAt: string | null
  nowMs: number
  silentMs: number
  recovery: boolean
}): boolean {
  return (
    input.recovery &&
    input.silentMs >= DEPLOY_RUN_SILENCE_MS &&
    deployRunState(input).state === 'running'
  )
}

/** Plain words for a deploy that ended without a result from the server. */
export const DEPLOY_WAIT_MESSAGES: Record<
  Exclude<DeployWaitVerdict, 'none' | 'handoff' | 'settled'>,
  string
> = {
  run_cap:
    'No result came back from the server within 10 minutes of the deploy starting, so the control plane stopped waiting. The deploy may still have finished on the server, so check the site before deploying again.',
  unreachable:
    'Lost contact with the server during the deploy, and the server did not report a result. Check the server before deploying again.',
  queue_limit:
    'The deploy waited more than 6 hours for the server to start it, so it was given up on. Deploy again when the server is free.',
  silent:
    'The server stopped reporting while the deploy waited for another build, so the deploy was given up on. Deploy again once the server is back.',
  lost: 'The control plane lost track of the deploy on the server. Check the server before deploying again.',
  offline:
    'The server stayed offline, so the deploy never started. Deploy again once the server is back.',
}

/** The message for a deploy stopped at its time limit while the server was still reporting. */
export function deployTimeLimitMessage(runCapMs: number): string {
  const minutes = Math.round(runCapMs / 60_000)
  return `The deploy did not finish within the time limit (${minutes} minutes), so it was stopped. An organization manager can change this in the organization settings. Check the build and deploy again.`
}

/** The message for a deploy given up on after the server went quiet, naming where it was. */
export function deployUnreachableMessage(lastStep: string | null): string {
  const where = lastStep === null ? '' : ` Last known step: ${lastStep}.`
  return `Lost contact with the server during the deploy.${where} The server did not report a result, so the control plane stopped waiting. Check the server before deploying again.`
}

/** The label of the step a deploy was on when it was last heard from, if it said. */
function lastStepLabel(progress: unknown): string | null {
  const plan = parseStoredCommandProgress(progress)
  const step = plan?.steps.find((candidate) => candidate.id === plan.current)
  return step?.label ?? null
}

/** The plain-words error for a deploy that ended without a result; none when it did not end that way. */
export function deployWaitMessage(waiter: DeployWaiter | undefined): string | undefined {
  const verdict = waiter?.verdict
  if (waiter === undefined || verdict === undefined) return undefined
  if (verdict === 'none' || verdict === 'handoff' || verdict === 'settled') return undefined
  if (verdict === 'run_cap' && waiter.recovery) return deployTimeLimitMessage(waiter.runCapMs)
  if (verdict === 'unreachable') return deployUnreachableMessage(lastStepLabel(waiter.lastProgress))
  return DEPLOY_WAIT_MESSAGES[verdict]
}

/**
 * The waiter for a sent deploy whose request the cell no longer holds: nothing
 * can deliver its result any more, so it is given up on as unreachable, naming
 * the last step it reported. It is never sent again.
 */
export function lostRequestWaiter(lastProgress: unknown): DeployWaiter {
  return {
    verdict: 'unreachable',
    recovery: true,
    runCapMs: DEPLOY_DEFAULT_TIMEOUT_MS,
    lastProgress,
    wait: () => Promise.resolve(null),
  }
}

/** Verdicts after which the deploy may still be sitting on the server and should be told to stop. */
export const DEPLOY_WAIT_CANCELS_SERVER: ReadonlySet<DeployWaitVerdict> = new Set([
  'run_cap',
  'queue_limit',
  'silent',
])

export type DeployWaiter = {
  /** Set when {@link DeployWaiter.wait} returned `null`. */
  verdict: DeployWaitVerdict
  /** The server sends signs of life, so the time limit holds only while it reports. */
  readonly recovery: boolean
  /** The time limit in effect while the server reports. */
  readonly runCapMs: number
  /** The step plan as last read, for naming where a deploy was when contact was lost. */
  lastProgress: unknown
  wait(cell: DaemonCell, requestId: string, timeoutMs: number): Promise<PendingRequestRecord | null>
}

const TERMINAL_REQUEST_STATUSES = new Set(['done', 'failed', 'expired'])
const TERMINAL_COMMAND_STATUS_SET: ReadonlySet<string> = TERMINAL_COMMAND_STATUSES

/** What the waiter reads from the command row each round. */
export type DeployCommandView = { status: string; progress: unknown; updatedAt: string }

export type DeployWaiterDeps = {
  readCommand: () => Promise<DeployCommandView | null>
  sentAt: string | null
  /** Test seams. */
  now?: () => number
  holdMs?: number
  endMs?: number
  pollMs?: number
  /** The server sends signs of life (`command-recovery-v1`). */
  recovery?: boolean
  /** The time limit while the server reports; see {@link deployWaitVerdict}. */
  runCapMs?: number
  /** Called when a running deploy first goes quiet, with when the server was last heard. */
  onContactLost?: (lastHeardAt: string) => Promise<void>
}

/**
 * Wait for a deploy's outcome with the two clocks above. `timeoutMs` (the
 * old single budget) is ignored: the verdict comes from the deploy's state.
 * Each round waits on the cell for up to `pollMs`, so it sleeps in the cell
 * and not here.
 */
export function createDeployWaiter(deps: DeployWaiterDeps): DeployWaiter {
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? DEPLOY_WAIT_POLL_MS
  const startedMs = now()
  const holdUntilMs = startedMs + (deps.holdMs ?? DEPLOY_QUEUE_HOLD_MS)
  const endAtMs = startedMs + (deps.endMs ?? DEPLOY_INVOCATION_LIMIT_MS)
  let contactMarked = false
  const waiter: DeployWaiter = {
    verdict: 'none',
    recovery: deps.recovery === true,
    runCapMs: deps.runCapMs ?? DEPLOY_DEFAULT_TIMEOUT_MS,
    lastProgress: null,
    async wait(cell, requestId) {
      for (;;) {
        const finished = await cell.waitForRequest(requestId, pollMs)
        if (finished) return finished
        const request = await cell.getRequest(requestId)
        if (request && TERMINAL_REQUEST_STATUSES.has(request.status)) return request
        const view = request === null ? null : await deps.readCommand()
        if (view !== null) waiter.lastProgress = view.progress
        const verdict = decide(request, view)
        await noteQuiet(request, view)
        if (verdict !== null) {
          waiter.verdict = verdict
          return null
        }
      }
    },
  }
  async function noteQuiet(
    request: PendingRequestRecord | null,
    view: DeployCommandView | null
  ): Promise<void> {
    if (deps.onContactLost === undefined || view === null || request?.status === 'queued') return
    const nowMs = now()
    const silentMs = nowMs - (Date.parse(view.updatedAt) || nowMs)
    const checking = deployIsChecking({
      progress: view.progress,
      sentAt: deps.sentAt,
      nowMs,
      silentMs,
      recovery: deps.recovery === true,
    })
    if (!checking) {
      contactMarked = false
      return
    }
    if (contactMarked) return
    contactMarked = true
    await deps.onContactLost(view.updatedAt)
  }
  function decide(
    request: PendingRequestRecord | null,
    view: DeployCommandView | null
  ): DeployWaitVerdict | null {
    if (request === null) return 'lost'
    if (view !== null && TERMINAL_COMMAND_STATUS_SET.has(view.status)) return 'settled'
    const nowMs = now()
    return deployWaitVerdict({
      requestStatus: request.status,
      progress: request.status === 'queued' ? null : view?.progress,
      sentAt: deps.sentAt,
      nowMs,
      holdUntilMs,
      endAtMs,
      silentMs: view === null ? 0 : nowMs - (Date.parse(view.updatedAt) || nowMs),
      recovery: deps.recovery === true,
      ...(deps.runCapMs === undefined ? {} : { runCapMs: deps.runCapMs }),
    })
  }
  return waiter
}
