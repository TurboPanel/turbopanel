/**
 * Tier assignment — which purchased tier each server sits on.
 *
 * An organization owns a quantity per tier (the `seat` rows). Each server
 * with an active license needs a tier from its hardware (`tier-placement`:
 * required = max(core band, RAM band)). By default nobody chooses which server
 * gets which; this module computes it, and the result is cached on
 * `server.assigned_tier_id` by `assignment-records.ts`. An optional
 * `server.preferred_tier_id` asks for at least that tier when a spare license
 * exists there or on the smallest tier above.
 *
 * The rule, spelled once:
 *
 *   1. Servers are taken **in bind order** (oldest first). An incumbent is
 *      placed before any newcomer, so adding hardware can never move a
 *      server that was covered onto nothing — the newcomer is the one left
 *      out. That is what makes "refuse the connect" honest: the server the
 *      gate names is the one that would go uncovered.
 *   2. Each server takes the **smallest** available tier whose rank is at
 *      least its requirement, unless it has a **preferred tier**: then it
 *      takes a spare seat at that tier, or at the smallest tier above it
 *      with a spare seat, before falling back to rule 2. Spare capacity
 *      above a server's need is fine, but a server is never parked on a
 *      bigger tier while a smaller one it fits would do — except when a
 *      preferred tier or the swap pass (rule 4) lifts it.
 *   3. Unknown hardware (no resources reported yet) requires the entry
 *      rank: the server needs *a* tier, and the smallest will do until it
 *      says otherwise.
 *
 *   4. **Swap pass** (after the greedy pass, so coverage cannot change).
 *      A server's recommended tier (`resolveRecommendedTier`: the harder of
 *      required and the monitored NIC / drive / GPU slots) can exceed the
 *      tier it was placed on. Walking those servers oldest first, each one
 *      trades seats with a server that holds a higher tier and needs none
 *      of it — that server's required AND recommended tiers are both at or
 *      below the first server's placed tier. The first server takes the
 *      smallest such seat that reaches its recommendation (else the largest
 *      below it); the other takes the lower seat, which still covers it.
 *      Repeats until no swap applies. Each swap lifts one server toward its
 *      recommendation and leaves the other where it was recommended, so it
 *      ends, and the result depends only on the inputs (idempotent).
 *      Spare capacity therefore lands on servers that recommend it instead
 *      of sitting on one that recommends less. Unknown recommendation means
 *      "no more than required".
 *
 * Rank is a total order, so the greedy pass covers every server that any
 * assignment could cover for the given order, and the swap pass never
 * uncovers anyone; the coverage gate on every reduction and deferred change
 * runs the same function against the future mix, so the two can never
 * disagree.
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
  /** From `tier-placement`; `null` when hardware is not yet known. */
  requiredRank: number | null
  /** From `resolveRecommendedTier`; `null`/absent when unknown (treated as no more than required). */
  recommendedRank?: number | null
  /** Bind order key: the server row's `created_at`. Ties break on id. */
  boundAt: string
  /** Operator pick (`server.preferred_tier_id`); honored when a spare seat exists at or above it. */
  preferredTierId?: string | null
  preferredRank?: number | null
  /** Label for pick-unfulfilled notices (e.g. `S2`). */
  preferredLabel?: string | null
}>

type PoolEntry = TierQuantity & { left: number }

export type TierAssignment = Readonly<{
  /** `tierId` the server sits on, or `null` when nothing purchased covers it. */
  byServer: ReadonlyMap<string, string | null>
  /** Purchased quantity no server is using, per tier. */
  spare: ReadonlyMap<string, number>
  /** Servers in bind order that ended with no tier. */
  uncovered: readonly string[]
  /** Wanted tier label when a pick could not be honored (fell back below it). */
  pickUnfulfilled: ReadonlyMap<string, string>
}>

