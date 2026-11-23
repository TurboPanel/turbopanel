/**
 * Store the two WAL positions of a planned Postgres switchover on its
 * recovery row, where `evaluateFinalPosition` and the re-seed read them.
 *
 * The old primary's final position arrives with the stop result and the new
 * primary's replay position with the promote result. Both are validated
 * strictly here (a malformed value is dropped, which leaves the re-seed
 * failing closed), only a Postgres switchover keeps them, and nothing is
 * changed once the re-seed has been decided.
 */

import type { Db } from '../../db/connection.ts'
import { parseWalPosition } from '../../contracts/commands/schemas.ts'
import { updateRecoveryLocked } from './recovery-records.ts'
import type { RecoveryMetadata, RecoveryRecord } from './recovery.ts'

type Position = { lsn: string; timeline: number }
type PositionPatch = Pick<
  RecoveryMetadata,
  'oldPrimaryFinalLsn' | 'oldPrimaryFinalTimeline' | 'newPrimaryReplayLsn' | 'newPrimaryTimeline'
>

async function recordPosition(
  db: Db,
  recoveryId: string,
  input: { engine: string; lsn?: string; timeline?: number },
  patch: (position: Position) => PositionPatch
): Promise<void> {
  if (input.engine !== 'postgres') return
  const position = parseWalPosition(input.lsn, input.timeline)
  if (position === undefined) return
  await updateRecoveryLocked(db, recoveryId, (current: RecoveryRecord) => {
    if (current.kind !== 'switchover') return null
    if (current.metadata.reseedState !== undefined) return null
    return { metadata: { ...current.metadata, ...patch(position) } }
  })
}

/** The stop result of the old primary: where its WAL ends after the clean shutdown. */
export function recordOldPrimaryFinalPosition(
  db: Db,
  recoveryId: string,
  input: { engine: string; lsn: string; timeline: number }
): Promise<void> {
  return recordPosition(db, recoveryId, input, (position) => ({
    oldPrimaryFinalLsn: position.lsn,
    oldPrimaryFinalTimeline: position.timeline,
  }))
}

/** The promote result of the new primary: what it had replayed, and its timeline. */
export function recordNewPrimaryReplayPosition(
  db: Db,
  recoveryId: string,
  input: { engine: string; lsn?: string; timeline?: number }
): Promise<void> {
  return recordPosition(db, recoveryId, input, (position) => ({
    newPrimaryReplayLsn: position.lsn,
    newPrimaryTimeline: position.timeline,
  }))
}

/**
 * Postgres planned switchover: ask the fence stop for the old primary's final
 * write position, stamped with this recovery and the primary epoch the
 * switchover began at. Any other recovery sends nothing.
 */
export function finalPositionStopFields(params: {
  recovery: RecoveryRecord
  engine: string
}): { switchoverRecoveryId: string; primaryEpoch: number } | Record<string, never> {
  const epoch = params.recovery.metadata.primaryEpochAtStart
  if (params.recovery.kind !== 'switchover' || params.engine !== 'postgres') return {}
  if (epoch === undefined) return {}
  return { switchoverRecoveryId: params.recovery.id, primaryEpoch: epoch }
}
