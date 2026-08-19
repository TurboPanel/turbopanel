/**
 * Control-plane HA authority. Orchestrator HTTP stays on the daemon; this
 * module is TurboPanel policy only — candidate selection, promotion rules,
 * and whether Orchestrator should execute recover vs engine.promote.
 */

import {
  isAutomaticFailoverCandidate,
  orchestratorPromotionRule,
  pickAutomaticFailoverCandidate,
  replicaClassAfterDisasterRecovery,
  type HaMemberCandidateInput,
  type HaPromotionRule,
} from '../../lib/managed/ha-policy.ts'

export type ManagedHaAuthority = {
  pickAutomaticCandidate(
    members: readonly HaMemberCandidateInput[],
  ): HaMemberCandidateInput | null
  isAutomaticCandidate(member: HaMemberCandidateInput): boolean
  promotionRule(replicaClass: string | null): HaPromotionRule
  shouldUseOrchestrator(haPresent: boolean): boolean
  replicaClassAfterDisasterRecovery(input: {
    role: string
    replicaClass: string | null
    sameDatacenterAsNewPrimary: boolean
  }): 'failover' | 'read' | null
}

export const OrchestratorManagedHaAuthority: ManagedHaAuthority = {
  pickAutomaticCandidate: pickAutomaticFailoverCandidate,
  isAutomaticCandidate: isAutomaticFailoverCandidate,
  promotionRule: orchestratorPromotionRule,
  shouldUseOrchestrator: (haPresent) => haPresent,
  replicaClassAfterDisasterRecovery,
}

export default OrchestratorManagedHaAuthority
