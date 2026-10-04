/**
 * "Use this network for server-to-server traffic" — the point-and-click form
 * of the datacenter priority rule (lower number wins, default 100).
 *
 * The owner picks a datacenter; the planner gives it the lowest number among
 * the trusted datacenters and moves the others up, so nobody types a number.
 * Pure: it only returns which priorities change. The route applies them and
 * runs the existing routing re-plan (`routing-fanout.ts`).
 */

import { DATACENTER_PRIORITY_MAX } from './datacenter-options.ts'

/** The number the chosen datacenter gets when there is room below the rivals. */
export const SERVER_TRAFFIC_PRIORITY = 10
/** How far rivals move up when the chosen one needs the very lowest number. */
export const SERVER_TRAFFIC_RIVAL_STEP = 10

export type TrafficDatacenter = {
  id: string
  priority: number
  trusted: boolean
}

export type PriorityChange = {
  datacenterId: string
  before: number
  after: number
}

export type ServerTrafficPlan =
  | { ok: true; changes: PriorityChange[] }
  | { ok: false; error: 'datacenter_not_found' | 'datacenter_not_trusted' }

function trustedRivals(
  datacenters: readonly TrafficDatacenter[],
  chosenId: string
): TrafficDatacenter[] {
  return datacenters.filter((dc) => dc.trusted && dc.id !== chosenId)
}

/**
 * Priorities to write so `chosenId` carries server-to-server traffic.
 *
 * - An untrusted datacenter is refused: the routing ladder never uses it.
 * - Already strictly lower than every trusted rival: nothing changes.
 * - Otherwise it gets `SERVER_TRAFFIC_PRIORITY` (10), or 0 when a rival sits
 *   at 10 or lower. A rival at 0 cannot be beaten, so every trusted rival
 *   moves up by `SERVER_TRAFFIC_RIVAL_STEP` (capped at the maximum), which
 *   keeps their order among themselves.
 * Untrusted datacenters keep their numbers: they never compete.
 */
export function planServerTrafficChoice(
  datacenters: readonly TrafficDatacenter[],
  chosenId: string
): ServerTrafficPlan {
  const chosen = datacenters.find((dc) => dc.id === chosenId)
  if (!chosen) return { ok: false, error: 'datacenter_not_found' }
  if (!chosen.trusted) return { ok: false, error: 'datacenter_not_trusted' }

  const rivals = trustedRivals(datacenters, chosenId)
  if (rivals.length === 0) return { ok: true, changes: [] }
  const lowestRival = Math.min(...rivals.map((dc) => dc.priority))
  if (chosen.priority < lowestRival) return { ok: true, changes: [] }

  const target = lowestRival > SERVER_TRAFFIC_PRIORITY ? SERVER_TRAFFIC_PRIORITY : 0
  const candidates: PriorityChange[] = [
    { datacenterId: chosen.id, before: chosen.priority, after: target },
  ]
  if (lowestRival === 0) {
    for (const rival of rivals) {
      candidates.push({
        datacenterId: rival.id,
        before: rival.priority,
        after: Math.min(DATACENTER_PRIORITY_MAX, rival.priority + SERVER_TRAFFIC_RIVAL_STEP),
      })
    }
  }
  return { ok: true, changes: candidates.filter((change) => change.before !== change.after) }
}

export type ServerTrafficStatus = {
  /** No other trusted datacenter has a lower number (so it carries the traffic). */
  wins: boolean
  /** Another trusted datacenter has the same number: the winner is chosen by id. */
  tied: boolean
}

export type EqualPriorityWarning = {
  code: 'equal_priority'
  priority: number
  datacenterIds: string[]
}

/** Per datacenter: does it win, and is it tied. Untrusted ones never do either. */
export function serverTrafficStatus(
  datacenters: readonly TrafficDatacenter[]
): Map<string, ServerTrafficStatus> {
  const out = new Map<string, ServerTrafficStatus>()
  for (const dc of datacenters) {
    if (!dc.trusted) {
      out.set(dc.id, { wins: false, tied: false })
      continue
    }
    const rivals = trustedRivals(datacenters, dc.id)
    out.set(dc.id, {
      wins: rivals.every((rival) => dc.priority <= rival.priority),
      tied: rivals.some((rival) => rival.priority === dc.priority),
    })
  }
  return out
}

/** One warning per priority number two or more trusted datacenters share. */
export function equalPriorityWarnings(
  datacenters: readonly TrafficDatacenter[]
): EqualPriorityWarning[] {
  const byPriority = new Map<number, string[]>()
  for (const dc of datacenters) {
    if (!dc.trusted) continue
    byPriority.set(dc.priority, [...(byPriority.get(dc.priority) ?? []), dc.id])
  }
  return [...byPriority.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([priority, ids]) => ({
      code: 'equal_priority' as const,
      priority,
      datacenterIds: [...ids].sort(),
    }))
}
