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
import { firstIncidentReportAt, recordBlockedRecovery } from './recovery-records.ts'
import { BOOT_HOLD_DETECTOR, handleBootHoldReport } from './ha-return-fence.ts'
import {
  listManagedMembers,
  replicationPurposeForMemberPair,
  type ManagedMemberRow,
} from './members.ts'
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
import {
  anchoredFailureStartedAtMs,
  failureStartedAtMs,
  type FreshStandbyProbe,
  MAX_FAILURE_SPAN_MS,
} from './ha-fresh-standby.ts'
import {
  isPrivateEndpointError,
  resolvePrivateEndpoints,
  type PrivateEndpointPurpose,
} from '../net/private-endpoint.ts'

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
  reporterPrivateHosts: (
    db: Db,
    reporterServerId: string,
    primary: ManagedMemberRow,
    members: readonly ManagedMemberRow[]
  ) => Promise<string[]>
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

export async function reporterPrivateHosts(
  db: Db,
  reporterServerId: string,
  primary: ManagedMemberRow,
  members: readonly ManagedMemberRow[],
  resolveEndpoints: typeof resolvePrivateEndpoints = resolvePrivateEndpoints
): Promise<string[]> {
  const remoteRoutes = new Map<string, { fromServerId: string; purpose: PrivateEndpointPurpose }>()
  for (const member of members) {
    if (member.serverId === reporterServerId) continue
    const purpose = replicationPurposeForMemberPair(primary, member)
    remoteRoutes.set(`${member.serverId}:${purpose}`, { fromServerId: member.serverId, purpose })
  }
  const hosts = await Promise.all(
    [...remoteRoutes.values()].map(async ({ fromServerId, purpose }) => {
      const endpoints = await resolveEndpoints(db, {
        fromServerId,
        toServerIds: [reporterServerId],
        purpose,
      })
      const endpoint = endpoints.get(reporterServerId)
      return endpoint && !isPrivateEndpointError(endpoint) ? endpoint.address : null
    })
  )
  return hosts.filter((host): host is string => host !== null)
}

