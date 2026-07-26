import { inArray } from 'drizzle-orm'
import type {
  DaemonCellRegistry,
  PendingRequestRecord,
  PendingRequestStatus,
} from '../../daemon/cell/contracts.ts'
import type { ServerFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  type ServerDaemonStatus,
  type UpdateProjection,
} from '../../daemon/authn/daemon-state.ts'
import type { Db } from '../../db.ts'
import type { ServerGeo } from '../../lib/geo/server-geo.ts'
import { server } from '../../lib/db/schema.ts'
import { resolveColocatedServerIdSet } from './colocated.ts'
import { UPDATE_PENDING_MS, UPDATE_REQUEST_TTL_MS } from '../../lib/update/constants.ts'
import {
  resolveTrunkManifest,
  type TrunkManifestTarget,
} from '../../lib/update/manifest.ts'

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  'done',
  'failed',
  'expired',
])

function isTerminalRequestStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function pickLatestUpdateRequest(
  requests: PendingRequestRecord[],
): PendingRequestRecord | undefined {
  if (requests.length === 0) return undefined
  const [first, ...rest] = requests
  return rest.reduce((latest, candidate) => {
    const latestMs = Date.parse(latest.createdAt)
    const candidateMs = Date.parse(candidate.createdAt)
    if (Number.isNaN(latestMs) || Number.isNaN(candidateMs)) {
      return candidate
    }
    return candidateMs > latestMs ? candidate : latest
  }, first!)
}

function projectedUpdateToRequest(
  serverId: string,
  projected: UpdateProjection,
): PendingRequestRecord | undefined {
  if (projected.status === 'idle') return undefined

  const statusMap: Record<
    Exclude<UpdateProjection['status'], 'idle'>,
    PendingRequestStatus
  > = {
    updating: 'sent',
    done: 'done',
    failed: 'failed',
    expired: 'expired',
  }
  const status = statusMap[projected.status as Exclude<UpdateProjection['status'], 'idle'>]
  if (!status) return undefined

  const createdAt = projected.queuedAt ?? projected.finishedAt ??
    new Date(0).toISOString()

  return {
    serverId,
    requestId: projected.requestId ?? '',
    requestKind: 'update',
    status,
    createdAt,
    expiresAt: projected.finishedAt ?? createdAt,
    finishedAt: projected.finishedAt,
    error: projected.error,
  }
}

export type ServerUpdateCommit = {
  commit: string
  buildId: string
  builtAt?: string
}

export const COLOCATED_SERVER_UPDATE_BLOCKED_REASON =
  'The co-located development daemon cannot be updated from the control plane'

export function colocatedServerUpdateBlockedReason(): string {
  return COLOCATED_SERVER_UPDATE_BLOCKED_REASON
}

export function isStaleProjectedUpdating(params: {
  projectedUpdate?: UpdateProjection | null
  currentCommit?: string | null
  targetCommit?: string | null
  updateTtlMs?: number
}): boolean {
  const update = params.projectedUpdate
  if (update?.status !== 'updating') return false

  if (
    params.targetCommit &&
    params.currentCommit &&
    params.currentCommit === params.targetCommit
  ) {
    return true
  }

  if (update.queuedAt && params.updateTtlMs) {
    const queuedMs = Date.parse(update.queuedAt)
    if (!Number.isNaN(queuedMs) && Date.now() - queuedMs >= params.updateTtlMs) {
      return true
    }
  }

  return false
}

export type ServerUpdateGetResponse = {
  ok: boolean
  serverId: string
  channel: string
  current: ServerUpdateCommit | null
  target: (ServerUpdateCommit & { manifestUrl?: string }) | null
  updateAvailable: boolean
  colocatedWithInstance?: boolean
  updateBlocked?: boolean
  updateBlockedReason?: string
  status: 'idle' | 'updating' | 'error'
  targetStatus: 'ok' | 'unknown'
  targetError?: string
  /** Set when the latest terminal update attempt failed or timed out. */
  lastUpdateError?: string
  /** ISO timestamp of the in-flight or latest update request, when known. */
  queuedAt?: string
  /** True when operators may clear a stale non-terminal update projection. */
  canResetUpdateStatus?: boolean
}

type ResolvedUpdateTarget = {
  target: ServerUpdateGetResponse['target']
  targetStatus: ServerUpdateGetResponse['targetStatus']
  targetError: string | undefined
  updateBlocked: boolean
  updateAvailable: boolean
}

