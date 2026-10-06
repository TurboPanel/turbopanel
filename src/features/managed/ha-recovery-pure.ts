/**
 * Pure recovery state-machine steps. Durable writes live in recovery-records /
 * ha-recovery; this module stays host-free for coverage.
 */

import type { RecoveryKind, RecoveryMetadata, RecoveryState } from './recovery.ts'
import { automaticFailoverBlockedReason, shouldBlockUnreachablePrimaryFence } from './ha-policy.ts'
import { AUTOMATIC_FAILOVER_BLOCKED_MESSAGE } from './recovery.ts'

export type FenceOutcome = {
  oldPrimaryReachable: boolean
  drainApplied: boolean
  stopApplied: boolean
}

export type RecoveryAdvance =
  | { state: Exclude<RecoveryState, 'blocked'>; metadata: RecoveryMetadata }
  | { state: 'blocked'; metadata: RecoveryMetadata; reason: string }

/**
 * Fail-closed for automatic failover: fencing is proven only when drain
 * succeeded and the old writer was stopped (or drain succeeded and stop was
 * applied on a reachable host).
 */
export function verifyFenced(outcome: Readonly<FenceOutcome>): boolean {
  if (!outcome.drainApplied) return false
  if (outcome.stopApplied) return true
  return false
}

/**
 * After a fence attempt: automatic failover blocks when the old primary is
 * unreachable or fencing cannot be proven. Operator switchover / DR continue.
 */
export function nextStateAfterFence(input: {
  kind: RecoveryKind
  outcome: FenceOutcome
  metadata: RecoveryMetadata
}): RecoveryAdvance {
  const fenced = verifyFenced(input.outcome)
  const metadata: RecoveryMetadata = {
    ...input.metadata,
    fenced,
    fencingEpoch: input.metadata.fencingEpoch ?? new Date().toISOString(),
  }

  if (fenced) {
    return { state: 'promoting', metadata }
  }

  if (shouldBlockUnreachablePrimaryFence(input.kind)) {
    const reason = automaticFailoverBlockedReason('unfenced')
    return {
      state: 'blocked',
      metadata: { ...metadata, blockedReason: reason },
      reason,
    }
  }

  // Operator path: continue with needs_resync semantics.
  return { state: 'promoting', metadata: { ...metadata, fenced: false } }
}

/**
 * Whole-host loss: the old primary's server is silent, so no stop command can
 * prove it is fenced. The caller has already established, from the silence AND
 * from every other member, that the host is gone (`ha-host-loss.ts`), and the
 * old primary is held back when it returns (`ha-return-fence.ts`, the
 * daemon's boot hold). The row goes on to promote with the fence recorded as
 * ATTESTED, never as proven: `fenced` stays false and `verifyFenced` is not
 * consulted, so the engine-dead path still needs its stop.
 */
export function hostLossFenceAdvance(metadata: RecoveryMetadata): RecoveryAdvance {
  return {
    state: 'promoting',
    metadata: {
      ...metadata,
      fenced: false,
      fenceBasis: 'host-loss-attested',
      fencingEpoch: metadata.fencingEpoch ?? new Date().toISOString(),
    },
  }
}

export function nextStateAfterPromoteSuccess(metadata: RecoveryMetadata): RecoveryAdvance {
  return { state: 'repointing', metadata }
}

export function nextStateAfterIngressReconcile(metadata: RecoveryMetadata): RecoveryAdvance {
  return { state: 'verifying', metadata }
}

export function nextStateAfterVerify(input: {
  writerCount: number
  metadata: RecoveryMetadata
}): RecoveryAdvance {
  if (input.writerCount === 1) {
    return { state: 'completed', metadata: input.metadata }
  }
  return {
    state: 'failed',
    metadata: {
      ...input.metadata,
      blockedReason: `expected exactly one writer, observed ${input.writerCount}`,
    },
  }
}

export function blockedCopy(): string {
  return AUTOMATIC_FAILOVER_BLOCKED_MESSAGE
}
