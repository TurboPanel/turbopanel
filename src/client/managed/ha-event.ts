/**
 * Daemon-observed HA events (DeadPrimary). Creates or resumes a recovery
 * journal row and, when a command queue is available, starts automatic
 * failover. Workers without a queue persist detecting/blocked only.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { managed } from '../../lib/db/schema.ts'
import { isManagedEngineCode } from '../../lib/managed/types.ts'
import type { RecoveryRecord } from '../../lib/managed/recovery.ts'
import { beginAutomaticFailover } from './ha-recovery.ts'
import { listManagedMembers } from './members.ts'

export type ManagedHaEventInput = {
  managedId: string
  sourceMemberId?: string
  at?: string
}

export async function handleManagedHaEvent(
  db: Db,
  input: ManagedHaEventInput,
  deps: {
    commandQueue?: CommandQueue
    reporterServerId: string
  },
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

  return beginAutomaticFailover({
    db,
    commandQueue: deps.commandQueue ?? null,
    managedId: row.id,
    engine: row.engine,
    members,
    sourceMemberId: input.sourceMemberId,
    actor: { actorType: 'system', actorId: deps.reporterServerId },
  })
}
