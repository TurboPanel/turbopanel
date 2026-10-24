/**
 * MySQL-family planned switchover: prove the promotion target applied the old
 * primary's final GTID position before it is promoted.
 */

import type { ManagedEngineCode } from './types.ts'
import type { RecoveryMetadata } from './recovery.ts'
import type {
  ManagedLifecycleCommandResult,
  ManagedPromoteCommandPayload,
} from '../../contracts/commands/schemas.ts'

export const SWITCHOVER_GTID_WAIT_SECONDS = 90

export type SwitchoverPromoteFailureCode =
  | 'gtid_wait_timeout'
  | 'gtid_wait_error'
  | 'promote_started'
  | 'promote_unconfirmed'
  | 'target_not_running'

const SWITCHOVER_PROMOTE_ERROR_PREFIX = 'switchover_promote:'

export function parseSwitchoverPromoteFailureCode(
  error: string | undefined
): SwitchoverPromoteFailureCode | null {
  if (!error) return null
  const match = new RegExp(
    `^${SWITCHOVER_PROMOTE_ERROR_PREFIX}(gtid_wait_timeout|gtid_wait_error|promote_started|promote_unconfirmed|target_not_running):`
  ).exec(error)
  if (!match) return null
  return match[1] as SwitchoverPromoteFailureCode
}

/**
 * The target itself reported that promotion never started — safe to bring the
 * old primary back. `target_not_running`: the target had no running engine
 * container, so nothing was promoted (any engine). `promote_unconfirmed` (the
 * command went unanswered) is not: the target may be promoting, so the old
 * primary stays fenced.
 */
export function switchoverPromoteFailureShouldReactivateOldPrimary(
  code: SwitchoverPromoteFailureCode | null
): boolean {
  return code === 'gtid_wait_timeout' || code === 'gtid_wait_error' || code === 'target_not_running'
}

export function switchoverPromoteTimedOutCommandError(message: string): string {
  return `${SWITCHOVER_PROMOTE_ERROR_PREFIX}promote_unconfirmed: ${message}`
}

const MYSQL_FAMILY: ReadonlySet<ManagedEngineCode> = new Set(['mysql', 'mariadb'])

export function engineNeedsSwitchoverGtidProof(engine: ManagedEngineCode): boolean {
  return MYSQL_FAMILY.has(engine)
}

export function fenceStopCapturesSwitchoverGtid(kind: string, engine: ManagedEngineCode): boolean {
  return kind === 'switchover' && engineNeedsSwitchoverGtidProof(engine)
}

export function switchoverGtidFromFenceStopResult(
  result: ManagedLifecycleCommandResult
): string | null {
  const gtid = result.switchoverPrimaryExecutedGtidSet
  if (typeof gtid !== 'string' || gtid.length === 0 || gtid.length > 4096) {
    return null
  }
  return gtid
}

export function recordSwitchoverRequiredGtid(
  metadata: RecoveryMetadata,
  gtidSet: string
): RecoveryMetadata {
  return {
    ...metadata,
    switchoverRequiredGtidSet: gtidSet,
  }
}

function attachSwitchoverGtidToPayload<
  T extends {
    requiredExecutedGtidSet?: string
    gtidWaitTimeoutSeconds?: number
  },
>(payload: T, metadata: RecoveryMetadata): T {
  const gtid = metadata.switchoverRequiredGtidSet
  if (!gtid) return payload
  return {
    ...payload,
    requiredExecutedGtidSet: gtid,
    gtidWaitTimeoutSeconds: SWITCHOVER_GTID_WAIT_SECONDS,
  }
}

export function promotePayloadWithSwitchoverCatchup(
  payload: ManagedPromoteCommandPayload,
  metadata: RecoveryMetadata
): ManagedPromoteCommandPayload {
  return attachSwitchoverGtidToPayload(payload, metadata)
}

export function failoverRecoverPayloadWithSwitchoverCatchup<
  T extends {
    requiredExecutedGtidSet?: string
    gtidWaitTimeoutSeconds?: number
  },
>(payload: T, metadata: RecoveryMetadata): T {
  return attachSwitchoverGtidToPayload(payload, metadata)
}

export function switchoverAbortReactivateLifecyclePayload(params: {
  managedId: string
  memberId: string
  engine: ManagedEngineCode
}): {
  managedId: string
  action: 'start'
  memberId: string
  engine: ManagedEngineCode
  role: 'primary'
  reactivateAfterSwitchoverAbort: true
  switchoverAbortPromoteSafe: true
} {
  return {
    managedId: params.managedId,
    action: 'start',
    memberId: params.memberId,
    engine: params.engine,
    role: 'primary',
    reactivateAfterSwitchoverAbort: true,
    // Callers use this only where no promote was queued or the target itself
    // reported that promotion never started.
    switchoverAbortPromoteSafe: true,
  }
}
