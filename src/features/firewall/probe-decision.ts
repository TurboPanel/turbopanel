/**
 * What the outside reachability probe saw, and what to do about it.
 *
 * The vocabulary is small on purpose and is what lands in the stored record:
 *
 * - a connection attempt ends in `open` (the handshake completed), `refused`
 *   (the host answered with a reset: the packet got through but nothing
 *   listens, OR a reject rule answered, so it is never counted as reachable),
 *   `timeout` (silence: what a drop rule looks like), `blocked` (the platform
 *   would not dial it) or `error`;
 * - a port's state is the best of its attempts across the server's addresses;
 * - the decision about a change is `confirm`, `withhold` or `unavailable`.
 *
 * Pure: no network, no clock, no database.
 */

import type { ProbeRole } from './probe-plan.ts'

export type ProbeState = 'open' | 'refused' | 'timeout' | 'blocked' | 'error'

/** One connection attempt. */
export type ProbeObservation = {
  address: string
  port: number
  state: ProbeState
  /** Milliseconds to the handshake, only for `open`. */
  ms: number | null
}

/** One port after merging its attempts across the server's addresses. */
export type PortReach = {
  port: number
  role: ProbeRole
  reason: string
  state: ProbeState
  ms: number | null
}

export type ConfirmationDecision =
  | { kind: 'confirm'; checkedPorts: number[] }
  | { kind: 'withhold'; cutPorts: number[]; reason: string }
  | { kind: 'unavailable'; reason: string }

const STATE_RANK: Record<ProbeState, number> = {
  open: 4,
  refused: 3,
  timeout: 2,
  blocked: 1,
  error: 0,
}

/** The best state among attempts at the same port (any address that answers counts). */
export function bestState(states: readonly ProbeState[]): ProbeState {
  let best: ProbeState = 'error'
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[best]) best = state
  }
  return best
}

type PortInfo = { port: number; role: ProbeRole; reason: string }

/** Merge attempts into one entry per planned port, in plan order. */
export function reachFromObservations(
  ports: readonly PortInfo[],
  observations: readonly ProbeObservation[]
): PortReach[] {
  return ports.map((info) => {
    const attempts = observations.filter((observation) => observation.port === info.port)
    const state = attempts.length === 0 ? 'blocked' : bestState(attempts.map((a) => a.state))
    const open = attempts.filter((attempt) => attempt.state === 'open')
    const ms = open.length === 0 ? null : Math.min(...open.map((attempt) => attempt.ms ?? 0))
    return { port: info.port, role: info.role, reason: info.reason, state, ms }
  })
}

function isGating(reach: PortReach): boolean {
  return reach.role !== 'informational'
}

/**
 * Can this change be confirmed automatically?
 *
 * Only ports that were reachable BEFORE the change count: a port nobody could
 * reach yesterday (nothing listens, a NAT in the way, a private network the
 * control plane cannot see) proves nothing about today. Auto-confirm needs at
 * least one reachable invariant port (SSH or the panel's own port), because
 * that is what keeps a person from being locked out; without it the answer is
 * `unavailable` and the manual "Keep" click is the fallback. If any port that
 * was reachable before is no longer reachable after, the answer is `withhold`:
 * nothing is confirmed and the root timer undoes the change.
 */
export function decideConfirmation(
  baseline: readonly PortReach[],
  after: readonly PortReach[]
): ConfirmationDecision {
  const watched = baseline.filter((reach) => isGating(reach) && reach.state === 'open')
  if (!watched.some((reach) => reach.role === 'invariant')) {
    return {
      kind: 'unavailable',
      reason:
        'The control plane could not reach SSH or the panel port from outside before the change, so it cannot check that the change keeps people able to get in. Confirm manually.',
    }
  }
  const stillOpen = new Set(after.filter((reach) => reach.state === 'open').map((r) => r.port))
  const cutPorts = watched.map((reach) => reach.port).filter((port) => !stillOpen.has(port))
  if (cutPorts.length > 0) {
    return {
      kind: 'withhold',
      cutPorts,
      reason: `Port(s) ${cutPorts.join(', ')} answered before the change and do not now. Nothing is confirmed, so the host undoes the change by itself.`,
    }
  }
  return { kind: 'confirm', checkedPorts: watched.map((reach) => reach.port) }
}
