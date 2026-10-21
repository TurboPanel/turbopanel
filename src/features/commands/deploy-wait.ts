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
import { TERMINAL_COMMAND_STATUSES } from './types.ts'

/** The longest a running deploy may take, counted from when it started. */
export const DEPLOY_RUN_CAP_MS = 600_000

/** The longest a deploy may wait, in the queue or for the server, before it starts. */
export const DEPLOY_QUEUE_LIMIT_MS = 6 * 60 * 60_000

/** How long the cell keeps a deploy's request while it waits: the queue limit plus a margin. */
export const DEPLOY_REQUEST_TTL_SECONDS = Math.ceil(DEPLOY_QUEUE_LIMIT_MS / 1000) + 15 * 60

/** How long a deploy sent to an offline server waits for it to come back. */
export const DEPLOY_OFFLINE_LIMIT_MS = 15 * 60_000

/** How long a server may stay silent about `runningSince` before it counts as an older build. */
export const DEPLOY_SIGNAL_GRACE_MS = 2 * 60_000

/**
 * How long one consumer run keeps waiting for a deploy that has not started.
 * Then it puts the message back on the queue and lets go, because a queue
 * consumer cannot be held for hours. Short enough that a deploy that starts
 * just before this still finishes inside a Workers invocation (4 + 10 minutes).
 */
export const DEPLOY_QUEUE_HOLD_MS = 2 * 60_000

/**
 * The longest one consumer run waits for a deploy in any state. Past it the run
 * hands the wait back, so a run never nears the ~15 minute wall-time limit of a
 * Workers queue consumer (a deploy that starts at the last moment of the hold
 * still has its 10 minute cap inside this).
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
}): DeployWaitVerdict | null {
  const sentMs = toMs(input.sentAt) ?? input.nowMs
  const handoff = input.nowMs >= input.holdUntilMs ? 'handoff' : null
  if (input.requestStatus === 'queued') {
    // Not delivered: the server is offline and the request waits in its outbox.
    return input.nowMs >= sentMs + DEPLOY_OFFLINE_LIMIT_MS ? 'offline' : handoff
  }
  const run = deployRunState(input)
  if (run.state === 'running') {
    if (input.nowMs >= run.sinceMs + DEPLOY_RUN_CAP_MS) return 'run_cap'
    return input.nowMs >= input.endAtMs ? 'handoff' : null
  }
  if (input.nowMs >= sentMs + DEPLOY_QUEUE_LIMIT_MS) return 'queue_limit'
  const paused = parseStoredCommandProgress(input.progress)?.runningSince === null
  if (paused && input.silentMs >= DEPLOY_PAUSED_SILENCE_MS) return 'silent'
  return handoff
}

/** Plain words for a deploy that ended without a result from the server. */
export const DEPLOY_WAIT_MESSAGES: Record<
  Exclude<DeployWaitVerdict, 'none' | 'handoff' | 'settled'>,
  string
> = {
  run_cap:
    'The deploy was still running after 10 minutes, so the control plane stopped waiting for it.',
  queue_limit:
    'The deploy waited more than 6 hours for the server to start it, so it was given up on. Deploy again when the server is free.',
  silent:
    'The server stopped reporting while the deploy waited for another build, so the deploy was given up on. Deploy again once the server is back.',
  lost: 'The control plane lost track of the deploy on the server. Check the server before deploying again.',
  offline:
    'The server stayed offline, so the deploy never started. Deploy again once the server is back.',
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
  const waiter: DeployWaiter = {
    verdict: 'none',
    async wait(cell, requestId) {
      for (;;) {
        const finished = await cell.waitForRequest(requestId, pollMs)
        if (finished) return finished
        const request = await cell.getRequest(requestId)
        if (request && TERMINAL_REQUEST_STATUSES.has(request.status)) return request
        const view = request === null ? null : await deps.readCommand()
        const verdict = decide(request, view)
        if (verdict !== null) {
          waiter.verdict = verdict
          return null
        }
      }
    },
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
    })
  }
  return waiter
}