function resolveUpdateTarget(params: {
  current: ServerUpdateCommit | null
  colocatedWithInstance?: boolean
  manifest: TrunkManifestTarget | null
}): ResolvedUpdateTarget {
  const target = params.manifest
    ? {
      commit: params.manifest.commit,
      buildId: params.manifest.buildId,
      builtAt: params.manifest.builtAt,
      manifestUrl: params.manifest.manifestUrl,
    }
    : null

  const targetStatus = target ? 'ok' as const : 'unknown' as const
  const targetError = target
    ? undefined
    : 'Could not resolve trunk channel manifest'

  const commitDrift = target && params.current?.commit
    ? params.current.commit !== target.commit
    : false
  const updateBlocked = params.colocatedWithInstance === true
  const updateAvailable = updateBlocked ? false : commitDrift

  return { target, targetStatus, targetError, updateBlocked, updateAvailable }
}

async function loadUpdateRequests(params: {
  serverId: string
  listUpdateRequests?: () => Promise<PendingRequestRecord[]>
  projectedUpdate?: UpdateProjection | null
}): Promise<PendingRequestRecord[]> {
  if (params.projectedUpdate !== undefined && params.projectedUpdate !== null) {
    const synthesized = projectedUpdateToRequest(
      params.serverId,
      params.projectedUpdate,
    )
    return synthesized ? [synthesized] : []
  }
  return await (params.listUpdateRequests ?? (async () => []))()
}

function statusFromFailedOrExpired(
  latest: PendingRequestRecord,
  updateAvailable: boolean,
): {
  status: ServerUpdateGetResponse['status']
  lastUpdateError: string
} {
  const lastUpdateError = latest.error ??
    (latest.status === 'expired'
      ? 'Update timed out waiting for daemon acknowledgement'
      : 'Update failed')
  // Only block the badge with "Update error" once the daemon already matches
  // trunk (e.g. operator fixed the node manually). When still behind trunk,
  // keep status idle so the UI shows "Update available" and a retry works.
  return {
    lastUpdateError,
    status: updateAvailable ? 'idle' : 'error',
  }
}

function isDoneStillPending(
  latest: PendingRequestRecord,
  target: NonNullable<ServerUpdateGetResponse['target']>,
  currentCommit: string | undefined,
): boolean {
  if (currentCommit === target.commit) return false
  const finishedAt = latest.finishedAt
    ? Date.parse(latest.finishedAt)
    : Number.NaN
  return !Number.isNaN(finishedAt) &&
    Date.now() - finishedAt < UPDATE_PENDING_MS
}

function deriveUpdateLifecycle(params: {
  latest: PendingRequestRecord | undefined
  target: ServerUpdateGetResponse['target']
  currentCommit: string | undefined
  updateAvailable: boolean
}): {
  status: ServerUpdateGetResponse['status']
  lastUpdateError: string | undefined
} {
  let status: ServerUpdateGetResponse['status'] = 'idle'
  let lastUpdateError: string | undefined
  const { latest, target, currentCommit, updateAvailable } = params

  if (!latest) {
    return { status, lastUpdateError }
  }

  if (!isTerminalRequestStatus(latest.status)) {
    status = 'updating'
  } else if (latest.status === 'failed' || latest.status === 'expired') {
    const failed = statusFromFailedOrExpired(latest, updateAvailable)
    status = failed.status
    lastUpdateError = failed.lastUpdateError
  } else if (latest.status === 'done' && target &&
    isDoneStillPending(latest, target, currentCommit)
  ) {
    status = 'updating'
  }

  // Terminal evidence wins over a stale projected in-flight update.
  if (target && currentCommit === target.commit && status === 'updating') {
    status = 'idle'
  }

  return { status, lastUpdateError }
}

export async function resolveServerUpdateStatus(params: {
  serverId: string
  current: ServerUpdateCommit | null
  listUpdateRequests?: () => Promise<PendingRequestRecord[]>
  projectedUpdate?: UpdateProjection | null
  /** When batching status checks, pass a shared manifest lookup result. */
  targetManifest?: TrunkManifestTarget | null
  /** Co-located daemon on this control plane host — remote trunk updates blocked. */
  colocatedWithInstance?: boolean
}): Promise<
  Pick<
    ServerUpdateGetResponse,
    | 'target'
    | 'updateAvailable'
    | 'updateBlocked'
    | 'updateBlockedReason'
    | 'status'
    | 'targetStatus'
    | 'targetError'
    | 'lastUpdateError'
    | 'queuedAt'
    | 'canResetUpdateStatus'
  >
