/**
 * TurboPanel-owned HA candidate policy. Orchestrator discovers topology and
 * executes a designated recover; it must not pick the candidate.
 *
 * `readEligible` has zero effect on automatic promotion.
 */

import type { RecoveryKind } from './recovery.ts'
import {
  AUTOMATIC_FAILOVER_BLOCKED_MESSAGE,
  AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE,
  AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE,
} from './recovery.ts'

export const HA_PROMOTION_RULE_PREFER = 'prefer'
export const HA_PROMOTION_RULE_MUST_NOT = 'must_not'

export type HaPromotionRule =
  | typeof HA_PROMOTION_RULE_PREFER
  | typeof HA_PROMOTION_RULE_MUST_NOT

export type HaMemberCandidateInput = {
  id: string
  role: string
  replicaClass: string | null
  ordinal: number
  sameDatacenterAsPrimary: boolean
  /** Streaming, fresh, and under the promote lag threshold. */
  healthy: boolean
}

/**
 * Same-DC `failover` class, ignoring health. Used to distinguish "none
 * exist" from "none are healthy enough" when blocking automatic failover.
 */
export function isAutomaticFailoverClassMember(
  member: Readonly<HaMemberCandidateInput>,
): boolean {
  return member.role === 'replica' &&
    member.replicaClass === 'failover' &&
    member.sameDatacenterAsPrimary
}

/**
 * Same-DC `failover` replicas may auto-promote when healthy. `read` replicas
 * never do. Cross-datacenter is disaster recovery only (operator route).
 * `readEligible` has zero effect.
 */
export function isAutomaticFailoverCandidate(
  member: Readonly<HaMemberCandidateInput>,
): boolean {
  return isAutomaticFailoverClassMember(member) && member.healthy
}

/**
 * Deterministic pick: lowest ordinal among automatic candidates.
 * `readEligible` is ignored.
 */
export function pickAutomaticFailoverCandidate(
  members: readonly HaMemberCandidateInput[],
): HaMemberCandidateInput | null {
  const eligible = members
    .filter((member) => isAutomaticFailoverCandidate(member))
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
  return eligible[0] ?? null
}

/**
 * Why automatic failover cannot pick a candidate. `null` when a pick exists.
 */
export function automaticFailoverBlockCause(
  members: readonly HaMemberCandidateInput[],
): 'no-candidate' | 'unhealthy' | null {
  if (pickAutomaticFailoverCandidate(members)) return null
  return members.some((member) => isAutomaticFailoverClassMember(member))
    ? 'unhealthy'
    : 'no-candidate'
}

export function orchestratorPromotionRule(
  replicaClass: string | null,
): HaPromotionRule {
  return replicaClass === 'failover'
    ? HA_PROMOTION_RULE_PREFER
    : HA_PROMOTION_RULE_MUST_NOT
}

/**
 * Automatic failover must not continue when the old primary cannot be fenced.
 * Operator switchover and disaster recovery may continue (`needs_resync`).
 */
export function shouldBlockUnreachablePrimaryFence(kind: RecoveryKind): boolean {
  return kind === 'automatic-failover'
}

export function automaticFailoverBlockedReason(
  cause: 'unfenced' | 'no-candidate' | 'unhealthy',
): string {
  if (cause === 'no-candidate') return AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE
  if (cause === 'unhealthy') return AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE
  return AUTOMATIC_FAILOVER_BLOCKED_MESSAGE
}

/**
 * After disaster recovery, members that no longer share a datacenter with the
 * new primary cannot stay `failover`. Same-DC `read` peers are never silently
 * upgraded.
 */
export function replicaClassAfterDisasterRecovery(input: {
  role: string
  replicaClass: string | null
  sameDatacenterAsNewPrimary: boolean
}): 'failover' | 'read' | null {
  if (input.role === 'primary') return null
  if (input.replicaClass === 'failover' && !input.sameDatacenterAsNewPrimary) {
    return 'read'
  }
  if (input.replicaClass === 'failover' || input.replicaClass === 'read') {
    return input.replicaClass
  }
  return 'read'
}

/** Primary and same-DC failover replicas join the org Orchestrator Raft group. */
export function serverHostsManagedHa(
  membersOnServer: ReadonlyArray<{ role: string; replicaClass: string | null }>,
): boolean {
  return membersOnServer.some((member) =>
    member.role === 'primary' || member.replicaClass === 'failover'
  )
}

export function pickHaAdvertiseAddress(
  pins: ReadonlyArray<{ address: string; family: 4 | 6 }>,
): string | null {
  const v4 = pins.find((pin) => pin.family === 4)
  return v4?.address ?? pins[0]?.address ?? null
}
