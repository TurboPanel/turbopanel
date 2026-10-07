/**
 * Over-plan check for a sample's own sizes: a server that reports more RAM or
 * more CPUs than the box size it is licensed for keeps every metric it sends
 * (the sizes are facts, never a reason to refuse a sample) and is flagged on
 * the server record so an operator can see it. Pure, so the hosted ingest
 * route stays small and the rule is unit-testable.
 *
 * Plans limit box size only. The comparison is against the assigned tier's
 * placement ceilings (`features/tiers/ladder.ts`). CPUs are reported as logical
 * CPUs, so the ceiling is doubled before a server counts as over it: an
 * 8-core, 16-thread machine is an 8-core machine, not an over-plan one.
 */
import type { ExtendedSizes } from '../../contracts/metrics-contract.ts'
import { LADDER } from '../../features/tiers/ladder.ts'

/** Logical CPUs per physical core allowed before a server counts as over its plan. */
const MAX_THREADS_PER_CORE = 2

export type OverPlan = {
  memory: boolean
  cpu: boolean
}

/** `null` when the server has no assigned tier or the sample carries no sizes to judge. */
export function evaluateOverPlan(
  tierRank: number | null | undefined,
  sizes: ExtendedSizes | undefined
): OverPlan | null {
  if (tierRank === null || tierRank === undefined || sizes === undefined) return null
  const tier = LADDER.find((entry) => entry.rank === tierRank)
  if (tier === undefined) return null
  const memory = sizes.memoryTotalBytes
  const cores = sizes.logicalCores
  return {
    memory: typeof memory === 'number' && memory > tier.maxMemoryBytes,
    cpu: typeof cores === 'number' && cores > tier.maxCores * MAX_THREADS_PER_CORE,
  }
}

export function isOverPlan(result: OverPlan | null): boolean {
  return result !== null && (result.memory || result.cpu)
}
