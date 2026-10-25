/**
 * The queued wipe of a former primary must not run once the switchover that
 * justified it has been overtaken. The panel re-checks just before the command
 * is sent: the new primary must still be the ready primary, the former primary
 * must still be a replica, the switchover must still be the latest recovery of
 * the cluster, and the primary epoch must be the one the wipe was queued at.
 * The same recovery id and epoch travel in the `managed.apply` payload
 * (`switchoverReseed`), where a host that listed
 * `managed-switchover-final-position-v1` refuses a stale wipe before it
 * touches the data directory (`turbopaneld/src/managed/switchover-final-position.ts`).
 */

import { isManagedPrimaryEpoch } from '../../contracts/commands/schemas.ts'
import type { Db } from '../../db/connection.ts'
import { listManagedMembers } from './members.ts'
import { loadPrimaryEpoch } from './primary-epoch.ts'
import { findLatestRecovery } from './recovery-records.ts'

export const RESEED_GUARD_METADATA_KEY = 'switchoverReseed'

export type ReseedGuard = {
  recoveryId: string
  managedId: string
  sourceMemberId: string
  targetMemberId: string
  /** Primary epoch at queue time; absent or invalid means the wipe cannot be proven current. */
  epoch?: number
}

export function parseReseedGuard(metadata: unknown): ReseedGuard | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const raw = (metadata as Record<string, unknown>)[RESEED_GUARD_METADATA_KEY]
  if (typeof raw !== 'object' || raw === null) return null
  const g = raw as Record<string, unknown>
  if (
    typeof g.recoveryId !== 'string' ||
    typeof g.managedId !== 'string' ||
    typeof g.sourceMemberId !== 'string' ||
    typeof g.targetMemberId !== 'string'
  ) {
    return null
  }
  return {
    recoveryId: g.recoveryId,
    managedId: g.managedId,
    sourceMemberId: g.sourceMemberId,
    targetMemberId: g.targetMemberId,
    ...(isManagedPrimaryEpoch(g.epoch) ? { epoch: g.epoch } : {}),
  }
}

/** Why the wipe must not run now, or null when it still may. */
export async function reseedSupersededReason(db: Db, guard: ReseedGuard): Promise<string | null> {
  const members = await listManagedMembers(db, guard.managedId)
  const target = members.find((row) => row.id === guard.targetMemberId)
  const source = members.find((row) => row.id === guard.sourceMemberId)
  if (target?.role !== 'primary' || target.status !== 'ready') {
    return 'the new primary is no longer the ready primary'
  }
  if (source?.role !== 'replica') return 'the former primary is no longer a replica'
  const latest = await findLatestRecovery(db, guard.managedId)
  if (latest?.id !== guard.recoveryId) return 'another recovery started after the switchover'
  if (guard.epoch === undefined) return 'the re-seed carries no valid primary epoch'
  if ((await loadPrimaryEpoch(db, guard.managedId)) !== guard.epoch) {
    return 'the primary changed after the re-seed was queued'
  }
  return null
}
