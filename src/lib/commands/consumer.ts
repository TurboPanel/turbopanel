/**
 * **Status projection:** The consumer is the single writer of terminal `command` rows.
 * The WS inbound path (`handleInbound` in `redis/cell.ts` and `do.ts`) only updates the
 * hot `PendingRequestRecord` in the cell. The consumer reads the terminal
 * `PendingRequestRecord` returned by `waitForRequest` and maps it to a
 * `transitionCommand` call. Polling for terminal status runs in the caller
 * isolate (worker stub or Deno process), not inside the Durable Object.
 * There is no per-server polling or cross-cell fan-out.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type {
  DaemonCellRegistry,
  PendingRequestRecord,
} from '../../daemon/cell/contracts.ts'
import { generateDeliveryId } from '../../daemon/cell/protocol.ts'
import { resolveFleetPresence } from '../../daemon/cell/server-status.ts'
import {
  getServerLicenseBinding,
  touchServerMetadata,
} from '../../server-registry.ts'
import { commandConsumerTrace } from '../../logger.ts'
import { compatLogWarn } from '../../log-compat.ts'
import {
  maybeEnqueueVpnMeshComplete,
  type VpnApplyResealDeps,
} from '../../client/vpns/apply-prepare.ts'
import {
  getCommandRecord,
  transitionCommand,
  type CommandRecord,
} from '../db/command-records.ts'
import { reconcileEnvironmentContainers } from '../db/container-records.ts'
import { managed, peer, server } from '../db/schema.ts'
import { getManagedEngineSpec } from '../managed/index.ts'
import {
  parseManagedRowOptions,
  writeManagedRowOptions,
  type ManagedBackupRecord,
} from '../../client/managed/options.ts'
import type { CommandEnvelope } from './envelope.ts'
import { nowIso } from './ids.ts'
import { isNoopCommandQueue } from './noop-command-queue.ts'
import type { CommandQueue } from './queue.ts'
import {
  parseEnvironmentDeployPayload,
  parseEnvironmentDeployResult,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentLifecycleResult,
  parseEnvironmentStopPayload,
  parseEnvironmentStopResult,
  parseHostnameSetResult,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedLifecyclePayload,
  parseManagedLifecycleResult,
  parseManagedRestorePayload,
  parseManagedRestoreResult,
  parseNtpSetResult,
  parsePingResult,
  parseTimezoneSetResult,
  parseWireguardApplyPayload,
  parseWireguardApplyResult,
} from './schemas.ts'
import { isValidWireguardPublicKey } from './wireguard.ts'
import { TERMINAL_COMMAND_STATUSES, type CommandType } from './types.ts'

/** Optional deps for follow-up WireGuard mesh-complete applies. */
export type CommandConsumerDeps = {
  commandQueue?: CommandQueue
  resealDeps?: VpnApplyResealDeps
}

const COMMAND_TIMEOUT_MS: Record<CommandType, number> = {
  'daemon.ping': 30_000,
  'server.hostname.set': 120_000,
  'server.ntp.set': 300_000,
  'server.reboot': 120_000,
  'server.timezone.set': 300_000,
  'server.wireguard.apply': 300_000,
  'environment.deploy': 600_000,
  'environment.lifecycle': 120_000,
  'environment.stop': 120_000,
  'managed.apply': 600_000,
  'managed.lifecycle': 120_000,
  'managed.destroy': 300_000,
  'managed.backup': 1_800_000,
  'managed.restore': 1_800_000,
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

function commandTimeoutMs(type: string): number {
  if (
    type === 'daemon.ping' ||
    type === 'server.hostname.set' ||
    type === 'server.ntp.set' ||
    type === 'server.reboot' ||
    type === 'server.timezone.set' ||
    type === 'server.wireguard.apply' ||
    type === 'environment.deploy' ||
    type === 'environment.lifecycle' ||
    type === 'environment.stop' ||
    type === 'managed.apply' ||
    type === 'managed.lifecycle' ||
    type === 'managed.destroy' ||
    type === 'managed.backup' ||
    type === 'managed.restore'
  ) {
    return COMMAND_TIMEOUT_MS[type]
  }
  return DEFAULT_COMMAND_TIMEOUT_MS
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name.toLowerCase()
    if (
      name.includes('timeout') ||
      name.includes('network') ||
      name.includes('connection')
    ) {
      return true
    }
  }

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()

  if (
    message.includes('overloaded') ||
    message.includes('invalid command envelope') ||
    message.includes('data integrity')
  ) {
    return false
  }

  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('failed to fetch') ||
    message.includes('connection') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('redis') ||
    message.includes('postgres') ||
    message.includes('database') ||
    message.includes('cell unavailable') ||
    message.includes('durable object')
  )
}

