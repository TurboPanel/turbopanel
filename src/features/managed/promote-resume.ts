/**
 * Idempotent resume of a `managed.promote` lost to a daemon restart.
 * Pure helpers — importable from the consumer without pulling HA enqueue.
 */

import type {
  ManagedPromoteCommandPayload,
  ManagedPromoteCommandResult,
} from '../../contracts/commands/schemas.ts'
import type { ManagedMemberRow } from './members.ts'
import type { RecoveryRecord } from './recovery.ts'

/** Sample daemon/engine text for tests (Postgres `pg_promote` on a primary). */
export const ALREADY_WRITABLE_PRIMARY_PROMOTE_ERROR_SAMPLE =
  'recovery mode must be enabled, or must be triggered on a replica'

const ALREADY_WRITABLE_PRIMARY_PATTERNS: readonly RegExp[] = [
  /recovery mode must be enabled/i,
  /must be triggered on a replica/i,
  /not in recovery/i,
  /not in standby/i,
  /already (?:a )?primary/i,
  /already writable/i,
  /cannot promote.*primary/i,
]

export function isAlreadyWritablePrimaryPromoteError(error: string | null | undefined): boolean {
  if (typeof error !== 'string' || error.length === 0) return false
  return ALREADY_WRITABLE_PRIMARY_PATTERNS.some((pattern) => pattern.test(error))
}

export function buildSyntheticPromoteSuccessResult(
  payload: ManagedPromoteCommandPayload
): ManagedPromoteCommandResult {
  return {
    status: 'ready',
    role: 'primary',
    promotedMemberId: payload.memberId,
    demoted: payload.demoteMemberId !== undefined,
    ...(payload.demoteMemberId !== undefined ? { demotedMemberId: payload.demoteMemberId } : {}),
    summary: 'standby already promoted to primary',
  }
}

/**
 * Reasons to decline re-queueing a lost promote. Returns null when resume may
 * proceed (target still a replica, journal row still matches, no stray primary).
 */
export function promoteResumeRequeueRefusal(
  record: RecoveryRecord,
  members: readonly ManagedMemberRow[],
  inflight: RecoveryRecord | null
): 'recovery_mismatch' | 'target_mismatch' | 'stray_primary' | null {
  if (inflight?.id !== record.id) return 'recovery_mismatch'
  if (inflight.targetMemberId !== record.targetMemberId) return 'target_mismatch'
  const sourceId = record.sourcePrimaryMemberId
  const targetId = record.targetMemberId
  if (
    members.some(
      (row) => row.role === 'primary' && row.id !== sourceId && row.id !== targetId
    )
  ) {
    return 'stray_primary'
  }
  return null
}

export function isTargetAlreadyPrimaryInJournal(
  record: RecoveryRecord,
  members: readonly ManagedMemberRow[]
): boolean {
  const targetId = record.targetMemberId
  if (!targetId) return false
  return members.find((row) => row.id === targetId)?.role === 'primary'
}
