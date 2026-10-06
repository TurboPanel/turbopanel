/**
 * Managed HA recovery journal — kinds, states, and fencing metadata.
 *
 * Physical table `recovery` (one word). In-flight uniqueness is one non-terminal
 * row per `managed_id`. Automatic failover is fail-closed: unreachable old
 * primary → `blocked`, never promote.
 */

export const RECOVERY_KINDS = ['automatic-failover', 'switchover', 'disaster-recovery'] as const

export type RecoveryKind = (typeof RECOVERY_KINDS)[number]

export const RECOVERY_STATES = [
  'detecting',
  'fencing',
  'promoting',
  'repointing',
  'reconciling-ingress',
  'verifying',
  'completed',
  'failed',
  'blocked',
] as const

export type RecoveryState = (typeof RECOVERY_STATES)[number]

export const TERMINAL_RECOVERY_STATES: ReadonlySet<RecoveryState> = new Set([
  'completed',
  'failed',
  'blocked',
])

export const AUTOMATIC_FAILOVER_BLOCKED_ERROR = 'managed_automatic_failover_blocked'

export const AUTOMATIC_FAILOVER_BLOCKED_MESSAGE =
  'Automatic failover blocked: unable to verify previous primary is fenced'

export const AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE =
  'Automatic failover blocked: no same-datacenter failover replica is eligible'

/**
 * The transport that received the event has no command queue (the Workers /
 * Durable Object path), so nothing could ever fence or promote: the journal
 * row is terminal at once instead of a `detecting` row that would hold the
 * in-flight slot and lock switchover / DR out.
 */
export const AUTOMATIC_FAILOVER_NO_QUEUE_REASON = 'no_command_queue'
export const AUTOMATIC_FAILOVER_NO_QUEUE_MESSAGE =
  'Automatic failover not started: this control plane cannot dispatch commands (no_command_queue)'

/** A `detecting` / `fencing` row nothing advanced: expired by the stale sweep. */
export const AUTOMATIC_FAILOVER_STALE_DETECTING_MESSAGE =
  'Recovery expired: it was never advanced and no command was queued (stale_unadvanced)'

/**
 * A row that has been in flight for a full step budget with no progress: the
 * control plane that was driving it is gone (restart, deploy) or the daemon
 * never answered. The row ends terminal `failed` and is flagged
 * `needsOperator`: nothing will advance it, the cluster's roles may be
 * half-changed, and an operator has to look before changing roles again.
 */
export const RECOVERY_STALLED_MESSAGE =
  'Recovery stopped: nothing advanced it for 15 minutes (the control plane restarted or a server never answered). The cluster may be half way through a role change. Check which member is the writer before switching over again.'

/** A recovery command timed out or its result was lost. */
export const RECOVERY_COMMAND_TIMED_OUT_MESSAGE =
  'Recovery stopped: a recovery command timed out or its result was lost. The cluster may be half way through a role change. Check which member is the writer before switching over again.'

/** A step after the role change threw, so the row can never be advanced. */
export const RECOVERY_STEP_FAILED_MESSAGE =
  'Recovery stopped: a step after the role change failed. The roles were changed; check the cluster, then reconcile it.'

/** Refused inside the per-cluster cooldown (recorded, terminal, no target). */
export const AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE =
  'Automatic failover refused: a previous automatic failover started less than 15 minutes ago (cooldown)'

/**
 * The old primary's server reconnected between the whole-host-loss decision
 * and the moment the failover would have started: it is a normal primary
 * again and nothing was changed.
 */
export const HOST_LOSS_HOST_RETURNED_MESSAGE =
  "Failover stopped: the primary's server came back before anything was changed, so the database was left as it was"

/** The promote / recover command could not be enqueued. */
export const PROMOTE_UNQUEUED_MESSAGE =
  'Recovery blocked: the promote command could not be queued (command queue unavailable)'

/** The fence stop command could not be enqueued. */
export const FENCE_STOP_UNQUEUED_MESSAGE =
  'Recovery blocked: the fence stop command could not be queued (command queue unavailable)'

export const AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE =
  'Automatic failover blocked: no same-datacenter failover replica is healthy enough to promote'

/**
 * The stored observations named no healthy candidate, and the event-time
 * probe could not prove a non-streaming failover replica caught up
 * (`ha-fresh-standby.ts`; details in `freshStandby`).
 */
export const AUTOMATIC_FAILOVER_STANDBY_NOT_PROVEN_MESSAGE =
  'Automatic failover blocked: the failover replica is not streaming and could not be proven caught up to the failed primary'