function extractObservedHostname(result: unknown): string | null {
  try {
    return parseHostnameSetResult(result).observedHostname
  } catch {
    return null
  }
}

function enrichPingResult(
  type: string,
  result: unknown,
  pending: { sentAt?: string },
): unknown {
  if (type !== 'daemon.ping') return result
  const parsed = parsePingResult(result)
  if (!pending.sentAt) return parsed
  return { ...parsed, cellDispatchedAt: pending.sentAt }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadDispatchableRecord(
  db: Db,
  envelope: CommandEnvelope,
): Promise<CommandRecord | null> {
  const record = await getCommandRecord(db, envelope.commandId)
  if (!record) {
    return null
  }

  if (TERMINAL_COMMAND_STATUSES.has(record.status)) {
    return null
  }

  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    await transitionCommand(db, record.id, { status: 'timed_out' })
    return null
  }

  if (record.serverId !== envelope.serverId) {
    compatLogWarn(
      'command-consumer',
      `envelope mismatch for command ${envelope.commandId}: record server=${record.serverId}, envelope server=${envelope.serverId}`,
    )
    return null
  }

  return record
}

async function markDispatching(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
): Promise<void> {
  commandConsumerTrace('dispatch-start', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
  })

  await transitionCommand(db, record.id, {
    status: 'dispatching',
    dispatchStartedAt: nowIso(),
    attempts: record.attempts + 1,
  })
}

async function ensureServerAndDaemonOnline(
  db: Db,
  registry: DaemonCellRegistry,
  record: CommandRecord,
  envelope: CommandEnvelope,
): Promise<boolean> {
  const serverBinding = await getServerLicenseBinding(db, envelope.serverId)
  if (!serverBinding) {
    compatLogWarn(
      'command-consumer',
      `server ${envelope.serverId} not found for command ${envelope.commandId}`,
    )
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Server not found',
    })
    return false
  }

  const presenceMap = await resolveFleetPresence(db, registry, [envelope.serverId])
  const presence = presenceMap.get(envelope.serverId)
  if (!presence?.connected) {
    commandConsumerTrace('dispatch-failed', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      reason: 'offline',
    })
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Daemon not connected',
    })
    return false
  }

  return true
}

async function enqueueAndAwaitOutcome(
  db: Db,
  registry: DaemonCellRegistry,
  record: CommandRecord,
  envelope: CommandEnvelope,
): Promise<PendingRequestRecord | null> {
  const outbound = {
    kind: 'command-dispatch' as const,
    requestId: record.id,
    deliveryId: generateDeliveryId(),
    at: nowIso(),
    commandId: record.id,
    commandType: record.type,
    payload: record.payload,
  }

  const timeoutMs = commandTimeoutMs(record.type)
  const cell = registry.getCell(envelope.serverId)
  await cell.enqueue(outbound)
  commandConsumerTrace('dispatch-enqueued', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    requestId: record.id,
    deliveryId: outbound.deliveryId,
  })
  await transitionCommand(db, record.id, { status: 'sent' })
  commandConsumerTrace('dispatch-sent', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
  })

  const pending = await cell.waitForRequest(record.id, timeoutMs)
  if (!pending) {
    await transitionCommand(db, record.id, { status: 'timed_out' })
    commandConsumerTrace('dispatch-result', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      resultStatus: 'timed_out',
    })
    await applyManagedFailedSideEffect(db, record)
  }
  return pending
}

async function applyHostnameSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'server.hostname.set') return
  const observedHostname = extractObservedHostname(result)
  if (!observedHostname) return
  await touchServerMetadata(db, envelope.serverId, {
    hostname: observedHostname,
  })
}