export function effectiveRequiredRank(server: Pick<AssignableServer, 'requiredRank'>): number {
  return server.requiredRank ?? ENTRY_TIER_RANK
}

export function effectiveRecommendedRank(
  server: Pick<AssignableServer, 'requiredRank' | 'recommendedRank'>
): number {
  return Math.max(server.recommendedRank ?? 0, effectiveRequiredRank(server))
}

/** Bind order: oldest first, then id, so a recompute is stable. */
export function sortByBindOrder<T extends AssignableServer>(servers: readonly T[]): T[] {
  return [...servers].sort((a, b) => {
    const byBound = a.boundAt.localeCompare(b.boundAt)
    if (byBound !== 0) return byBound
    return a.serverId.localeCompare(b.serverId)
  })
}

function decrementPoolSeat(entry: PoolEntry): void {
  entry.left -= 1
}

function smallestDerivedSeat(pool: readonly PoolEntry[], need: number): PoolEntry | undefined {
  return pool.find((entry) => entry.left > 0 && entry.rank >= need)
}

/** Spare at the picked tier, else the smallest tier above the pick with spare. */
function takePreferredSeat(
  pool: PoolEntry[],
  preferredTierId: string,
  preferredRank: number
): PoolEntry | undefined {
  const exact = pool.find((entry) => entry.tierId === preferredTierId && entry.left > 0)
  if (exact) {
    decrementPoolSeat(exact)
    return exact
  }
  const above = pool.find((entry) => entry.left > 0 && entry.rank > preferredRank)
  if (above) {
    decrementPoolSeat(above)
    return above
  }
  return undefined
}

function recordPickUnfulfilled(
  pickUnfulfilled: Map<string, string>,
  server: AssignableServer,
  placedRank: number | null
): void {
  const want = server.preferredRank
  if (want == null) return
  const label = server.preferredLabel ?? 'that tier'
  if (placedRank == null || placedRank < want) {
    pickUnfulfilled.set(server.serverId, label)
  }
}

function takeSeatForServer(
  pool: PoolEntry[],
  server: AssignableServer,
  pickUnfulfilled: Map<string, string>,
  honoredPreferredPick: Set<string>
): PoolEntry | undefined {
  const need = effectiveRequiredRank(server)
  const wantRank = server.preferredRank ?? null
  if (wantRank != null && server.preferredTierId) {
    const preferred = takePreferredSeat(pool, server.preferredTierId, wantRank)
    if (preferred) {
      honoredPreferredPick.add(server.serverId)
      return preferred
    }
    const derived = smallestDerivedSeat(pool, need)
    if (derived) decrementPoolSeat(derived)
    recordPickUnfulfilled(pickUnfulfilled, server, derived?.rank ?? null)
    return derived
  }
  const derived = smallestDerivedSeat(pool, need)
  if (derived) decrementPoolSeat(derived)
  return derived
}

export function computeAssignment(
  quantities: readonly TierQuantity[],
  servers: readonly AssignableServer[]
): TierAssignment {
  const pool = quantities
    .filter((entry) => entry.quantity > 0)
    .map((entry) => ({ ...entry, left: entry.quantity }))
    .sort((a, b) => a.rank - b.rank)

  const byServer = new Map<string, string | null>()
  const placed = new Map<string, { tierId: string; rank: number }>()
  const pickUnfulfilled = new Map<string, string>()
  const honoredPreferredPick = new Set<string>()
  const uncovered: string[] = []
  const ordered = sortByBindOrder(servers)
  for (const server of ordered) {
    const wantRank = server.preferredRank ?? null
    const slot = takeSeatForServer(pool, server, pickUnfulfilled, honoredPreferredPick)
    if (slot) {
      byServer.set(server.serverId, slot.tierId)
      placed.set(server.serverId, { tierId: slot.tierId, rank: slot.rank })
    } else {
      if (wantRank != null) recordPickUnfulfilled(pickUnfulfilled, server, null)
      byServer.set(server.serverId, null)
      uncovered.push(server.serverId)
    }
  }
  swapTowardRecommended(ordered, placed, honoredPreferredPick)
  reconcilePickUnfulfilled(ordered, placed, pickUnfulfilled)
  for (const [serverId, seat] of placed) byServer.set(serverId, seat.tierId)
  const spare = new Map<string, number>()
  for (const entry of pool) spare.set(entry.tierId, entry.left)
  return { byServer, spare, uncovered, pickUnfulfilled }
}

