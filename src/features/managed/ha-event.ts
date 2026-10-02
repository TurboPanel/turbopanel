/**
 * Daemon-observed HA events (DeadPrimary). Creates or resumes a recovery
 * journal row and, when a command queue is available, starts automatic
 * failover. Workers without a queue persist detecting/blocked only.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { environment, managed, project, server } from '../../db/schema.ts'
import { isManagedEngineCode } from './types.ts'
import type { RecoveryRecord } from './recovery.ts'
import { beginAutomaticFailover } from './ha-recovery.ts'
import { listManagedMembers } from './members.ts'
import { haEventRejection } from './ha-policy.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'

export type ManagedHaEventInput = {
  managedId: string
  sourceMemberId?: string
  /** Absent = Orchestrator. See `ha-policy.ts` → `AUTOMATIC_FAILOVER_DETECTORS`. */
  detector?: string
  /** Bounded detector evidence: logged and recorded, never used to decide. */
  evidence?: Record<string, unknown>
  at?: string
}

const MAX_EVIDENCE_LOG_CHARS = 600

function evidenceText(evidence: Record<string, unknown> | undefined): string {
  if (!evidence) return ''
  let text: string
  try {
    text = JSON.stringify(evidence)
  } catch {
    return ''
  }
  return text.length > MAX_EVIDENCE_LOG_CHARS ? text.slice(0, MAX_EVIDENCE_LOG_CHARS) : text
}

async function loadCluster(
  db: Db,
  managedId: string
): Promise<{ id: string; engine: string | null; organizationId: string | null } | null> {
  const [row] = await db
    .select({
      id: managed.id,
      engine: managed.engine,
      organizationId: project.organizationId,
    })
    .from(managed)
    .innerJoin(environment, eq(managed.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(managed.id, managedId))
    .limit(1)
  return row ?? null
}

async function loadServerOrganization(db: Db, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.organizationId ?? null
}

/**
 * `deps.reporterServerId` must be the authenticated session's server id
 * (the cell attachment), never a payload field: the gate trusts it to prove
 * which host sent the event.
 */
export async function handleManagedHaEvent(
  db: Db,
  input: ManagedHaEventInput,
  deps: {
    commandQueue?: CommandQueue
    reporterServerId: string
  }
): Promise<RecoveryRecord | null> {
  const row = await loadCluster(db, input.managedId)
  if (!row) return null
  if (!row.engine || !isManagedEngineCode(row.engine)) return null
  const engine = row.engine

  const members = await listManagedMembers(db, row.id)
  if (members.length === 0) return null

  const reporterOrganizationId = await loadServerOrganization(db, deps.reporterServerId)
  const primary = members.find((member) => member.role === 'primary') ?? null
  const rejection = haEventRejection({
    detector: input.detector,
    engine,
    sourceMemberId: input.sourceMemberId,
    reporterServerId: deps.reporterServerId,
    reporterOrganizationId,
    clusterOrganizationId: row.organizationId,
    memberServerIds: members.map((member) => member.serverId),
    primary,
  })
  const evidence = evidenceText(input.evidence)
  if (rejection) {
    compatLogWarn(
      'managed-ha',
      `ignored managed-ha-event for ${row.id} from server ${deps.reporterServerId}: ${rejection}`
    )
    return null
  }
  compatLogInfo(
    'managed-ha',
    `accepted managed-ha-event for ${row.id} from server ${deps.reporterServerId} detector=${
      input.detector ?? 'orchestrator'
    }${evidence ? ` evidence=${evidence}` : ''}`
  )

  return beginAutomaticFailover({
    db,
    commandQueue: deps.commandQueue ?? null,
    managedId: row.id,
    engine,
    members,
    sourceMemberId: input.sourceMemberId,
    ...(input.detector ? { detector: input.detector } : {}),
    ...(evidence ? { evidence } : {}),
    actor: { actorType: 'system', actorId: deps.reporterServerId },
  })
}
