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

const SWITCHOVER_PROMOTE_ERROR_PREFIX = 'switchover_promote:'

export function parseSwitchoverPromoteFailureCode(
  error: string | undefined
): SwitchoverPromoteFailureCode | null {
  if (!error) return null
  const match = /^switchover_promote:(gtid_wait_timeout|gtid_wait_error|promote_started):/.exec(
    error
  )
  if (!match) return null
  return match[1] as SwitchoverPromoteFailureCode
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
} {
  return {
    managedId: params.managedId,
    action: 'start',
    memberId: params.memberId,
    engine: params.engine,
    role: 'primary',
    reactivateAfterSwitchoverAbort: true,
  }
}
