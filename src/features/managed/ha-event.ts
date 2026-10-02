/**
 * Daemon-observed HA events (DeadPrimary). Creates or resumes a recovery
 * journal row and, when a command queue is available, starts automatic
 * failover. Workers without a queue persist detecting/blocked only.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { managed } from '../../db/schema.ts'
import { isManagedEngineCode } from './types.ts'
import type { RecoveryRecord } from './recovery.ts'
import { beginAutomaticFailover } from './ha-recovery.ts'
import { listManagedMembers } from './members.ts'
import { haEventRejection } from './ha-policy.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'

export type ManagedHaEventInput = {
  managedId: string
  sourceMemberId?: string
  /** Absent = Orchestrator. See `ha-policy.ts` → `AUTOMATIC_FAILOVER_DETECTORS`. */
  detector?: string
  at?: string
}

export async function handleManagedHaEvent(
  db: Db,
  input: ManagedHaEventInput,
  deps: {
    commandQueue?: CommandQueue
    reporterServerId: string
  }
): Promise<RecoveryRecord | null> {
  const [row] = await db
    .select({
      id: managed.id,
      engine: managed.engine,
    })
    .from(managed)
    .where(eq(managed.id, input.managedId))
    .limit(1)
  if (!row) return null
  if (!row.engine || !isManagedEngineCode(row.engine)) return null

  const members = await listManagedMembers(db, row.id)
  if (members.length === 0) return null

  const primary = members.find((member) => member.role === 'primary') ?? null
  const rejection = haEventRejection({
    detector: input.detector,
    engine: row.engine,
    sourceMemberId: input.sourceMemberId,
    reporterServerId: deps.reporterServerId,
    primary,
  })
  if (rejection) {
    compatLogWarn(
      'managed-ha',
      `ignored managed-ha-event for ${row.id} from server ${deps.reporterServerId}: ${rejection}`
    )
    return null
  }

  return beginAutomaticFailover({
    db,
    commandQueue: deps.commandQueue ?? null,
    managedId: row.id,
    engine: row.engine,
    members,
    sourceMemberId: input.sourceMemberId,
    ...(input.detector ? { detector: input.detector } : {}),
    actor: { actorType: 'system', actorId: deps.reporterServerId },
  })
}
