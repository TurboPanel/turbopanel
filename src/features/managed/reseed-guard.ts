/**
 * The queued wipe of a former primary must not run once the switchover that
 * justified it has been overtaken. The host cannot tell (the payload carries
 * no recovery id or epoch), so the panel re-checks just before the command is
 * sent: the new primary must still be the ready primary, the former primary
 * must still be a replica, and the switchover must still be the latest
 * recovery of the cluster.
 */

import type { Db } from '../../db/connection.ts'
import { listManagedMembers } from './members.ts'
import { findLatestRecovery } from './recovery-records.ts'

export const RESEED_GUARD_METADATA_KEY = 'switchoverReseed'

export type ReseedGuard = {
  recoveryId: string
  managedId: string
  sourceMemberId: string
  targetMemberId: string
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
  return null
}
