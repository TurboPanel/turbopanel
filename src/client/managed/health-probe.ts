import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from '../../contracts/cell-protocol.ts'
import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { updateManagedMemberObservedReplication } from '../../features/managed/members.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { cellTrace } from '../../lib/logger.ts'
import { MANAGED_HEALTH_FEATURE } from '../../lib/version-wire.ts'
import type { FreshStandbyProbe } from '../../features/managed/ha-fresh-standby.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'

/**
 * On-demand replica health probe (correlated cell round trip, not a command).
 *
 * Health is otherwise only observed when a `managed.apply` /
 * `managed.lifecycle` result comes back, so an idle, healthy cluster's
 * observation ages past the promote gate's staleness window. This asks the
 * member's daemon for a fresh reading and persists it.
 *
 * Never throws and never blocks past `timeoutMs`. Every non-`observed`
 * outcome means "keep using the stored observation" — callers (the promote
 * pre-check) fall back to today's fail-closed behaviour.
 */

/** Promote pre-check: the operator is waiting on a button. */
export const MANAGED_HEALTH_PROBE_PROMOTE_TIMEOUT_MS = 8_000
/** Refresh button: probes run in parallel, one per member server. */
export const MANAGED_HEALTH_PROBE_REFRESH_TIMEOUT_MS = 10_000

export type ManagedHealthProbeParams = {
  serverId: string
  managedId: string
  memberId: string
  /** The member's real role — the daemon reads a `replica` as a standby. */
  role: 'primary' | 'replica'
  engine: string
  timeoutMs: number
}

export type ManagedHealthProbeOutcome =
  | { status: 'observed'; replication: ManagedReplicationHealth }
  | {
      status: 'unsupported'
    }
  | {
      status: 'unavailable'
      reason:
        | 'no_registry'
        | 'offline'
        | 'timeout'
        | 'daemon_error'
        | 'invalid_result'
        | 'member_mismatch'
        | 'error'
      error?: string
    }