async function applyTimeSyncSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type === 'server.timezone.set') {
    try {
      const timezoneResult = parseTimezoneSetResult(result)
      await db.update(server).set({
        options: sql`COALESCE(${server.options}, '{}'::jsonb) || ${
          JSON.stringify({ timezone: timezoneResult.timezone })
        }::jsonb`,
        updatedAt: new Date().toISOString(),
      }).where(eq(server.id, envelope.serverId))
      await touchServerMetadata(db, envelope.serverId, {
        timeSync: { timezone: timezoneResult.timezone },
      })
    } catch {
      // Malformed success payload — leave metadata for the next heartbeat.
    }
    return
  }
  if (record.type !== 'server.ntp.set') return
  try {
    const ntpResult = parseNtpSetResult(result)
    await touchServerMetadata(db, envelope.serverId, {
      timeSync: {
        ...(ntpResult.ntpEnabled === undefined
          ? {}
          : { ntpEnabled: ntpResult.ntpEnabled }),
        ...(ntpResult.ntpSynced === undefined
          ? {}
          : { ntpSynced: ntpResult.ntpSynced }),
        ntpServers: ntpResult.ntpServers,
        ...(ntpResult.fallbackNtpServers === undefined
          ? {}
          : { fallbackNtpServers: ntpResult.fallbackNtpServers }),
      },
    })
  } catch {
    // Malformed success payload — leave metadata for the next heartbeat.
  }
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

async function applyWireguardSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps,
): Promise<void> {
  if (record.type !== 'server.wireguard.apply') return
  try {
    const payload = parseWireguardApplyPayload(record.payload)
    const wireguardResult = parseWireguardApplyResult(result)

    const [existing] = await db
      .select({
        listenPort: peer.listenPort,
        publicKey: peer.publicKey,
      })
      .from(peer)
      .where(and(eq(peer.id, payload.peerId), eq(peer.vpnId, payload.vpnId)))
      .limit(1)

    const filledNullKey = !existing?.publicKey ||
      !isValidWireguardPublicKey(existing.publicKey)

    const updatedAt = nowIso()
    const patch: {
      publicKey: string
      updatedAt: string
      listenPort?: number
    } = {
      publicKey: wireguardResult.publicKey,
      updatedAt,
    }
    if (
      wireguardResult.listenPort !== undefined &&
      existing?.listenPort === null
    ) {
      patch.listenPort = wireguardResult.listenPort
    }

    await db
      .update(peer)
      .set(patch)
      .where(and(eq(peer.id, payload.peerId), eq(peer.vpnId, payload.vpnId)))

    const commandQueue = deps?.commandQueue
    if (
      filledNullKey &&
      commandQueue &&
      !isNoopCommandQueue(commandQueue)
    ) {
      try {
        await maybeEnqueueVpnMeshComplete({
          db,
          commandQueue,
          resealDeps: deps?.resealDeps,
          actorType: record.actorEntityType,
          actorId: record.actorEntityId,
          vpnId: payload.vpnId,
          filledNullKey: true,
        })
      } catch (followUpErr) {
        const message = followUpErr instanceof Error
          ? followUpErr.message
          : String(followUpErr)
        compatLogWarn(
          'command-consumer',
          `wireguard mesh-complete follow-up failed for command ${record.id}: ${message}`,
        )
      }
    }
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      compatLogWarn(
        'command-consumer',
        `wireguard public key reconcile conflict for command ${record.id}`,
      )
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'command-consumer',
      `wireguard side effect failed for command ${record.id}: ${message}`,
    )
  }
}

async function reconcileContainersSafely(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  environmentId: string,
  containers: Parameters<typeof reconcileEnvironmentContainers>[1]['containers'],
): Promise<void> {
  try {
    await reconcileEnvironmentContainers(db, {
      serverId: envelope.serverId,
      environmentId,
      containers,
    })
  } catch (err) {
    const message = errorMessage(err)
    commandConsumerTrace('dispatch-result', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      resultStatus: 'succeeded',
      containerReconcileError: message,
    })
    compatLogWarn(
      'command-consumer',
      `container reconcile failed for command ${record.id}: ${message}`,
    )
  }
}

async function applyEnvironmentDeploySideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'environment.deploy') return
  try {
    const { environmentId } = parseEnvironmentDeployPayload(record.payload)
    const deployResult = parseEnvironmentDeployResult(result)
    // Only reconcile when the daemon included an authoritative containers
    // report (including `[]`). Omitting the field means collection failed.
    if (deployResult.containers === undefined) return
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      environmentId,
      deployResult.containers,
    )
  } catch (err) {
    const message = errorMessage(err)
    commandConsumerTrace('dispatch-result', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      resultStatus: 'succeeded',
      containerReconcileError: message,
    })
    compatLogWarn(
      'command-consumer',
      `container reconcile failed for command ${record.id}: ${message}`,
    )
  }
}

async function applyEnvironmentStopSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'environment.stop') return
  try {
    const { environmentId } = parseEnvironmentStopPayload(record.payload)
    const stopResult = parseEnvironmentStopResult(result)
    if (stopResult.containers === undefined) return
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      environmentId,
      stopResult.containers,
    )
  } catch (err) {
    const message = errorMessage(err)
    commandConsumerTrace('dispatch-result', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      resultStatus: 'succeeded',
      containerReconcileError: message,
    })
    compatLogWarn(
      'command-consumer',
      `container reconcile failed for command ${record.id}: ${message}`,
    )
  }
}

async function applyEnvironmentLifecycleSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'environment.lifecycle') return
  try {
    const { environmentId } = parseEnvironmentLifecyclePayload(record.payload)
    const lifecycleResult = parseEnvironmentLifecycleResult(result)
    // Live `compose ps` rows update pins; omitted field means collection failed.
    if (lifecycleResult.containers === undefined) return
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      environmentId,
      lifecycleResult.containers,
    )
  } catch (err) {
    const message = errorMessage(err)
    commandConsumerTrace('dispatch-result', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      resultStatus: 'succeeded',
      containerReconcileError: message,
    })
    compatLogWarn(
      'command-consumer',
      `container reconcile failed for command ${record.id}: ${message}`,
    )
  }
}

async function applyManagedApplySideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'managed.apply') return
  try {
    const payload = parseManagedApplyPayload(record.payload)
    const applyResult = parseManagedApplyResult(result)
    const updatedAt = nowIso()
    await db
      .update(managed)
      .set({
        status: 'ready',
        serverId: envelope.serverId,
        metadata: sql`COALESCE(${managed.metadata}, '{}'::jsonb) || ${
          JSON.stringify({ host: applyResult.host, port: applyResult.port })
        }::jsonb`,
        updatedAt,
      })
      .where(eq(managed.id, payload.managedId))
    if (applyResult.containers !== undefined) {
      await reconcileContainersSafely(
        db,
        record,
        envelope,
        payload.environmentId,
        applyResult.containers,
      )
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.apply side effect failed for command ${record.id}: ${message}`,
    )
  }
}

/** Observed statuses the consumer may project onto `managed.status`. */
const MANAGED_OBSERVED_STATUSES = new Set(['ready', 'stopped', 'failed'])

function isManagedObservedStatus(
  value: string,
): value is 'ready' | 'stopped' | 'failed' {
  return MANAGED_OBSERVED_STATUSES.has(value)
}

async function projectManagedObservedStatus(
  db: Db,
  managedId: string,
  status: string,
  commandId: string,
  commandType: string,
): Promise<void> {
  if (!isManagedObservedStatus(status)) {
    compatLogWarn(
      'command-consumer',
      `ignored non-projectable managed status ${JSON.stringify(status)} for ${commandType} command ${commandId}`,
    )
    return
  }
  await db
    .update(managed)
    .set({
      status,
      updatedAt: nowIso(),
    })
    .where(eq(managed.id, managedId))
}

async function applyManagedLifecycleSideEffect(
  db: Db,
  record: CommandRecord,
  _envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'managed.lifecycle') return
  try {
    const payload = parseManagedLifecyclePayload(record.payload)
    const lifecycleResult = parseManagedLifecycleResult(result)
    await projectManagedObservedStatus(
      db,
      payload.managedId,
      lifecycleResult.status,
      record.id,
      record.type,
    )
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.lifecycle side effect failed for command ${record.id}: ${message}`,
    )
  }
}

/** Cap mirrors the bounded list enforced by `parseManagedRowOptions`/`validateBackups`. */
const MAX_BACKUP_RECORDS = 200

