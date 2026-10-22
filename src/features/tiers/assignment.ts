/**
 * Tier assignment — which purchased tier each server sits on.
 *
 * An organization owns a quantity per tier (the `seat` rows). Which server
 * holds which of those licenses is **chosen by the organization's managers,
 * never by TurboPanel**: `server.assigned_tier_id` is written only by the
 * manager route (`PUT /servers/:id/license-tier`, `server-preferred-tier.ts`)
 * and by the self-hosted grant fill (`assignment-records.ts`, self-hosted
 * only, never on the hosted runtime). Nothing here or anywhere else assigns,
 * moves or releases a server's license on its own — not a hardware report,
 * not an enroll, not a seat change, not a server delete. An organization may
 * deliberately keep a server on a smaller tier than it measures; that server
 * keeps its tier and is only flagged.
 *
 * This module only **reads** the assignment the managers made against what
 * the organization bought:
 *
 *   - `byServer` is each licensed server's held tier (`null` when none was
 *     assigned yet);
 *   - `spare` is, per tier, purchased quantity no server holds;
 *   - `unassigned` lists, in bind order, licensed servers no manager has
 *     given a tier yet (a normal state for a new server, not an error);
 *   - `uncovered` lists, in bind order, licensed servers with no tier and
 *     servers holding a tier whose purchased quantity is already used by
 *     older servers (more holders than seats — the newest are the ones
 *     over). An uncovered server keeps its tier and stays connected; it is
 *     reported, never moved.
 *
 * The hardware requirement (`tier-placement`, `requiredRank`) and the
 * recommendation (`recommendedRank`) ride along for flags, notices and
 * recommendations only; they never change `byServer`.
 *
 * Pure: no I/O, no clock.
 */

import { ENTRY_TIER_RANK } from './ladder.ts'

export type TierQuantity = Readonly<{
  tierId: string
  rank: number
  quantity: number
}>

export type AssignableServer = Readonly<{
  serverId: string
  /** The tier a manager assigned (`server.assigned_tier_id`); `null` when none. */
  assignedTierId: string | null
  /** From `tier-placement`; `null` when hardware is not yet known. Flags only. */
  requiredRank: number | null
  /** From `resolveRecommendedTier`; `null`/absent when unknown. Recommendations only. */
  recommendedRank?: number | null
  /** Bind order key: the server row's `created_at`. Ties break on id. */
  boundAt: string
}>

export type TierAssignment = Readonly<{
  /** `tierId` the server holds, or `null` when a manager has not assigned one. */
  byServer: ReadonlyMap<string, string | null>
  /** Purchased quantity no server is holding, per purchased tier. */
  spare: ReadonlyMap<string, number>
  /** Servers in bind order with no tier, or holding more of a tier than was bought. */
  uncovered: readonly string[]
  /** The part of `uncovered` with no tier at all (not yet assigned). */
  unassigned: readonly string[]
}>

export function effectiveRequiredRank(server: Pick<AssignableServer, 'requiredRank'>): number {
  return server.requiredRank ?? ENTRY_TIER_RANK
}

/** Bind order: oldest first, then id, so a read is stable. */
export function sortByBindOrder<T extends Pick<AssignableServer, 'serverId' | 'boundAt'>>(
  servers: readonly T[]
): T[] {
  return [...servers].sort((a, b) => {
    const byBound = a.boundAt.localeCompare(b.boundAt)
    if (byBound !== 0) return byBound
    return a.serverId.localeCompare(b.serverId)
  })
}

/**
 * Read the managers' assignment against the purchased quantities. Never
 * chooses a tier for anyone: `byServer` is exactly each server's
 * `assignedTierId`.
 */