/** Seams for hostfree tests; production wires the defaults. */
export type ManagedHealthProbeDeps = {
  isServerConnected?: (serverId: string) => Promise<boolean>
  daemonFeatures?: (serverId: string) => Promise<readonly string[]>
  persist?: (memberId: string, replication: ManagedReplicationHealth) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObservedReplication(
  result: unknown,
  memberId: string
): ManagedReplicationHealth | 'member_mismatch' | null {
  if (!isRecord(result) || result.ok !== true) return null
  const member = result.member
  if (!isRecord(member)) return null
  // The daemon answers for the member we asked about. A reply that names a
  // different one is dropped: the result never chooses which row is written.
  if (member.memberId !== memberId) return 'member_mismatch'
  const replication = member.replication
  if (!isRecord(replication)) return null
  if (
    typeof replication.state !== 'string' ||
    typeof replication.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(replication.observedAt))
  ) {
    return null
  }
  const health: ManagedReplicationHealth = {
    state: replication.state,
    observedAt: replication.observedAt,
    ...lagFields(replication),
  }
  if (typeof replication.receivedLsn === 'string') {
    health.receivedLsn = replication.receivedLsn
  }
  if (typeof replication.replayLsn === 'string') {
    health.replayLsn = replication.replayLsn
  }
  const lastStreaming = parseLastStreaming(replication.lastStreaming)
  if (lastStreaming) health.lastStreaming = lastStreaming
  return health
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function lagFields(record: Record<string, unknown>): {
  lagBytes?: number
  lagSeconds?: number
  receiveLagBytes?: number
} {
  return {
    ...(finiteNumber(record.lagBytes) ? { lagBytes: record.lagBytes } : {}),
    ...(finiteNumber(record.lagSeconds) ? { lagSeconds: record.lagSeconds } : {}),
    ...(finiteNumber(record.receiveLagBytes) ? { receiveLagBytes: record.receiveLagBytes } : {}),
  }
}

/** The daemon's last `streaming` read of a standby; dropped when malformed. */
function parseLastStreaming(value: unknown): ManagedReplicationHealth['lastStreaming'] {
  if (!isRecord(value)) return undefined
  if (typeof value.at !== 'string' || !finiteNumber(value.ageMs)) {
    return undefined
  }
  return { at: value.at, ageMs: value.ageMs, ...lagFields(value) }
}

/** The daemon's text when the member's engine is not running or not answering. */
const ENGINE_DOWN_ANSWER = 'engine not running'

function isEngineDownAnswer(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(ENGINE_DOWN_ANSWER)
}

function notStreamingReading(): ManagedReplicationHealth {
  return { state: 'not_streaming', observedAt: new Date().toISOString() }
}

/** `lastStreaming.ageMs` is only meaningful at probe time: never stored. */
function withoutLastStreaming(health: ManagedReplicationHealth): ManagedReplicationHealth {
  if (!health.lastStreaming) return health
  const stored = { ...health }
  delete stored.lastStreaming
  return stored
}

/**
 * Ask one member's daemon for a fresh replication reading and store it.
 * Sends nothing to a daemon that does not advertise `managed-health-v1`.
 */
export async function probeManagedMemberHealth(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  params: ManagedHealthProbeParams,
  deps: ManagedHealthProbeDeps = {}
): Promise<ManagedHealthProbeOutcome> {
  if (!registry) return { status: 'unavailable', reason: 'no_registry' }

  const daemonFeatures =
    deps.daemonFeatures ??
    (async (serverId: string) => {
      const state = await getServerDaemonStateByServerId(db, serverId)
      return state?.projection?.features ?? []
    })
  const isServerConnected =
    deps.isServerConnected ??
    (async (serverId: string) => {
      const records = await loadServerStatusRecords(db, registry, [serverId])
      return records[0]?.connected === true
    })
  const persist =
    deps.persist ??
    ((memberId: string, replication: ManagedReplicationHealth) =>
      updateManagedMemberObservedReplication(db, memberId, { replication }))

  const requestId = generateRequestId()
  try {
    const features = await daemonFeatures(params.serverId)
    if (!features.includes(MANAGED_HEALTH_FEATURE)) {
      return { status: 'unsupported' }
    }
    if (!(await isServerConnected(params.serverId))) {
      return { status: 'unavailable', reason: 'offline' }
    }

    const envelope: DaemonOutboundEnvelope = {
      kind: 'managed-health-request',
      deliveryId: generateDeliveryId(),
      requestId,
      managedId: params.managedId,
      memberId: params.memberId,
      role: params.role,
      engine: params.engine,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-health-request',
    })

    const record = await registry
      .getCell(params.serverId)
      .createRequestAndWait(envelope, params.timeoutMs)
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-health-request',
      pendingStatus: record.status,
    })

    if (record.status === 'expired') {
      return { status: 'unavailable', reason: 'timeout' }
    }
    if (record.status === 'failed') {
      // The host answered: the replica's engine is down. Record that, or the
      // last `streaming` reading would survive for as long as nobody asks again.
      if (params.role === 'replica' && isEngineDownAnswer(record.error)) {
        await persist(params.memberId, notStreamingReading())
      }
      return {
        status: 'unavailable',
        reason: 'daemon_error',
        error: record.error ?? undefined,
      }
    }

    const parsed = parseObservedReplication(record.result, params.memberId)
    if (parsed === 'member_mismatch') {
      return { status: 'unavailable', reason: 'member_mismatch' }
    }
    if (parsed === null) {
      return { status: 'unavailable', reason: 'invalid_result' }
    }

    await persist(params.memberId, withoutLastStreaming(parsed))
    return { status: 'observed', replication: parsed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-health-request',
      resultStatus: 'error',
      error: message,
    })
    return { status: 'unavailable', reason: 'error', error: message }
  }
}

/**
 * Automatic failover's probe of a candidate standby
 * (`features/managed/ha-fresh-standby.ts`): the fresh observation, or `null`
 * for any outcome other than `observed` (the gate then refuses).
 */
export function createFreshStandbyProbe(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  options: { skipServerId?: string; deps?: ManagedHealthProbeDeps } = {}
): FreshStandbyProbe {
  return async (target) => {
    // A Durable Object must not wait on its own cell from inside one of its
    // own inbound handlers.
    if (target.serverId === options.skipServerId) return null
    const outcome = await probeManagedMemberHealth(
      db,
      registry,
      {
        serverId: target.serverId,
        managedId: target.managedId,
        memberId: target.memberId,
        role: 'replica',
        engine: target.engine,
        timeoutMs: MANAGED_HEALTH_PROBE_PROMOTE_TIMEOUT_MS,
      },
      options.deps
    )
    return outcome.status === 'observed' ? outcome.replication : null
  }
}