type Seat = { tierId: string; rank: number }

function fitsBetter(candidate: number, incumbent: number, want: number): boolean {
  if (candidate >= want) return incumbent < want || candidate < incumbent
  return incumbent < want && candidate > incumbent
}

/** Align pick-unfulfilled notices with final seats after the swap pass. */
function reconcilePickUnfulfilled(
  ordered: readonly AssignableServer[],
  placed: ReadonlyMap<string, Seat>,
  pickUnfulfilled: Map<string, string>
): void {
  for (const server of ordered) {
    if (server.preferredRank == null) continue
    const seat = placed.get(server.serverId)
    const placedRank = seat?.rank ?? null
    const want = server.preferredRank
    const label = server.preferredLabel ?? 'that tier'
    if (placedRank == null || placedRank < want) {
      pickUnfulfilled.set(server.serverId, label)
    } else {
      pickUnfulfilled.delete(server.serverId)
    }
  }
}

/** The donor for `server`'s upgrade: holds a higher seat and needs none of it. */
function pickDonor(
  server: AssignableServer,
  ordered: readonly AssignableServer[],
  placed: ReadonlyMap<string, Seat>,
  honoredPreferredPick: ReadonlySet<string>
): AssignableServer | undefined {
  const mine = placed.get(server.serverId)!.rank
  const want = effectiveRecommendedRank(server)
  let best: AssignableServer | undefined
  let bestRank = 0
  for (const other of ordered) {
    const seat = placed.get(other.serverId)
    if (!seat || seat.rank <= mine) continue
    if (honoredPreferredPick.has(other.serverId)) continue
    if (effectiveRecommendedRank(other) > mine) continue
    if (!best || fitsBetter(seat.rank, bestRank, want)) {
      best = other
      bestRank = seat.rank
    }
  }
  return best
}

/** Rule 4: trade seats until no server recommends more than it holds while a donor exists. */
function swapTowardRecommended(
  ordered: readonly AssignableServer[],
  placed: Map<string, Seat>,
  honoredPreferredPick: ReadonlySet<string>
): void {
  let swapped = true
  while (swapped) {
    swapped = false
    for (const server of ordered) {
      const mine = placed.get(server.serverId)
      if (!mine || mine.rank >= effectiveRecommendedRank(server)) continue
      const donor = pickDonor(server, ordered, placed, honoredPreferredPick)
      if (!donor) continue
      const theirs = placed.get(donor.serverId)!
      placed.set(server.serverId, theirs)
      placed.set(donor.serverId, mine)
      swapped = true
    }
  }
}

/**
 * Would this mix leave a server uncovered that is covered today? The gate
 * every reduction and deferred change runs: `null` when the change is
 * safe, otherwise the first server (in bind order) it would strand.
 */
export function coverageLoss(
  current: readonly TierQuantity[],
  proposed: readonly TierQuantity[],
  servers: readonly AssignableServer[]
): { serverId: string; requiredRank: number } | null {
  const before = new Set(computeAssignment(current, servers).uncovered)
  const after = computeAssignment(proposed, servers)
  for (const serverId of after.uncovered) {
    if (before.has(serverId)) continue
    const server = servers.find((entry) => entry.serverId === serverId)
    return {
      serverId,
      requiredRank: server ? effectiveRequiredRank(server) : ENTRY_TIER_RANK,
    }
  }
  return null
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