export function readAssignment(
  quantities: readonly TierQuantity[],
  servers: readonly AssignableServer[]
): TierAssignment {
  const left = new Map<string, number>()
  for (const entry of quantities) {
    left.set(entry.tierId, (left.get(entry.tierId) ?? 0) + Math.max(0, entry.quantity))
  }
  const byServer = new Map<string, string | null>()
  const uncovered: string[] = []
  const unassigned: string[] = []
  for (const server of sortByBindOrder(servers)) {
    const held = server.assignedTierId
    byServer.set(server.serverId, held)
    const free = held === null ? 0 : (left.get(held) ?? 0)
    if (held !== null && free > 0) {
      left.set(held, free - 1)
    } else {
      uncovered.push(server.serverId)
      if (held === null) unassigned.push(server.serverId)
    }
  }
  const spare = new Map<string, number>()
  for (const entry of quantities) {
    if (entry.quantity > 0) spare.set(entry.tierId, left.get(entry.tierId) ?? 0)
  }
  return { byServer, spare, uncovered, unassigned }
}

/** Purchased quantity at `tierId` that no server other than `exceptServerId` holds. */
export function freeAtTier(
  quantities: readonly TierQuantity[],
  servers: readonly AssignableServer[],
  tierId: string,
  exceptServerId?: string
): number {
  const bought = quantities
    .filter((entry) => entry.tierId === tierId)
    .reduce((sum, entry) => sum + Math.max(0, entry.quantity), 0)
  const held = servers.filter(
    (entry) => entry.assignedTierId === tierId && entry.serverId !== exceptServerId
  ).length
  return bought - held
}

/**
 * Would this mix leave a server uncovered that is covered today? The gate
 * every reduction and deferred change runs: `null` when the change is
 * safe, otherwise the first server (in bind order) it would leave holding
 * a tier nobody pays for. The server is never moved to make room — a
 * manager reassigns or releases it first. `requiredRank` is the rank of the
 * tier that server holds.
 *
 * `futureServers` is the same servers after the moves the change itself
 * names (an owner's upgrade or downgrade of one named server); it defaults
 * to `servers`, i.e. nobody moves.
 */
export function coverageLoss(
  current: readonly TierQuantity[],
  proposed: readonly TierQuantity[],
  servers: readonly AssignableServer[],
  futureServers: readonly AssignableServer[] = servers
): { serverId: string; requiredRank: number } | null {
  const before = new Set(readAssignment(current, servers).uncovered)
  const after = readAssignment(proposed, futureServers)
  const rankOf = new Map<string, number>()
  for (const entry of [...current, ...proposed]) rankOf.set(entry.tierId, entry.rank)
  for (const serverId of after.uncovered) {
    if (before.has(serverId)) continue
    const held = futureServers.find((entry) => entry.serverId === serverId)?.assignedTierId ?? null
    return {
      serverId,
      requiredRank: (held !== null ? rankOf.get(held) : undefined) ?? ENTRY_TIER_RANK,
    }
  }
  return null
}

/** `servers` with the named servers put on the named tiers; everyone else as they are. */
export function serversAfterMoves<T extends AssignableServer>(
  servers: readonly T[],
  moves: ReadonlyMap<string, string>
): T[] {
  if (moves.size === 0) return [...servers]
  return servers.map((entry) => {
    const to = moves.get(entry.serverId)
    return to === undefined ? entry : { ...entry, assignedTierId: to }
  })
}

/** Apply per-tier deltas to a quantity list; tiers with no current row are created at rank `rankOf(tierId)`. */
export function applyTierDeltas(
  current: readonly TierQuantity[],
  deltas: ReadonlyMap<string, number>,
  rankOf: (tierId: string) => number | undefined
): TierQuantity[] {
  const out = new Map<string, TierQuantity>()
  for (const entry of current) out.set(entry.tierId, entry)
  for (const [tierId, delta] of deltas) {
    const existing = out.get(tierId)
    const rank = existing?.rank ?? rankOf(tierId)
    if (rank === undefined) throw new TypeError(`tier ${tierId} has no rank`)
    const quantity = (existing?.quantity ?? 0) + delta
    if (quantity < 0) {
      throw new RangeError(`tier ${tierId} would go to ${quantity}`)
    }
    out.set(tierId, { tierId, rank, quantity })
  }
  return [...out.values()]
}