> {
  const manifest = params.targetManifest !== undefined
    ? params.targetManifest
    : await resolveTrunkManifest()

  const {
    target,
    targetStatus,
    targetError,
    updateBlocked,
    updateAvailable,
  } = resolveUpdateTarget({
    current: params.current,
    colocatedWithInstance: params.colocatedWithInstance,
    manifest,
  })

  const requests = await loadUpdateRequests(params)
  const latest = pickLatestUpdateRequest(requests)
  const queuedAt = params.projectedUpdate?.queuedAt ?? latest?.createdAt
  const staleUpdating = isStaleProjectedUpdating({
    projectedUpdate: params.projectedUpdate,
    currentCommit: params.current?.commit,
    targetCommit: target?.commit,
    updateTtlMs: UPDATE_REQUEST_TTL_MS,
  })

  const { status, lastUpdateError } = deriveUpdateLifecycle({
    latest,
    target,
    currentCommit: params.current?.commit,
    updateAvailable,
  })

  const canResetUpdateStatus = staleUpdating ||
    (status === 'error' && !!lastUpdateError) ||
    (status === 'idle' && !!lastUpdateError && !updateAvailable)

  return {
    target,
    updateAvailable,
    ...(updateBlocked
      ? {
        updateBlocked: true,
        updateBlockedReason: colocatedServerUpdateBlockedReason(),
      }
      : {}),
    status,
    targetStatus,
    targetError,
    ...(lastUpdateError ? { lastUpdateError } : {}),
    ...(queuedAt ? { queuedAt } : {}),
    ...(canResetUpdateStatus ? { canResetUpdateStatus: true } : {}),
  }
}

export type ServerStatusRecord = {
  serverId: string
  connected: boolean
  daemonStatus: ServerDaemonStatus['daemonStatus']
  lastSeenAt: string | null
  connectedAt: string | null
  disconnectedAt: string | null
  statusChangedAt: string | null
  hostname: string | null
  remoteAddress: string | null
  geo: ServerGeo | null
  colocatedWithInstance: boolean
}

export async function readDaemonStatusesForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, ServerDaemonStatus>> {
  if (serverIds.length === 0) return new Map()

  const rows = await db
    .select({
      id: server.id,
      connected: server.connected,
      daemonStatus: server.daemonStatus,
      lastSeenAt: server.lastSeenAt,
      connectedAt: server.connectedAt,
      disconnectedAt: server.disconnectedAt,
      statusChangedAt: server.statusChangedAt,
    })
    .from(server)
    .where(inArray(server.id, serverIds))

  const result = new Map<string, ServerDaemonStatus>()
  for (const row of rows) {
    result.set(row.id, mapServerDaemonStatusFromColumns(row))
  }
  return result
}

export function buildServerStatusRecord(
  presence: ServerFleetPresence,
  colocatedWithInstance: boolean,
  status?: ServerDaemonStatus | null,
): ServerStatusRecord {
  const resolved = status ?? buildDefaultDaemonStatus()
  return {
    serverId: presence.serverId,
    connected: presence.connected,
    daemonStatus: resolved.daemonStatus,
    lastSeenAt: presence.lastSeenAt ?? resolved.lastSeenAt,
    connectedAt: presence.connectedAt ?? resolved.connectedAt,
    disconnectedAt: resolved.disconnectedAt,
    statusChangedAt: resolved.statusChangedAt,
    hostname: presence.hostname,
    remoteAddress: presence.remoteAddress,
    geo: presence.geo,
    colocatedWithInstance,
  }
}

export async function loadServerStatusRecords(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: string[],
): Promise<ServerStatusRecord[]> {
  if (serverIds.length === 0) return []

  const [presence, colocatedIds, statuses] = await Promise.all([
    resolveFleetPresence(db, registry, serverIds),
    resolveColocatedServerIdSet(db, registry, serverIds),
    readDaemonStatusesForServers(db, serverIds),
  ])

  return serverIds.flatMap((id) => {
    const live = presence.get(id)
    if (!live) return []
    return [buildServerStatusRecord(
      live,
      colocatedIds.has(id),
      statuses.get(id),
    )]
  })
}
