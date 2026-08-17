/**
 * Pure helpers for server routes — validation, response shaping, and
 * decision trees that do not need a Hono Context or live DB client.
 */

import {
  formatServerOsDisplay,
  parseServerOptions,
  resolveEffectiveServerTimezone,
  resolveServerResponseTimezone,
  resolveServerOsLogoKey,
  type ServerOptions,
  type ServerOsMetadata,
  type ServerTimeSync,
  type ServerHostResources,
  type ServerDockerMetadata,
} from '../../lib/db/server-metadata.ts'
import type { OrganizationOptions } from '../../lib/organization-options.ts'
import type { DatacenterOptions } from '../../lib/datacenter-options.ts'
import { parseDisplayName } from '../shared.ts'
import { colocatedServerUpdateBlockedReason } from './update-status.ts'
import type { ServerUpdateCommit } from './update-status.ts'

export const SERVER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const STATUS_CACHE_CONTROL = 'private, max-age=5'
export const STATUS_CACHE_MAX_AGE_MS = 5_000
export const UPDATE_CHANNEL = 'trunk' as const

export function isServerUuid(value: unknown): value is string {
  return typeof value === 'string' && SERVER_UUID_RE.test(value)
}

export function buildBatchStatusCoalesceKey(
  userId: string,
  organizationId: string,
  visibleIds: string[],
): string {
  const sortedIds = [...visibleIds].sort((a, b) => a.localeCompare(b))
  return `${userId}:${organizationId}:${sortedIds.join(',')}`
}

export type BatchStatusCoalesceEntryLike = {
  expiresAt: number
  promise?: unknown
}

/** Keys whose cached result may be dropped (in-flight promises are kept). */
export function expiredBatchStatusCoalesceKeys(
  entries: Iterable<[string, BatchStatusCoalesceEntryLike]>,
  now: number,
): string[] {
  const expired: string[] = []
  for (const [key, entry] of entries) {
    if (entry.promise !== undefined) continue
    if (entry.expiresAt <= now) expired.push(key)
  }
  return expired
}

export function currentCommitFromDaemonBuild(
  daemonBuild:
    | { commit?: string; buildId?: string; builtAt?: string }
    | undefined,
): ServerUpdateCommit | null {
  return daemonBuild?.commit
    ? {
      commit: daemonBuild.commit,
      buildId: daemonBuild.buildId ?? '',
      builtAt: daemonBuild.builtAt ?? '',
    }
    : null
}

export type ServerPatchFields = {
  name?: string | null
  options?: ServerOptions
  updatedAt: string
}

export type ServerRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type ServerDatacenterRef = {
  id: string
  displayName: string | null
}

/**
 * Unique datacenter memberships for a server list/detail DTO, sorted by id.
 */