export type RecoveryMetadata = {
  fencingEpoch?: string
  fenceCommandIds?: string[]
  promoteCommandId?: string
  failoverCommandId?: string
  ingressCommandIds?: string[]
  haPresent?: boolean
  fenced?: boolean
  drainApplied?: boolean
  stopApplied?: boolean
  blockedReason?: string
  /** Times the same refusal was seen; absent = once. */
  blockedCount?: number
  lastBlockedAt?: string
  lagBytes?: number | null
  sourceDatacenterId?: string | null
  targetDatacenterId?: string | null
  sourceServerId?: string
  targetServerId?: string
  /** `managed-ha-event` detector that opened an automatic failover. */
  detector?: string
  /**
   * Detector evidence as sent (JSON text, bounded). Only its `spanMs` is
   * used, to anchor the fresh-standby gate's failure start.
   */
  detectorEvidence?: string
  /** Fresh-standby gate outcome per probed replica (accepted basis / refusal). */
  freshStandby?: string
  /**
   * How the old primary was fenced. Absent = a stop command proved it.
   * `host-loss-attested`: its server was silent and the replicas confirmed it
   * is gone, so no stop could be sent; the old primary is held back when it
   * returns instead (`ha-return-fence.ts`). Never set by `verifyFenced`.
   */
  fenceBasis?: 'host-loss-attested'
  /** `<serverId>@<offline since>`: one whole-host-loss incident (`ha-host-loss.ts`). */
  hostLossIncident?: string
  /** The old primary came back and was confirmed stopped / needs a resync. */
  returnFence?: 'confirmed'
  /**
   * The report did not name the current primary: recorded, never acted on
   * (no fencing, no promotion). `blockedReason` says why.
   */
  stale?: boolean
  /**
   * Terminal `failed` row nothing will advance: an operator has to check the
   * cluster before the next role change. `failedReason` says why.
   */
  needsOperator?: boolean
  failedReason?: string
}

export type RecoveryRecord = {
  id: string
  managedId: string
  kind: RecoveryKind
  sourcePrimaryMemberId: string
  targetMemberId: string | null
  state: RecoveryState
  startedAt: string
  completedAt: string | null
  metadata: RecoveryMetadata
  createdAt: string
  updatedAt: string
}

export function isRecoveryKind(value: unknown): value is RecoveryKind {
  return typeof value === 'string' && (RECOVERY_KINDS as readonly string[]).includes(value)
}

export function isRecoveryState(value: unknown): value is RecoveryState {
  return typeof value === 'string' && (RECOVERY_STATES as readonly string[]).includes(value)
}

export function isTerminalRecoveryState(state: RecoveryState): boolean {
  return TERMINAL_RECOVERY_STATES.has(state)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

function optionalNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' ? value : undefined
}

function setIfPresent<K extends keyof RecoveryMetadata>(
  metadata: RecoveryMetadata,
  key: K,
  parsed: RecoveryMetadata[K] | undefined
): void {
  if (parsed === undefined) return
  metadata[key] = parsed
}

export function parseRecoveryMetadata(value: unknown): RecoveryMetadata {
  if (!isRecord(value)) return {}
  const metadata: RecoveryMetadata = {}
  setIfPresent(metadata, 'fencingEpoch', optionalString(value.fencingEpoch))
  setIfPresent(metadata, 'fenceCommandIds', optionalStringList(value.fenceCommandIds))
  setIfPresent(metadata, 'promoteCommandId', optionalString(value.promoteCommandId))
  setIfPresent(metadata, 'failoverCommandId', optionalString(value.failoverCommandId))
  setIfPresent(metadata, 'ingressCommandIds', optionalStringList(value.ingressCommandIds))
  setIfPresent(metadata, 'haPresent', optionalBoolean(value.haPresent))
  setIfPresent(metadata, 'fenced', optionalBoolean(value.fenced))
  setIfPresent(metadata, 'drainApplied', optionalBoolean(value.drainApplied))
  setIfPresent(metadata, 'stopApplied', optionalBoolean(value.stopApplied))
  setIfPresent(metadata, 'blockedReason', optionalString(value.blockedReason))
  setIfPresent(metadata, 'blockedCount', optionalNullableNumber(value.blockedCount) ?? undefined)
  setIfPresent(metadata, 'lastBlockedAt', optionalString(value.lastBlockedAt))
  setIfPresent(metadata, 'lagBytes', optionalNullableNumber(value.lagBytes))
  setIfPresent(metadata, 'sourceDatacenterId', optionalNullableString(value.sourceDatacenterId))
  setIfPresent(metadata, 'targetDatacenterId', optionalNullableString(value.targetDatacenterId))
  setIfPresent(metadata, 'sourceServerId', optionalString(value.sourceServerId))
  setIfPresent(metadata, 'targetServerId', optionalString(value.targetServerId))
  setIfPresent(metadata, 'detector', optionalString(value.detector))
  setIfPresent(metadata, 'detectorEvidence', optionalString(value.detectorEvidence))
  setIfPresent(metadata, 'freshStandby', optionalString(value.freshStandby))
  if (value.fenceBasis === 'host-loss-attested') metadata.fenceBasis = value.fenceBasis
  setIfPresent(metadata, 'hostLossIncident', optionalString(value.hostLossIncident))
  if (value.returnFence === 'confirmed') metadata.returnFence = value.returnFence
  setIfPresent(metadata, 'stale', optionalBoolean(value.stale))
  setIfPresent(metadata, 'needsOperator', optionalBoolean(value.needsOperator))
  setIfPresent(metadata, 'failedReason', optionalString(value.failedReason))
  return metadata
}

export function serializeRecovery(row: RecoveryRecord) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    sourcePrimaryMemberId: row.sourcePrimaryMemberId,
    targetMemberId: row.targetMemberId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    blockedReason: row.metadata.blockedReason ?? null,
    needsOperator: row.metadata.needsOperator ?? false,
    failedReason: row.metadata.failedReason ?? null,
    lagBytes: row.metadata.lagBytes ?? null,
    sourceDatacenterId: row.metadata.sourceDatacenterId ?? null,
    targetDatacenterId: row.metadata.targetDatacenterId ?? null,
    sourceServerId: row.metadata.sourceServerId ?? null,
    targetServerId: row.metadata.targetServerId ?? null,
    freshStandby: row.metadata.freshStandby ?? null,
  }
}
