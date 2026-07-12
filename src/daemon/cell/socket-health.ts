/**
 * Pure watchdog policy for daemon-cell WebSockets.
 *
 * Cost guardrail: a Durable Object bills for wall-clock time whenever it is
 * awake but not hibernating. The primary fix for the 71-minute billable-duration
 * incident is bounding every DO DB op (see `src/db.ts` `runWithDbTimeout`), which
 * lets the object hibernate promptly. This module is the belt-and-suspenders
 * backstop: the offline-sweep cron already probes every connected server once a
 * minute via `DaemonCell.checkLiveness`, so we reuse that visit to force-close
 * sockets that are either dead/half-open or have exceeded a hard maximum age.
 * Force-closing lets the daemon reconnect (full-jitter backoff + connect rate
 * limit) and guarantees no single connection can bill unbounded.
 *
 * Kept pure and dependency-free so it is trivially unit-testable and so
 * `do.ts` stays free of scheduling/policy logic.
 */

/**
 * Close a socket whose last auto-response (cell ping/pong) is older than this.
 * The daemon's `IdlePresence` pings every ~60s, so a gap this large means the
 * socket is dead or half-open (a hard power-off / network partition that never
 * fired `webSocketClose`). Must stay comfortably above the 60s ping cadence.
 */
export const HALF_OPEN_CLOSE_MS = 150_000

/**
 * Absolute cap on a single WebSocket's lifetime. A healthy daemon reconnects
 * seamlessly, so this is a rare, cheap event for good sockets; for any future
 * "stuck awake" regression it guarantees the connection (and its billing) is
 * torn down within this window instead of running unbounded.
 */
export const MAX_WS_CONNECTION_AGE_MS = 2 * 60 * 60 * 1_000

export type SocketReapReason = "half_open" | "max_age"

export type SocketHealthInput = {
  nowMs: number
  /** Attach time in epoch ms, or null when unknown (socket restored from an older build). */
  connectedAtMs: number | null
  /** Last auto-response (cell ping) time in epoch ms, or null when none observed yet. */
  lastPingAtMs: number | null
}

export type SocketHealthDecision = {
  reap: boolean
  reason: SocketReapReason | null
}

/**
 * Decide whether a daemon-cell WebSocket should be force-closed. Max-age wins
 * over half-open so the log reason reflects the stronger signal. A socket that
 * has never produced an auto-response yet (`lastPingAtMs === null`) is only
 * reaped once it crosses the absolute age cap — never on the half-open path,
 * which would otherwise kill brand-new connections before their first ping.
 */
export function evaluateSocketHealth(
  input: SocketHealthInput,
  maxAgeMs: number = MAX_WS_CONNECTION_AGE_MS,
  halfOpenMs: number = HALF_OPEN_CLOSE_MS,
): SocketHealthDecision {
  const { nowMs, connectedAtMs, lastPingAtMs } = input

  if (connectedAtMs !== null && nowMs - connectedAtMs >= maxAgeMs) {
    return { reap: true, reason: "max_age" }
  }

  if (lastPingAtMs !== null && nowMs - lastPingAtMs >= halfOpenMs) {
    return { reap: true, reason: "half_open" }
  }

  return { reap: false, reason: null }
}
