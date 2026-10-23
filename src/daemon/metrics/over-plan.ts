/**
 * Over-plan check: a server that has more RAM or more physical CPU cores than
 * the box size it is licensed for keeps every metric it sends (the sizes are
 * facts, never a reason to refuse a sample) and is flagged on the server
 * record so an operator can see it. Pure, so the hosted ingest route stays
 * small and the rule is unit-testable.
 *
 * Plans limit box size only, in the units the tiers are sold in: physical CPU
 * cores and RAM (`features/tiers/ladder.ts`, `tier-placement.ts` — the same
 * bands the enrolment floor uses). Both numbers come from one source, the
 * daemon's host report stored on the server record (`server.metadata.resources`:
 * one entry per socket, plus total RAM). The sample's own sizes are not used:
 * they can move with ballooning, and mixing two sources would flip the flag
 * (and write the row) on every sample near a limit.
 */
import type { ServerPeak } from '../../features/servers/peak.ts'
import type { ServerHostResources } from '../../features/servers/server-metadata.ts'
import { cpuBand, ramBand, totalPhysicalCores } from '../../features/tiers/tier-placement.ts'

export type OverPlan = {
  memory: boolean
  cpu: boolean
}

/** `null` when the server has no assigned tier. */
export function evaluateOverPlan(
  tierRank: number | null | undefined,
  resources: ServerHostResources | undefined
): OverPlan | null {
  return judgeOverPlan(
    tierRank,
    resources?.memory?.totalBytes ?? 0,
    resources === undefined ? 0 : totalPhysicalCores(resources)
  )
}

/**
 * The same verdict from the highest readings of the grace window (`peak`
 * table, `features/servers/peak.ts`) instead of the latest host report, so one
 * low sample after a balloon or a hot-add never clears it. `null` peak means no
 * reading in the window: nothing to judge against, so never over plan.
 */
export function evaluateOverPlanFromPeak(
  tierRank: number | null | undefined,
  peak: ServerPeak | null
): OverPlan | null {
  return judgeOverPlan(tierRank, peak?.memoryBytes ?? 0, peak?.cores ?? 0)
}

function judgeOverPlan(
  tierRank: number | null | undefined,
  memoryBytes: number,
  cores: number
): OverPlan | null {
  if (tierRank === null || tierRank === undefined) return null
  return {
    memory: memoryBytes > 0 && ramBand(memoryBytes).rank > tierRank,
    cpu: cores > 0 && cpuBand(cores).rank > tierRank,
  }
}

export function isOverPlan(result: OverPlan | null): boolean {
  return result !== null && (result.memory || result.cpu)
}