export function shapeServerDatacenters(
  memberships: ReadonlyArray<{ datacenterId: string }>,
  displayNamesById: ReadonlyMap<string, string | null>,
): ServerDatacenterRef[] {
  const seen = new Set<string>()
  const out: ServerDatacenterRef[] = []
  for (const row of memberships) {
    if (seen.has(row.datacenterId)) continue
    seen.add(row.datacenterId)
    out.push({
      id: row.datacenterId,
      displayName: displayNamesById.get(row.datacenterId) ?? null,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Validate name / options / emptiness for a server PATCH body.
 * Datacenter membership is managed via IP pins, not server PATCH.
 */
export function parseServerPatchCore(
  body: Record<string, unknown>,
  updatedAt = new Date().toISOString(),
):
  | {
    ok: true
    patch: ServerPatchFields
  }
  | ServerRouteValidationError {
  const patch: ServerPatchFields = { updatedAt }

  if (body.displayName !== undefined || body.name !== undefined) {
    try {
      patch.name = parseDisplayName(body)
    } catch {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
  }

  if (body.datacenterId !== undefined) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  if (body.options !== undefined) {
    const options = parseServerOptions(body.options)
    if (options === null) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.options = options
  }

  if (patch.name === undefined && patch.options === undefined) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  return { ok: true, patch }
}

export function isHostingEnableTransition(
  previousOptions: ServerOptions | null,
  patch: ServerPatchFields,
): boolean {
  const wasHostingEnabled = previousOptions?.hosting?.enabled === true
  return patch.options?.hosting?.enabled === true && !wasHostingEnabled
}

export function isHostingDisableTransition(
  previousOptions: ServerOptions | null,
  patch: ServerPatchFields,
): boolean {
  const wasHostingEnabled = previousOptions?.hosting?.enabled === true
  return patch.options?.hosting?.enabled === false && wasHostingEnabled
}

export function hostingHierarchyFailedBody(): {
  error: string
  code: string
} {
  return {
    error: 'Failed to provision hosting hierarchy',
    code: 'hosting_hierarchy_failed',
  }
}

export type ServerDeletedPayload =
  | { ok: true; serverId: string; status: 200 }
  | {
    ok: false
    serverId: string
    deleted: true
    error: string
    status: 500
  }

export function serverDeletedPayload(
  serverId: string,
  purgeError: string | null,
): ServerDeletedPayload {
  if (purgeError) {
    return {
      ok: false,
      serverId,
      deleted: true,
      error: `Server deleted but daemon cell purge failed: ${purgeError}`,
      status: 500,
    }
  }
  return { ok: true, serverId, status: 200 }
}

export function queueServerUpdateHttpStatus(error: string): 403 | 404 {
  return error === colocatedServerUpdateBlockedReason() ? 403 : 404
}

export function emptyServersUpdatesPayload(): {
  ok: true
  channel: typeof UPDATE_CHANNEL
  target: null
  targetStatus: 'unknown'
  targetError: string
  servers: []
} {
  return {
    ok: true,
    channel: UPDATE_CHANNEL,
    target: null,
    targetStatus: 'unknown',
    targetError: 'Could not resolve trunk channel manifest',
    servers: [],
  }
}

export type TrunkTargetFields = {
  target: {
    commit: string
    buildId: string
    builtAt: string
    manifestUrl: string
  } | null
  targetStatus: 'ok' | 'unknown'
  targetError: string | undefined
}

export function resolveTrunkTargetFields(
  targetManifest: {
    commit: string
    buildId: string
    builtAt: string
    manifestUrl: string
  } | null,
): TrunkTargetFields {
  const target = targetManifest
    ? {
      commit: targetManifest.commit,
      buildId: targetManifest.buildId,
      builtAt: targetManifest.builtAt,
      manifestUrl: targetManifest.manifestUrl,
    }
    : null
  return {
    target,
    targetStatus: target ? 'ok' : 'unknown',
    targetError: target ? undefined : 'Could not resolve trunk channel manifest',
  }
}

export type BatchUpdateEligibility =
  | { ok: false; error: string }
  | { ok: true; updateAvailable: true }

/**
 * Decision tree for POST /servers/updates before enqueueing.
 * Caller still performs the manage check and queueServerUpdate.
 */
export function resolveBatchUpdateEligibility(params: Readonly<{
  connected: boolean
  colocated: boolean
  current: ServerUpdateCommit | null
  targetCommit: string | null
}>): BatchUpdateEligibility {
  if (!params.connected) {
    return { ok: false, error: 'Daemon not connected' }
  }
  if (params.colocated) {
    return { ok: false, error: colocatedServerUpdateBlockedReason() }
  }
  const updateAvailable = params.targetCommit
    ? params.current?.commit !== params.targetCommit
    : false
  if (!updateAvailable) {
    return {
      ok: false,
      error: params.targetCommit ? 'Up to date' : 'Target unavailable',
    }
  }
  return { ok: true, updateAvailable: true }
}

export function updateResetErrorStatus(message: string): 409 | 500 {
  return message === 'update in progress' ? 409 : 500
}

export function distinctNonEmptyIds(
  ids: Array<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
}

export function errorMessageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type PresenceLike = {
  connected?: boolean
  hostname?: string | null
  remoteAddress?: string | null
  colocatedWithInstance?: boolean
  lastInboundAt?: string | null
  connectedAt?: string | null
  statusChangedAt?: string | null
  geo?: unknown
  os?: ServerOsMetadata | null
  resources?: ServerHostResources | null
  ips?: unknown
  timeSync?: ServerTimeSync | null
  docker?: ServerDockerMetadata | null
}

export type ServerListTimezoneFields = {
  timezone: string | null
  timezoneSource: string | null
}

export function resolveServerTimezoneFields(
  rowOptions: unknown,
  orgOptions: OrganizationOptions | null | undefined,
  dcOptions: DatacenterOptions | null | undefined,
  observedTimezone: string | null | undefined,
): ServerListTimezoneFields {
  const effective = resolveServerResponseTimezone(
    resolveEffectiveServerTimezone(
      parseServerOptions(rowOptions),
      orgOptions ?? null,
      dcOptions,
    ),
    observedTimezone,
  )
  return {
    timezone: effective.timezone,
    timezoneSource: effective.source,
  }
}

export function shapeServerOsFields(os: ServerOsMetadata | null | undefined) {
  return {
    os: os ?? null,
    osDisplay: formatServerOsDisplay(os ?? null),
    osLogo: resolveServerOsLogoKey(os ?? null),
  }
}

export function shapeServerPresenceFields(
  live: PresenceLike | null | undefined,
  colocated: boolean,
) {
  const os = live?.os ?? null
  return {
    connected: live?.connected ?? false,
    hostname: live?.hostname ?? null,
    remoteAddress: live?.remoteAddress ?? null,
    colocatedWithInstance: colocated,
    lastInboundAt: live?.lastInboundAt ?? null,
    connectedAt: live?.connectedAt ?? null,
    statusChangedAt: live?.statusChangedAt ?? null,
    geo: live?.geo ?? null,
    ...shapeServerOsFields(os),
    resources: live?.resources ?? null,
    ips: live?.ips ?? null,
    timeSync: live?.timeSync ?? null,
    docker: live?.docker ?? null,
  }
}

export function shouldSkipProjectedUpdateRepair(
  projectedUpdate: { status?: string } | null | undefined,
): boolean {
  return projectedUpdate?.status !== 'updating'
}

export function repairedUpdateDoneProjection(params: Readonly<{
  requestId?: string
  channel?: string
  queuedAt?: string
  finishedAt: string
}>) {
  return {
    status: 'done' as const,
    requestId: params.requestId,
    channel: params.channel,
    queuedAt: params.queuedAt,
    finishedAt: params.finishedAt,
  }
}

export function repairedUpdateIdleProjection() {
  return { status: 'idle' as const }
}
