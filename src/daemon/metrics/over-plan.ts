/**
 * Over-plan check: a server that has more RAM or more physical CPU cores than
 * the box size it is licensed for keeps every metric it sends (the sizes are
 * facts, never a reason to refuse a sample) and is flagged on the server
 * record so an operator can see it. Pure, so the hosted ingest route stays
 * small and the rule is unit-testable.
 *
 * Plans limit box size only, in the units the tiers are sold in: physical CPU
 * cores and RAM (`features/tiers/ladder.ts`, `tier-placement.ts` — the same
 * bands the enrolment floor uses). Physical cores are not on the sample (it
 * carries only the logical CPU count, a divisor for saturation); they come
 * from the daemon's host report stored on the server record
 * (`server.metadata.resources`, one entry per socket). RAM is read from the
 * sample's own size when it carries one, else from that host report.
 */
import type { ServerHostResources } from '../../features/servers/server-metadata.ts'
import { cpuBand, ramBand, totalPhysicalCores } from '../../features/tiers/tier-placement.ts'

export type OverPlan = {
  memory: boolean
  cpu: boolean
}

/** `null` when the server has no assigned tier. */
export function evaluateOverPlan(
  tierRank: number | null | undefined,
  resources: ServerHostResources | undefined,
  sampleMemoryTotalBytes: number | null | undefined
): OverPlan | null {
  if (tierRank === null || tierRank === undefined) return null
  const memoryBytes = sampleMemoryTotalBytes ?? resources?.memory?.totalBytes ?? 0
  const cores = resources === undefined ? 0 : totalPhysicalCores(resources)
  return {
    memory: memoryBytes > 0 && ramBand(memoryBytes).rank > tierRank,
    cpu: cores > 0 && cpuBand(cores).rank > tierRank,
  }
}

export function isOverPlan(result: OverPlan | null): boolean {
  return result !== null && (result.memory || result.cpu)
}
