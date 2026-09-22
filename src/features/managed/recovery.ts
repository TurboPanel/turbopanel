/**
 * Managed HA recovery journal — kinds, states, and fencing metadata.
 *
 * Physical table `recovery` (one word). In-flight uniqueness is one non-terminal
 * row per `managed_id`. Automatic failover is fail-closed: unreachable old
 * primary → `blocked`, never promote.
 */

export const RECOVERY_KINDS = [
  'automatic-failover',
  'switchover',
  'disaster-recovery',
] as const

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

export const AUTOMATIC_FAILOVER_BLOCKED_ERROR =
  'managed_automatic_failover_blocked'

export const AUTOMATIC_FAILOVER_BLOCKED_MESSAGE =
  'Automatic failover blocked: unable to verify previous primary is fenced'

export const AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE =
  'Automatic failover blocked: no same-datacenter failover replica is eligible'

export const AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE =
  'Automatic failover blocked: no same-datacenter failover replica is healthy enough to promote'

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
  lagBytes?: number | null
  sourceDatacenterId?: string | null
  targetDatacenterId?: string | null
  sourceServerId?: string
  targetServerId?: string
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
  return typeof value === 'string' &&
    (RECOVERY_KINDS as readonly string[]).includes(value)
}

export function isRecoveryState(value: unknown): value is RecoveryState {
  return typeof value === 'string' &&
    (RECOVERY_STATES as readonly string[]).includes(value)
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
  parsed: RecoveryMetadata[K] | undefined,
): void {
  if (parsed === undefined) return
  metadata[key] = parsed
}

export function parseRecoveryMetadata(value: unknown): RecoveryMetadata {
  if (!isRecord(value)) return {}
  const metadata: RecoveryMetadata = {}
  setIfPresent(metadata, 'fencingEpoch', optionalString(value.fencingEpoch))
  setIfPresent(
    metadata,
    'fenceCommandIds',
    optionalStringList(value.fenceCommandIds),
  )
  setIfPresent(
    metadata,
    'promoteCommandId',
    optionalString(value.promoteCommandId),
  )
  setIfPresent(
    metadata,
    'failoverCommandId',
    optionalString(value.failoverCommandId),
  )
  setIfPresent(
    metadata,
    'ingressCommandIds',
    optionalStringList(value.ingressCommandIds),
  )
  setIfPresent(metadata, 'haPresent', optionalBoolean(value.haPresent))
  setIfPresent(metadata, 'fenced', optionalBoolean(value.fenced))
  setIfPresent(metadata, 'drainApplied', optionalBoolean(value.drainApplied))
  setIfPresent(metadata, 'stopApplied', optionalBoolean(value.stopApplied))
  setIfPresent(metadata, 'blockedReason', optionalString(value.blockedReason))
  setIfPresent(metadata, 'lagBytes', optionalNullableNumber(value.lagBytes))
  setIfPresent(
    metadata,
    'sourceDatacenterId',
    optionalNullableString(value.sourceDatacenterId),
  )
  setIfPresent(
    metadata,
    'targetDatacenterId',
    optionalNullableString(value.targetDatacenterId),
  )
  setIfPresent(metadata, 'sourceServerId', optionalString(value.sourceServerId))
  setIfPresent(metadata, 'targetServerId', optionalString(value.targetServerId))
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
    lagBytes: row.metadata.lagBytes ?? null,
    sourceDatacenterId: row.metadata.sourceDatacenterId ?? null,
    targetDatacenterId: row.metadata.targetDatacenterId ?? null,
    sourceServerId: row.metadata.sourceServerId ?? null,
    targetServerId: row.metadata.targetServerId ?? null,
  }
}
