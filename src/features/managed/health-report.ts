/**
 * Store a daemon's `managed-health-report`: the fresh replication reading of
 * every managed replica the reporting host runs, pushed every 30 s
 * (feature `managed-health-report-v1`), so health does not wait for a person
 * to press Refresh and a replica that stops answering shows up as down.
 *
 * Only the reporter's own replicas are written: the row must belong to the
 * named cluster AND live on the reporting server, so a daemon can never write
 * another server's member. Like the on-demand probe it writes replication
 * only (never `replica.status`), drops `lastStreaming` (only meaningful at
 * probe time), and never trusts a reading time in the future.
 */

import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { replica } from '../../db/schema.ts'
import type { ManagedHealthReportMember } from '../../contracts/cell-protocol.ts'
import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { updateManagedMemberDisplayReplication } from './members.ts'

export type ManagedHealthReportOutcome = { stored: number; ignored: number }

function readingFromReport(
  entry: ManagedHealthReportMember,
  receivedAtMs: number
): ManagedReplicationHealth {
  const receivedAt = new Date(receivedAtMs).toISOString()
  if (entry.down || !entry.replication) {
    return { state: 'not_streaming', observedAt: receivedAt }
  }
  const reading = { ...entry.replication }
  delete reading.lastStreaming
  const observedMs = Date.parse(reading.observedAt)
  // A daemon clock ahead of ours must not make a reading look newer than it is.
  return observedMs > receivedAtMs ? { ...reading, observedAt: receivedAt } : reading
}

export async function handleManagedHealthReport(
  db: Db,
  params: {
    reporterServerId: string
    members: readonly ManagedHealthReportMember[]
    nowMs?: number
  }
): Promise<ManagedHealthReportOutcome> {
  const receivedAtMs = params.nowMs ?? Date.now()
  const ids = [...new Set(params.members.map((entry) => entry.memberId))]
  if (ids.length === 0) return { stored: 0, ignored: 0 }

  const rows = await db
    .select({
      id: replica.id,
      managedId: replica.managedId,
      serverId: replica.serverId,
      role: replica.role,
    })
    .from(replica)
    .where(inArray(replica.id, ids))
  const byId = new Map(rows.map((row) => [row.id, row]))

  let stored = 0
  let ignored = 0
  await forEachSequential(params.members, async (entry) => {
    const row = byId.get(entry.memberId)
    const ours =
      row?.managedId === entry.managedId &&
      row.serverId === params.reporterServerId &&
      row.role === 'replica'
    if (!ours) {
      ignored += 1
      return
    }
    await updateManagedMemberDisplayReplication(
      db,
      entry.memberId,
      readingFromReport(entry, receivedAtMs)
    )
    stored += 1
  })
  return { stored, ignored }
}