async function applyManagedBackupSideEffect(
  db: Db,
  record: CommandRecord,
  _envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'managed.backup') return
  try {
    const payload = parseManagedBackupPayload(record.payload)
    const backupResult = parseManagedBackupResult(result)

    const [row] = await db
      .select({ options: managed.options })
      .from(managed)
      .where(eq(managed.id, payload.managedId))
      .limit(1)
    if (!row) return

    const spec = getManagedEngineSpec(payload.engine)
    if (!spec) return
    const current = parseManagedRowOptions(spec, row.options)
    if (!current) return

    const prunedIds = new Set(backupResult.pruned ?? [])
    let backups = current.backups.filter((entry) => !prunedIds.has(entry.id))

    if (payload.action === 'delete') {
      backups = backups.filter((entry) => entry.id !== payload.backupId)
    } else if (
      backupResult.path !== undefined &&
      backupResult.sizeBytes !== undefined &&
      backupResult.checksum !== undefined
    ) {
      const created: ManagedBackupRecord = {
        id: backupResult.backupId,
        createdAt: backupResult.completedAt ?? nowIso(),
        sizeBytes: backupResult.sizeBytes,
        checksum: backupResult.checksum,
        path: backupResult.path,
      }
      if (backupResult.database !== undefined) created.database = backupResult.database
      backups = [
        created,
        ...backups.filter((entry) => entry.id !== created.id),
      ].slice(0, MAX_BACKUP_RECORDS)
    }

    const nextOptions = writeManagedRowOptions({
      settings: current.settings,
      databases: current.databases,
      backups,
    })
    await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: nowIso() })
      .where(eq(managed.id, payload.managedId))
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.backup side effect failed for command ${record.id}: ${message}`,
    )
  }
}

async function applyManagedRestoreSideEffect(
  db: Db,
  record: CommandRecord,
  _envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'managed.restore') return
  try {
    const payload = parseManagedRestorePayload(record.payload)
    // Result parser is lenient; a successful restore always projects `ready`
    // regardless of whether the daemon included an optional `status` field.
    parseManagedRestoreResult(result)
    await projectManagedObservedStatus(
      db,
      payload.managedId,
      'ready',
      record.id,
      record.type,
    )
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.restore side effect failed for command ${record.id}: ${message}`,
    )
  }
}

async function applyManagedDestroySideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'managed.destroy') return
  try {
    const payload = parseManagedDestroyPayload(record.payload)
    const destroyResult = parseManagedDestroyResult(result)
    await projectManagedObservedStatus(
      db,
      payload.managedId,
      destroyResult.status,
      record.id,
      record.type,
    )
    const [row] = await db
      .select({ environmentId: managed.environmentId })
      .from(managed)
      .where(eq(managed.id, payload.managedId))
      .limit(1)
    if (!row) return
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      row.environmentId,
      destroyResult.containers,
    )

    // `applyManagedDestroySideEffect` only runs from `applySucceededSideEffects`
    // (the command already reported `succeeded`), so a `deleteAfterDestroy`
    // marker here always means the daemon actually tore down the runtime.
    // Delete the `managed` row so `principal.managed_id` cascades — this is
    // the API-delete completion, distinct from any future "destroy runtime
    // only" action that would omit the marker and leave the row in place.
    if (payload.deleteAfterDestroy) {
      await db.delete(managed).where(eq(managed.id, payload.managedId))
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.destroy side effect failed for command ${record.id}: ${message}`,
    )
  }
}

function resolveManagedIdFromPayload(
  type: string,
  payload: unknown,
): string | null {
  try {
    if (type === 'managed.apply') {
      return parseManagedApplyPayload(payload).managedId
    }
    if (type === 'managed.lifecycle') {
      return parseManagedLifecyclePayload(payload).managedId
    }
    if (type === 'managed.destroy') {
      return parseManagedDestroyPayload(payload).managedId
    }
    if (type === 'managed.restore') {
      return parseManagedRestorePayload(payload).managedId
    }
  } catch {
    return null
  }
  return null
}

/**
 * Mark the managed row failed when apply/lifecycle/destroy/restore fail or
 * time out. `managed.backup` is deliberately excluded — a read-only backup
 * failure must never mark an otherwise-healthy engine `failed`. Does not
 * alter terminal command-row semantics — only `managed.status`.
 */
async function applyManagedFailedSideEffect(
  db: Db,
  record: CommandRecord,
): Promise<void> {
  if (
    record.type !== 'managed.apply' &&
    record.type !== 'managed.lifecycle' &&
    record.type !== 'managed.destroy' &&
    record.type !== 'managed.restore'
  ) {
    return
  }
  try {
    const managedId = resolveManagedIdFromPayload(record.type, record.payload)
    if (!managedId) return
    await db
      .update(managed)
      .set({
        status: 'failed',
        updatedAt: nowIso(),
      })
      .where(eq(managed.id, managedId))
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed failure side effect failed for command ${record.id}: ${message}`,
    )
  }
}

