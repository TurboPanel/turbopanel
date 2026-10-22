/**
 * Timing limits shared by the deploy waiter (`deploy-wait.ts`), the progress
 * writer (`command-progress.ts`) and the stale sweep. Kept apart so the
 * progress writer does not import the waiter.
 */

/**
 * The fixed run cap for a server that cannot send signs of life (a daemon without
 * `command-recovery-v1`): counted from when the deploy started running.
 */
export const DEPLOY_RUN_CAP_MS = 600_000

/**
 * The default longest a deploy may run when its server keeps reporting
 * (`command-recovery-v1`). Counted only while the server is heard from; the
 * organization can change it (`deployTimeoutMinutes`).
 */
export const DEPLOY_DEFAULT_TIMEOUT_MS = 30 * 60_000

/**
 * A running deploy whose server has said nothing for this long is "checking with
 * the server": the control plane no longer knows its state and does not call it
 * failed. A server with `command-recovery-v1` repeats the step plan every 30 s.
 */
export const DEPLOY_RUN_SILENCE_MS = 5 * 60_000

/**
 * How long a deploy may stay "checking with the server" before the control plane
 * gives up and says the server never reported a result. Inside the request's
 * time to live (`DEPLOY_REQUEST_TTL_SECONDS`).
 */
export const DEPLOY_RECONCILE_WINDOW_MS = 6 * 60 * 60_000

/** Smallest and largest organization deploy timeout, in minutes. */
export const DEPLOY_TIMEOUT_MIN_MINUTES = 5
export const DEPLOY_TIMEOUT_MAX_MINUTES = 240

/**
 * The run clock after a gap in the server's reports: the quiet time is added to
 * `runningSince`, so a deploy is timed only while the server is reporting.
 * `null` when there is nothing to move.
 */
export function shiftedRunningSince(input: {
  runningSince: string | null | undefined
  lastHeardMs: number | null
  nowMs: number
}): string | null {
  if (typeof input.runningSince !== 'string' || input.lastHeardMs === null) return null
  const gap = input.nowMs - input.lastHeardMs
  if (gap <= DEPLOY_RUN_SILENCE_MS) return null
  const since = Date.parse(input.runningSince)
  if (!Number.isFinite(since)) return null
  return new Date(Math.min(since + gap, input.nowMs)).toISOString()
}
