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

/** The longest a running deploy may take, counted from when it started. */
export const DEPLOY_RUN_CAP_MS = 600_000

/** The longest a deploy may wait, in the queue or for the server, before it starts. */
export const DEPLOY_QUEUE_LIMIT_MS = 6 * 60 * 60_000

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
export const DEPLOY_QUEUE_HOLD_MS = 4 * 60_000

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
  /** The server no longer has the request, so no result can arrive. */
  | 'lost'
  /** Still waiting: put the message back and let go. */
  | 'handoff'

/** What the waiter decides at one look; `null` means keep waiting. */
export function deployWaitVerdict(input: {
  requestStatus: string
  progress: unknown
  sentAt: string | null
  nowMs: number
  holdUntilMs: number
}): DeployWaitVerdict | null {
  const sentMs = toMs(input.sentAt) ?? input.nowMs
  if (input.requestStatus === 'queued') {
    // Not delivered: the server is offline and the request waits in its outbox.
    if (input.nowMs >= sentMs + DEPLOY_OFFLINE_LIMIT_MS) return 'offline'
    return input.nowMs >= input.holdUntilMs ? 'handoff' : null
  }
  const run = deployRunState(input)
  if (run.state === 'running') {
    return input.nowMs >= run.sinceMs + DEPLOY_RUN_CAP_MS ? 'run_cap' : null
  }
  if (input.nowMs >= sentMs + DEPLOY_QUEUE_LIMIT_MS) return 'queue_limit'
  return input.nowMs >= input.holdUntilMs ? 'handoff' : null
}

/** Plain words for a deploy that ended without a result from the server. */
export const DEPLOY_WAIT_MESSAGES: Record<
  Exclude<DeployWaitVerdict, 'none' | 'handoff'>,
  string
> = {
  run_cap:
    'The deploy was still running after 10 minutes, so the control plane stopped waiting for it.',
  queue_limit:
    'The deploy waited more than 6 hours for the server to start it, so it was given up on. Deploy again when the server is free.',
  lost: 'The control plane lost track of the deploy on the server. Check the server before deploying again.',
  offline:
    'The server stayed offline, so the deploy never started. Deploy again once the server is back.',
}

export type DeployWaiter = {
  /** Set when {@link DeployWaiter.wait} returned `null`. */
  verdict: DeployWaitVerdict
  wait(cell: DaemonCell, requestId: string, timeoutMs: number): Promise<PendingRequestRecord | null>
}

const TERMINAL_REQUEST_STATUSES = new Set(['done', 'failed', 'expired'])

export type DeployWaiterDeps = {
  /** The command row's stored step plan (`command.progress`). */
  readProgress: () => Promise<unknown>
  sentAt: string | null
  /** Test seams. */
  now?: () => number
  holdMs?: number
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
  const holdUntilMs = now() + (deps.holdMs ?? DEPLOY_QUEUE_HOLD_MS)
  const waiter: DeployWaiter = {
    verdict: 'none',
    async wait(cell, requestId) {
      for (;;) {
        const finished = await cell.waitForRequest(requestId, pollMs)
        if (finished) return finished
        const request = await cell.getRequest(requestId)
        if (request && TERMINAL_REQUEST_STATUSES.has(request.status)) return request
        const verdict =
          request === null
            ? 'lost'
            : deployWaitVerdict({
                requestStatus: request.status,
                progress: request.status === 'queued' ? null : await deps.readProgress(),
                sentAt: deps.sentAt,
                nowMs: now(),
                holdUntilMs,
              })
        if (verdict !== null) {
          waiter.verdict = verdict
          return null
        }
      }
    },
  }
  return waiter
}