async function applySucceededSideEffects(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps,
): Promise<void> {
  await applyHostnameSideEffect(db, record, envelope, result)
  await applyTimeSyncSideEffect(db, record, envelope, result)
  await applyWireguardSideEffect(db, record, envelope, result, deps)
  await applyEnvironmentDeploySideEffect(db, record, envelope, result)
  await applyEnvironmentStopSideEffect(db, record, envelope, result)
  await applyEnvironmentLifecycleSideEffect(db, record, envelope, result)
  await applyManagedApplySideEffect(db, record, envelope, result)
  await applyManagedLifecycleSideEffect(db, record, envelope, result)
  await applyManagedDestroySideEffect(db, record, envelope, result)
  await applyManagedBackupSideEffect(db, record, envelope, result)
  await applyManagedRestoreSideEffect(db, record, envelope, result)
}

async function handlePendingDone(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
  deps?: CommandConsumerDeps,
): Promise<void> {
  await transitionCommand(db, record.id, {
    status: 'succeeded',
    result: enrichPingResult(record.type, pending.result, pending),
    ackedAt: pending.ackAt ?? pending.finishedAt,
    startedAt: pending.ackAt ?? pending.finishedAt,
    finishedAt: pending.finishedAt,
  })
  commandConsumerTrace('dispatch-result', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    pendingStatus: pending.status,
    resultStatus: 'succeeded',
  })
  await applySucceededSideEffects(db, record, envelope, pending.result, deps)
}

async function handlePendingFailed(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
): Promise<void> {
  const error = pending.error ?? 'Command failed'
  await transitionCommand(db, record.id, {
    status: 'failed',
    error,
  })
  commandConsumerTrace('dispatch-result', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    pendingStatus: pending.status,
    resultStatus: 'failed',
    error,
  })
  await applyManagedFailedSideEffect(db, record)
}

async function handlePendingExpired(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
): Promise<void> {
  await transitionCommand(db, record.id, { status: 'timed_out' })
  commandConsumerTrace('dispatch-result', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    pendingStatus: pending.status,
    resultStatus: 'timed_out',
  })
  await applyManagedFailedSideEffect(db, record)
}

async function handlePendingUnexpected(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
): Promise<void> {
  const error = `Unexpected pending request status: ${pending.status}`
  await transitionCommand(db, record.id, {
    status: 'failed',
    error,
  })
  commandConsumerTrace('dispatch-result', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    pendingStatus: pending.status,
    resultStatus: 'failed',
    error,
  })
}

async function applyPendingOutcome(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
  deps?: CommandConsumerDeps,
): Promise<void> {
  switch (pending.status) {
    case 'done':
      await handlePendingDone(db, record, envelope, pending, deps)
      return
    case 'failed':
      await handlePendingFailed(db, record, envelope, pending)
      return
    case 'expired':
      await handlePendingExpired(db, record, envelope, pending)
      return
    default:
      await handlePendingUnexpected(db, record, envelope, pending)
  }
}

export async function processCommandEnvelope(
  db: Db,
  registry: DaemonCellRegistry,
  envelope: CommandEnvelope,
  deps?: CommandConsumerDeps,
): Promise<void> {
  const record = await loadDispatchableRecord(db, envelope)
  if (!record) return

  await markDispatching(db, record, envelope)

  const ready = await ensureServerAndDaemonOnline(db, registry, record, envelope)
  if (!ready) return

  const pending = await enqueueAndAwaitOutcome(db, registry, record, envelope)
  if (!pending) return

  await applyPendingOutcome(db, record, envelope, pending, deps)
}