const DEFAULT_BINDING_LOADERS: HaBindingLoaders = {
  reporterBindsInstance,
  primaryDial: currentPrimaryDial,
  reporterPrivateHosts,
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
    members: readonly ManagedMemberRow[]
    loaders: HaBindingLoaders
  }
): Promise<string | null> {
  if ((input.detector ?? ORCHESTRATOR_DETECTOR) !== ORCHESTRATOR_DETECTOR) return null
  const bindsInstance = await ctx.loaders.reporterBindsInstance(db, ctx.reporterServerId)
  const named = input.instanceHost !== undefined && input.instancePort !== undefined
  const expectedPrimary = named
    ? await ctx.loaders.primaryDial(db, ctx.reporterServerId, ctx.engine, ctx.primary)
    : null
  const localPrivatePort =
    ctx.primary?.serverId === ctx.reporterServerId ? ctx.primary.privatePort : null
  const localPrimaryHosts =
    expectedPrimary && ctx.primary && localPrivatePort !== null
      ? [
          expectedPrimary.host,
          ...(await ctx.loaders.reporterPrivateHosts(
            db,
            ctx.reporterServerId,
            ctx.primary,
            ctx.members
          )),
        ]
      : undefined
  return orchestratorBindingRejection({
    reporterBindsInstance: bindsInstance,
    instanceHost: input.instanceHost,
    instancePort: input.instancePort,
    expectedPrimary,
    localPrivatePort,
    localPrimaryHosts,
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
 * What the transport's signature check found for one `managed-ha-event`
 * (`src/daemon/authn/report-signature.ts`). Only `verified` is acted on.
 * `session-unsigned`: the frame came over a connection that is not a signed
 * session, so it could not carry a signature.
 */
export type HaEventSignature = 'verified' | 'unsigned' | 'invalid' | 'session-unsigned'

/**
 * The {@link HaEventSignature} of a frame from what the socket's signature
 * check found (`verified`, `unsigned`, `invalid`, or `none` when no check ran)
 * and whether the socket is a signed session.
 */
export function haEventSignature(found: string, signedSession: boolean): HaEventSignature {
  if (!signedSession) return 'session-unsigned'
  if (found === 'verified') return 'verified'
  return found === 'invalid' ? 'invalid' : 'unsigned'
}

/**
 * The fix for each refusal, in the words the journal shows. A server is
 * pinned when its daemon holds this control plane's key (the panel identity
 * pin); only a pinned server has a signed session.
 */
export const HA_EVENT_REFUSAL_FIXES: Readonly<
  Record<'unsigned' | 'invalid' | 'session-unsigned', string>
> = {
  unsigned:
    "The server's daemon did not sign the report: it is older than this control plane. Update the daemon on that server (Admin > Updates > Update Now).",
  invalid:
    "The report's signature did not check out against that server's daemon key, so it may not have come from that server. Check the server's connection to the control plane.",
  'session-unsigned':
    "The server is not pinned to this control plane's key, so its reports cannot be signed. A server installed before panel keys is pinned automatically the next time its daemon updates to a new release, if that update can fetch and check this control plane's identity. Any other unpinned server, including the server this control plane runs on, cannot be pinned from the control plane today. Until the server is pinned, promote a replica by hand.",
}

type HaEventRefusal = Exclude<HaEventSignature, 'verified'>

/** `prefix` followed by each refusal's fix. */
function refusalMessages(prefix: string): Readonly<Record<HaEventRefusal, string>> {
  return {
    unsigned: `${prefix} ${HA_EVENT_REFUSAL_FIXES.unsigned}`,
    invalid: `${prefix} ${HA_EVENT_REFUSAL_FIXES.invalid}`,
    'session-unsigned': `${prefix} ${HA_EVENT_REFUSAL_FIXES['session-unsigned']}`,
  }
}

/** Why a dead-primary report was refused, and the fix, in the words the journal shows. */
export const HA_EVENT_REFUSED_MESSAGES = refusalMessages('Automatic failover not started.')

/** Why a held primary was not released after an unclean boot, and the fix. */
export const BOOT_HOLD_REFUSED_MESSAGES = refusalMessages(
  'The primary on this server stays stopped after an unclean restart until someone starts it.'
)

/**
 * A refused `managed-ha-event` (see {@link HaEventSignature}): nothing is
 * fenced, promoted or started. It is recorded as a terminal `blocked` row
 * that says why and how to fix it (no target, so no cooldown; repeats fold
 * into it) when the reporting server hosts a member of the cluster in its
 * organization; otherwise it is only logged. A refused boot-hold report
 * leaves its held primary stopped, and its row says so.
 */
export async function recordRefusedHaEvent(
  db: Db,
  input: ManagedHaEventInput,
  deps: { reporterServerId: string; signature: HaEventRefusal; binding?: HaBindingLoaders }
): Promise<RecoveryRecord | null> {
  const bootHold = input.detector === BOOT_HOLD_DETECTOR
  const reason = (bootHold ? BOOT_HOLD_REFUSED_MESSAGES : HA_EVENT_REFUSED_MESSAGES)[deps.signature]
  const row = await loadCluster(db, input.managedId)
  if (!row?.engine || !isManagedEngineCode(row.engine)) return null
  const members = await listManagedMembers(db, row.id)
  const reporterOrganizationId = await loadServerOrganization(db, deps.reporterServerId)
  const source = await refusedReportSource(db, input, {
    bootHold,
    engine: row.engine,
    members,
    reporterServerId: deps.reporterServerId,
    reporterOrganizationId,
    clusterOrganizationId: row.organizationId,
    loaders: deps.binding ?? DEFAULT_BINDING_LOADERS,
  })
  compatLogWarn(
    'managed-ha',
    `refused ${bootHold ? 'boot-hold report' : 'managed-ha-event'} for ${row.id} from server ${deps.reporterServerId} (${deps.signature}${source ? '' : ', not filed'}): ${reason}`
  )
  if (!source) return null
  return recordRefusalRow(db, {
    managedId: row.id,
    source,
    reason,
    signature: deps.signature,
    reporterServerId: deps.reporterServerId,
    ...(input.detector ? { detector: input.detector } : {}),
  })
}

/**
 * The member a refused report would have been about, when it passes every
 * check a signed one would before any action: a boot-hold report must name a
 * member on the reporting server; a dead-primary report must pass the detector,
 * reporter and current-primary gate (`haEventRejection`) and, for Orchestrator,
 * name the current primary's instance. `null`: the report is only logged, so a
 * late report about a replaced primary is never filed against the new one.
 */
async function refusedReportSource(
  db: Db,
  input: ManagedHaEventInput,
  ctx: {
    bootHold: boolean
    engine: string
    members: readonly ManagedMemberRow[]
    reporterServerId: string
    reporterOrganizationId: string | null
    clusterOrganizationId: string | null
    loaders: HaBindingLoaders
  }
): Promise<ManagedMemberRow | null> {
  const sameOrganization =
    ctx.clusterOrganizationId !== null && ctx.reporterOrganizationId === ctx.clusterOrganizationId
  if (ctx.bootHold) {
    const held = ctx.members.find((member) => member.id === input.sourceMemberId)
    return sameOrganization && held?.serverId === ctx.reporterServerId ? held : null
  }
  const primary = ctx.members.find((member) => member.role === 'primary') ?? null
  const rejection = haEventRejection({
    detector: input.detector,
    engine: ctx.engine,
    sourceMemberId: input.sourceMemberId,
    reporterServerId: ctx.reporterServerId,
    reporterOrganizationId: ctx.reporterOrganizationId,
    clusterOrganizationId: ctx.clusterOrganizationId,
    memberServerIds: ctx.members.map((member) => member.serverId),
    primary,
  })
  if (rejection || !primary) return null
  const stale = await staleOrchestratorReason(db, input, {
    reporterServerId: ctx.reporterServerId,
    engine: ctx.engine,
    primary,
    members: ctx.members,
    loaders: ctx.loaders,
  })
  return stale ? null : primary
}

/**
 * One terminal `blocked` row per cluster, reporting server and member for
 * refused reports: a repeat updates the newest row when it is that same
 * refusal (whatever the reason now is), so a daemon that re-sends every minute
 * leaves one row.
 */
async function recordRefusalRow(
  db: Db,
  params: {
    managedId: string
    source: ManagedMemberRow
    reason: string
    signature: HaEventRefusal
    reporterServerId: string
    detector?: string
  }
): Promise<RecoveryRecord> {
  return recordBlockedRecovery(
    db,
    {
      managedId: params.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: params.source.id,
      state: 'blocked',
      metadata: {
        blockedReason: params.reason,
        reportRefused: params.signature,
        reporterServerId: params.reporterServerId,
        sourceServerId: params.source.serverId,
        ...(params.detector ? { detector: params.detector } : {}),
      },
    },
    (latest) =>
      latest.metadata.reportRefused !== undefined &&
      latest.metadata.reporterServerId === params.reporterServerId
  )
}

/**
 * The fresh-standby gate's failure start for this event: the detector's span
 * may only move it later than `DETECTION_ALLOWANCE_MS` before the first
 * report of the incident the control plane recorded
 * (`anchoredFailureStartedAtMs`). No usable span: `null`, and no journal read.
 */
async function eventFailureStartedAtMs(
  db: Db,
  input: ManagedHaEventInput,
  ctx: { managedId: string; primary: ManagedMemberRow | null; receivedAtMs: number }
): Promise<number | null> {
  if (failureStartedAtMs(input.evidence, ctx.receivedAtMs) === null || !ctx.primary) return null
  const first = await firstIncidentReportAt(db, {
    managedId: ctx.managedId,
    sourcePrimaryMemberId: ctx.primary.id,
    sinceIso: new Date(ctx.receivedAtMs - MAX_FAILURE_SPAN_MS).toISOString(),
  })
  const firstMs = first === null ? null : Date.parse(first)
  return anchoredFailureStartedAtMs(
    input.evidence,
    ctx.receivedAtMs,
    firstMs !== null && Number.isFinite(firstMs) ? firstMs : null
  )
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
    /**
     * What the transport's signature check found. Anything but `verified` is
     * refused and recorded (`recordRefusedHaEvent`) before any other check.
     */
    signature: HaEventSignature
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
    /** Test seam: the answer to a daemon's boot-hold report. */
    bootHold?: typeof handleBootHoldReport
  }
): Promise<RecoveryRecord | null> {
  if (deps.signature !== 'verified') {
    return recordRefusedHaEvent(db, input, {
      reporterServerId: deps.reporterServerId,
      signature: deps.signature,
      ...(deps.binding ? { binding: deps.binding } : {}),
    })
  }
  const receivedAtMs = (deps.nowMs ?? Date.now)()
  const row = await loadCluster(db, input.managedId)
  if (!row) return null
  if (!row.engine || !isManagedEngineCode(row.engine)) return null
  const engine = row.engine

  const members = await listManagedMembers(db, row.id)
  if (members.length === 0) return null

  // A held primary reporting in after an unclean boot is never a failover
  // request: it is answered with a start (still the primary) or left stopped.
  if (input.detector === BOOT_HOLD_DETECTOR) {
    await (deps.bootHold ?? handleBootHoldReport)(db, {
      managedId: row.id,
      engine,
      sourceMemberId: input.sourceMemberId,
      reporterServerId: deps.reporterServerId,
      commandQueue: deps.commandQueue,
    })
    return null
  }

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
    members,
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
    failureStartedAtMs: await eventFailureStartedAtMs(db, input, {
      managedId: row.id,
      primary,
      receivedAtMs,
    }),
  })
}
