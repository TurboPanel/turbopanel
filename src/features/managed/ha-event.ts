/**
 * Daemon-observed HA events (DeadPrimary). Creates or resumes a recovery
 * journal row and, when a command queue is available, starts automatic
 * failover. Both transports pass one (Deno's queue; the Durable Object's
 * `TURBOPANEL_COMMAND_QUEUE` binding); without it a terminal blocked row is
 * recorded.
 *
 * For Postgres, a failover replica that is no longer streaming is probed at
 * event time (`deps.probeStandby`) and judged by the fresh-standby gate
 * (`ha-fresh-standby.ts`), anchored on the detector's failure span.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { environment, managed, project, server } from '../../db/schema.ts'
import { isManagedEngineCode } from './types.ts'
import type { RecoveryRecord } from './recovery.ts'
import { beginAutomaticFailover, recordStaleDeadPrimaryReport } from './ha-recovery.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { haMemberDialForReporter } from './ha-desired.ts'
import { getManagedEngineSpec } from './index.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { MANAGED_HA_INSTANCE_FEATURE } from '../../lib/version-wire.ts'
import {
  haEventRejection,
  ORCHESTRATOR_DETECTOR,
  orchestratorBindingRejection,
} from './ha-policy.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import type { AutoFailoverSetting } from './auto-failover-switch.ts'
import { failureStartedAtMs, type FreshStandbyProbe } from './ha-fresh-standby.ts'

export type ManagedHaEventInput = {
  managedId: string
  sourceMemberId?: string
  /** Absent = Orchestrator. See `ha-policy.ts` → `AUTOMATIC_FAILOVER_DETECTORS`. */
  detector?: string
  /** Orchestrator's key for the dead instance (`managed-ha-instance-v1`). */
  instanceHost?: string
  instancePort?: number
  /**
   * Bounded detector evidence: logged and recorded. Only `spanMs` (the
   * detector's monotonic failure span) is used, to anchor the fresh-standby
   * gate's failure start; a missing or bad span keeps that gate closed.
   */
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

/** Lookups behind the Orchestrator binding check (test seam). */
export type HaBindingLoaders = {
  reporterBindsInstance: (db: Db, serverId: string) => Promise<boolean>
  primaryDial: (
    db: Db,
    reporterServerId: string,
    engine: string,
    primary: ManagedMemberRow | null
  ) => Promise<{ host: string; port: number } | null>
}

async function reporterBindsInstance(db: Db, serverId: string): Promise<boolean> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features?.includes(MANAGED_HA_INSTANCE_FEATURE) === true
}

async function currentPrimaryDial(
  db: Db,
  reporterServerId: string,
  engine: string,
  primary: ManagedMemberRow | null
): Promise<{ host: string; port: number } | null> {
  const spec = getManagedEngineSpec(engine)
  if (!primary || !spec) return null
  const dial = await haMemberDialForReporter(db, reporterServerId, primary, spec.defaultPort)
  return dial ? { host: dial.host, port: dial.port } : null
}

const DEFAULT_BINDING_LOADERS: HaBindingLoaders = {
  reporterBindsInstance,
  primaryDial: currentPrimaryDial,
}

/**
 * Orchestrator reports must name the CURRENT primary (by the address and port
 * its Orchestrator knows it by) once the daemon can say which instance died.
 */
async function staleOrchestratorReason(
  db: Db,
  input: ManagedHaEventInput,
  ctx: {
    reporterServerId: string
    engine: string
    primary: ManagedMemberRow | null
    loaders: HaBindingLoaders
  }
): Promise<string | null> {
  if ((input.detector ?? ORCHESTRATOR_DETECTOR) !== ORCHESTRATOR_DETECTOR) return null
  const bindsInstance = await ctx.loaders.reporterBindsInstance(db, ctx.reporterServerId)
  const named = input.instanceHost !== undefined && input.instancePort !== undefined
  const expectedPrimary = named
    ? await ctx.loaders.primaryDial(db, ctx.reporterServerId, ctx.engine, ctx.primary)
    : null
  return orchestratorBindingRejection({
    reporterBindsInstance: bindsInstance,
    instanceHost: input.instanceHost,
    instancePort: input.instancePort,
    expectedPrimary,
  })
}

/** Only the detector / evidence fields that are actually present. */
function detectorAndEvidence(
  detector: string | undefined,
  evidence: string | undefined
): { detector?: string; evidence?: string } {
  return {
    ...(detector ? { detector } : {}),
    ...(evidence ? { evidence } : {}),
  }
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
    /** `TURBOPANEL_AUTO_FAILOVER`, resolved by the transport; absent = `on`. */
    autoFailover?: AutoFailoverSetting
    /** Event-time probe of a candidate standby; absent = never probe. */
    probeStandby?: FreshStandbyProbe
    /** Fresh-standby receipt margin in ms; absent = 10 s. */
    freshStandbyMarginMs?: number
    /** Test seam: control-plane ms the event was received. */
    nowMs?: () => number
    /** Test seam for the Orchestrator binding lookups. */
    binding?: HaBindingLoaders
  }
): Promise<RecoveryRecord | null> {
  const receivedAtMs = (deps.nowMs ?? Date.now)()
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
  const stale = await staleOrchestratorReason(db, input, {
    reporterServerId: deps.reporterServerId,
    engine,
    primary,
    loaders: deps.binding ?? DEFAULT_BINDING_LOADERS,
  })
  if (stale) {
    return recordStaleDeadPrimaryReport({
      db,
      managedId: row.id,
      members,
      reason: stale,
      ...detectorAndEvidence(input.detector, evidence),
    })
  }
  const detectorName = input.detector ?? 'orchestrator'
  const evidenceSuffix = evidence ? ` evidence=${evidence}` : ''
  compatLogInfo(
    'managed-ha',
    `accepted managed-ha-event for ${row.id} from server ${deps.reporterServerId} detector=${detectorName}${evidenceSuffix}`
  )

  return beginAutomaticFailover({
    db,
    commandQueue: deps.commandQueue ?? null,
    managedId: row.id,
    engine,
    members,
    sourceMemberId: input.sourceMemberId,
    ...detectorAndEvidence(input.detector, evidence),
    actor: { actorType: 'system', actorId: deps.reporterServerId },
    ...(deps.autoFailover ? { autoFailover: deps.autoFailover } : {}),
    ...(deps.probeStandby ? { probeStandby: deps.probeStandby } : {}),
    ...(deps.freshStandbyMarginMs === undefined
      ? {}
      : { freshStandbyMarginMs: deps.freshStandbyMarginMs }),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
    failureStartedAtMs: failureStartedAtMs(input.evidence, receivedAtMs),
  })
}
