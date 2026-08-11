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
  createCommandRecord,
  getCommandMetadata,
  getCommandRecord,
  transitionCommand,
  type CommandRecord,
} from '../db/command-records.ts'
import { reconcileEnvironmentContainers } from '../db/container-records.ts'
import { managed, node, peer, server } from '../db/schema.ts'
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
  type ManagedDestroyCommandPayload,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedLifecyclePayload,
  parseManagedLifecycleResult,
  parseManagedPromotePayload,
  parseManagedPromoteResult,
  parseManagedRestorePayload,
  parseManagedRestoreResult,
  parseNtpSetResult,
  parsePingResult,
  parseSystemReconcilePayload,
  parseSystemReconcileResult,
  parseTimezoneSetResult,
  parseWireguardApplyPayload,
  parseWireguardApplyResult,
} from './schemas.ts'
import { updateManagedMemberObservedReplication } from '../../client/managed/members.ts'
import { isValidWireguardPublicKey } from './wireguard.ts'
import { TERMINAL_COMMAND_STATUSES, type CommandType } from './types.ts'

import type { SecretsConfig, DerivedSecretsConfig } from '../../client/authn/secrets.ts'

/** Optional deps for follow-up WireGuard mesh-complete and managed-ingress applies. */
export type CommandConsumerDeps = {
  commandQueue?: CommandQueue
  resealDeps?: VpnApplyResealDeps
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
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
  'managed.promote': 600_000,
  'managed.ingress.reconcile': 300_000,
  'system.reconcile': 300_000,
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

/** Per-type consumer wait budget; unknown types fall back to 60s. */
export function commandTimeoutMs(type: string): number {
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
    type === 'managed.restore' ||
    type === 'managed.promote' ||
    type === 'managed.ingress.reconcile' ||
    type === 'system.reconcile'
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

/** Best-effort hostname from a successful `server.hostname.set` result. */
export function extractObservedHostname(result: unknown): string | null {
  try {
    return parseHostnameSetResult(result).observedHostname
  } catch {
    return null
  }
}

/** Attach `cellDispatchedAt` for ping latency when the cell recorded `sentAt`. */
export function enrichPingResult(
  type: string,
  result: unknown,
  pending: { sentAt?: string },
): unknown {
  if (type !== 'daemon.ping') return result
  const parsed = parsePingResult(result)
  if (!pending.sentAt) return parsed
  return { ...parsed, cellDispatchedAt: pending.sentAt }
}

export function errorMessage(err: unknown): string {
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

export function isPostgresUniqueViolation(err: unknown): boolean {
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
  expectedAllocations?: Parameters<
    typeof reconcileEnvironmentContainers
  >[1]['expectedAllocations'],
): Promise<void> {
  try {
    await reconcileEnvironmentContainers(db, {
      serverId: envelope.serverId,
      environmentId,
      containers,
      ...(expectedAllocations ? { expectedAllocations } : {}),
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

async function applySystemReconcileSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
): Promise<void> {
  if (record.type !== 'system.reconcile') return
  try {
    const payload = parseSystemReconcilePayload(record.payload)
    const reconcileResult = parseSystemReconcileResult(result)
    // Omitted containers = collection failed — skip reconcile. Trust only
    // the payload's environmentId (never a daemon-supplied one).
    if (reconcileResult.containers === undefined) return
    // Pass expected (serviceId, role, ordinal) so a partial self-host report
    // resets missing component rows instead of deleting preallocated identity.
    const expectedAllocations = payload.components.map((component) => ({
      serviceId: component.serviceId,
      role: component.role,
      ordinal: 1,
    }))
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      payload.environmentId,
      reconcileResult.containers,
      expectedAllocations,
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
  deps?: CommandConsumerDeps,
): Promise<void> {
  if (record.type !== 'managed.apply') return
  try {
    const payload = parseManagedApplyPayload(record.payload)
    const applyResult = parseManagedApplyResult(result)
    const updatedAt = nowIso()
    // `managed.server_id` is the primary placement pin. Fan-out apply sends one
    // command per member — only the primary member may update the pin / host /
    // port so a late replica success cannot re-home the cluster.
    if (payload.memberRole === 'primary') {
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
    } else {
      await db
        .update(managed)
        .set({
          status: 'ready',
          updatedAt,
        })
        .where(eq(managed.id, payload.managedId))
    }
    if (applyResult.containers !== undefined) {
      await reconcileContainersSafely(
        db,
        record,
        envelope,
        payload.environmentId,
        applyResult.containers,
      )
    }
    await projectManagedMemberObservedStatus(db, applyResult.member, record.id, record.type)

    // Primary success → enqueue deferred standby applies (if any).
    if (
      payload.memberRole === 'primary' &&
      deps?.commandQueue &&
      !isNoopCommandQueue(deps.commandQueue)
    ) {
      await enqueuePendingStandbyApplies(db, record, deps)
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.apply side effect failed for command ${record.id}: ${message}`,
    )
  }
}

type PendingStandbyApply = {
  serverId: string
  memberId: string
  payload: unknown
}

async function enqueuePendingStandbyApplies(
  db: Db,
  record: CommandRecord,
  deps: CommandConsumerDeps,
): Promise<void> {
  const meta = await getCommandMetadata(db, record.id)
  const raw = meta?.pendingStandbyApplies
  if (!Array.isArray(raw) || raw.length === 0) return

  const commandQueue = deps.commandQueue!
  for (const entry of raw) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as PendingStandbyApply).serverId !== 'string' ||
      typeof (entry as PendingStandbyApply).memberId !== 'string'
    ) {
      continue
    }
    const standby = entry as PendingStandbyApply
    let payload: unknown
    try {
      payload = parseManagedApplyPayload(standby.payload)
    } catch {
      continue
    }
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    try {
      const next = await createCommandRecord(db, {
        serverId: standby.serverId,
        actorType: record.actorEntityType,
        actorId: record.actorEntityId,
        type: 'managed.apply',
        payload,
        expiresAt,
      })
      const envelope: CommandEnvelope = {
        commandId: next.id,
        serverId: standby.serverId,
        type: 'managed.apply',
        attempt: 1,
        queuedAt: next.queuedAt ?? next.createdAt,
      }
      try {
        await commandQueue.enqueue(envelope)
      } catch {
        await transitionCommand(db, next.id, {
          status: 'failed',
          error: 'Command queue unavailable',
        })
      }
    } catch (err) {
      const message = errorMessage(err)
      compatLogWarn(
        'command-consumer',
        `standby apply follow-up failed for command ${record.id}: ${message}`,
      )
    }
  }
}

/** Observed statuses the consumer may project onto `managed.status`. */
const MANAGED_OBSERVED_STATUSES = new Set(['ready', 'stopped', 'failed'])

/**
 * Project daemon-observed per-member status + replication health onto
 * `node`. Only what the daemon reported — never reverse-inferred.
 */
async function projectManagedMemberObservedStatus(
  db: Db,
  member:
    | {
        memberId: string
        status: string
        replication?: {
          state: string
          lagBytes?: number
          lagSeconds?: number
          observedAt: string
        }
      }
    | undefined,
  commandId: string,
  commandType: string,
): Promise<void> {
  if (member === undefined) return
  try {
    await updateManagedMemberObservedReplication(db, member.memberId, {
      status: member.status,
      ...(member.replication !== undefined
        ? { replication: member.replication }
        : {}),
    })
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed member projection failed for ${commandType} command ${commandId}: ${message}`,
    )
  }
}

export function isManagedObservedStatus(
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
  deps?: CommandConsumerDeps,
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
    await projectManagedMemberObservedStatus(
      db,
      lifecycleResult.member,
      record.id,
      record.type,
    )

    // Fence-then-promote: only enqueue promote after a successful fence stop.
    if (
      payload.action === 'stop' &&
      deps?.commandQueue &&
      !isNoopCommandQueue(deps.commandQueue)
    ) {
      const meta = await getCommandMetadata(db, record.id)
      const followUp = meta?.followUpPromote as
        | { serverId: string; payload: unknown }
        | undefined
      if (followUp && typeof followUp.serverId === 'string') {
        try {
          const promotePayload = parseManagedPromotePayload(followUp.payload)
          const expiresAt = new Date(Date.now() + 600_000).toISOString()
          const next = await createCommandRecord(db, {
            serverId: followUp.serverId,
            actorType: record.actorEntityType,
            actorId: record.actorEntityId,
            type: 'managed.promote',
            payload: promotePayload,
            expiresAt,
          })
          await deps.commandQueue.enqueue({
            commandId: next.id,
            serverId: followUp.serverId,
            type: 'managed.promote',
            attempt: 1,
            queuedAt: next.queuedAt ?? next.createdAt,
          })
        } catch (err) {
          const message = errorMessage(err)
          compatLogWarn(
            'command-consumer',
            `promote follow-up after fence failed for ${record.id}: ${message}`,
          )
        }
      }
    }
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

/**
 * Narrows `deps` to the shape required to enqueue managed follow-up commands
 * (primary re-apply after member destroy, ProxySQL ingress reconcile) — a
 * live, non-noop queue plus the secrets needed to reseal credentials.
 */
export function hasManagedFollowUpDeps(deps: CommandConsumerDeps | undefined): deps is CommandConsumerDeps & {
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
} {
  return Boolean(
    deps?.commandQueue &&
      deps.secretsConfig &&
      deps.dataEncryptionSecrets &&
      !isNoopCommandQueue(deps.commandQueue),
  )
}

/** Primary re-apply for slot cleanup is stamped on metadata as `pendingPrimaryReapply`. */
async function reapplyPrimaryAfterMemberDestroy(
  db: Db,
  record: CommandRecord,
  deps: CommandConsumerDeps & { commandQueue: CommandQueue },
): Promise<void> {
  const meta = await getCommandMetadata(db, record.id)
  const reapply = meta?.pendingPrimaryReapply as
    | { serverId: string; payload: unknown }
    | undefined
  if (!reapply || typeof reapply.serverId !== 'string') return
  try {
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    const next = await createCommandRecord(db, {
      serverId: reapply.serverId,
      actorType: record.actorEntityType,
      actorId: record.actorEntityId,
      type: 'managed.apply',
      payload: parseManagedApplyPayload(reapply.payload),
      expiresAt,
    })
    await deps.commandQueue.enqueue({
      commandId: next.id,
      serverId: reapply.serverId,
      type: 'managed.apply',
      attempt: 1,
      queuedAt: next.queuedAt ?? next.createdAt,
    })
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `primary re-apply after member destroy failed for ${record.id}: ${message}`,
    )
  }
}

/**
 * Member-delete path: remove the member only after destroy confirms success,
 * then re-apply the primary so slots shrink (orphaned slot cleanup).
 */
async function cleanupDestroyedMember(
  db: Db,
  record: CommandRecord,
  payload: ManagedDestroyCommandPayload,
  deps: CommandConsumerDeps | undefined,
): Promise<void> {
  if (!payload.deleteMemberAfterDestroy || !payload.memberId) return
  await db.delete(node).where(eq(node.id, payload.memberId))
  if (hasManagedFollowUpDeps(deps)) {
    await reapplyPrimaryAfterMemberDestroy(db, record, deps)
  }
}

/** Reconcile ProxySQL so destroyed members leave the frontend backends. */
async function reconcileManagedIngressAfterDestroy(
  db: Db,
  envelope: CommandEnvelope,
  deps: CommandConsumerDeps | undefined,
): Promise<void> {
  if (!hasManagedFollowUpDeps(deps)) return
  const { enqueueManagedIngressReconcile } = await import(
    '../../client/managed/ingress-desired.ts'
  )
  await enqueueManagedIngressReconcile(db, deps.commandQueue, {
    serverId: envelope.serverId,
    actorType: 'system',
    actorId: envelope.serverId,
    secretsConfig: deps.secretsConfig,
    dataEncryptionSecrets: deps.dataEncryptionSecrets,
  })
}

async function applyManagedDestroySideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps,
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

    await cleanupDestroyedMember(db, record, payload, deps)
    await reconcileManagedIngressAfterDestroy(db, envelope, deps)
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.destroy side effect failed for command ${record.id}: ${message}`,
    )
  }
}

export function resolveManagedIdFromPayload(
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
    if (type === 'managed.promote') {
      return parseManagedPromotePayload(payload).managedId
    }
  } catch {
    return null
  }
  return null
}

/**
 * Member id on a failed managed command payload (apply always has one;
 * lifecycle/destroy/promote when fan-out targets a single node).
 * Does not invent ids — only what the typed payload already carried.
 */
export function resolveManagedMemberIdFromFailedPayload(
  type: string,
  payload: unknown,
): string | null {
  try {
    if (type === 'managed.apply') {
      return parseManagedApplyPayload(payload).memberId
    }
    if (type === 'managed.lifecycle') {
      return parseManagedLifecyclePayload(payload).memberId ?? null
    }
    if (type === 'managed.destroy') {
      return parseManagedDestroyPayload(payload).memberId ?? null
    }
    if (type === 'managed.promote') {
      return parseManagedPromotePayload(payload).memberId
    }
  } catch {
    return null
  }
  return null
}

/**
 * Mark the managed row failed when apply/lifecycle/destroy/restore/promote fail
 * or time out. `managed.backup` is deliberately excluded — a read-only backup
 * failure must never mark an otherwise-healthy engine `failed`.
 *
 * Also marks the targeted `node` failed when the payload names a member —
 * otherwise UI cluster rows stay stuck on `provisioning` after a failed apply
 * while only `managed.status` flipped to `failed`.
 *
 * Does not alter terminal command-row semantics.
 */
async function applyManagedFailedSideEffect(
  db: Db,
  record: CommandRecord,
): Promise<void> {
  if (
    record.type !== 'managed.apply' &&
    record.type !== 'managed.lifecycle' &&
    record.type !== 'managed.destroy' &&
    record.type !== 'managed.restore' &&
    record.type !== 'managed.promote'
  ) {
    return
  }
  try {
    const managedId = resolveManagedIdFromPayload(record.type, record.payload)
    if (!managedId) return
    const updatedAt = nowIso()
    await db
      .update(managed)
      .set({
        status: 'failed',
        updatedAt,
      })
      .where(eq(managed.id, managedId))

    const memberId = resolveManagedMemberIdFromFailedPayload(
      record.type,
      record.payload,
    )
    if (memberId) {
      await db
        .update(node)
        .set({
          status: 'failed',
          updatedAt,
        })
        .where(eq(node.id, memberId))
    }
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
  await applySystemReconcileSideEffect(db, record, envelope, result)
  await applyManagedApplySideEffect(db, record, envelope, result, deps)
  await applyManagedLifecycleSideEffect(db, record, envelope, result, deps)
  await applyManagedDestroySideEffect(db, record, envelope, result, deps)
  await applyManagedPromoteSideEffect(db, record, envelope, result, deps)
  await applyManagedBackupSideEffect(db, record, envelope, result)
  await applyManagedRestoreSideEffect(db, record, envelope, result)
}

/**
 * After a successful promote: demote the old primary **before** promoting so
 * `uniq_node_primary` is never violated mid-flip, then re-point
 * `managed.server_id`, project health, and re-reconcile ProxySQL.
 */
async function applyManagedPromoteSideEffect(
  db: Db,
  record: CommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps,
): Promise<void> {
  if (record.type !== 'managed.promote') return
  try {
    const promoteResult = parseManagedPromoteResult(result)
    const payload = parseManagedPromotePayload(record.payload)
    const managedId = payload.managedId
    const promotedMemberId = promoteResult.promotedMemberId || payload.memberId
    const demotedMemberId =
      promoteResult.demotedMemberId ?? payload.demoteMemberId
    const updatedAt = nowIso()

    await db.transaction(async (tx) => {
      // Demote first so the partial unique primary index stays satisfied.
      if (demotedMemberId) {
        await tx
          .update(node)
          .set({
            role: 'replica',
            status: 'needs_resync',
            updatedAt,
          })
          .where(
            and(
              eq(node.id, demotedMemberId),
              eq(node.managedId, managedId),
            ),
          )
      }

      if (!promotedMemberId) return

      await tx
        .update(node)
        .set({
          role: 'primary',
          status: promoteResult.status || 'ready',
          updatedAt,
        })
        .where(
          and(
            eq(node.id, promotedMemberId),
            eq(node.managedId, managedId),
          ),
        )

      const [promoted] = await tx
        .select({ serverId: node.serverId })
        .from(node)
        .where(eq(node.id, promotedMemberId))
        .limit(1)

      if (promoted) {
        await tx
          .update(managed)
          .set({
            status: 'ready',
            serverId: promoted.serverId,
            updatedAt,
          })
          .where(eq(managed.id, managedId))
      } else {
        await tx
          .update(managed)
          .set({ status: 'ready', updatedAt })
          .where(eq(managed.id, managedId))
      }
    })

    if (promotedMemberId && promoteResult.replication !== undefined) {
      await updateManagedMemberObservedReplication(db, promotedMemberId, {
        status: promoteResult.status || 'ready',
        replication: promoteResult.replication,
      })
    }

    if (
      !deps?.commandQueue ||
      !deps.secretsConfig ||
      !deps.dataEncryptionSecrets ||
      isNoopCommandQueue(deps.commandQueue)
    ) {
      return
    }

    const memberServers = await db
      .select({ serverId: node.serverId })
      .from(node)
      .where(eq(node.managedId, managedId))
    const serverIds = new Set(
      memberServers.map((row) => row.serverId).concat(envelope.serverId),
    )
    const { enqueueManagedIngressReconcile } = await import(
      '../../client/managed/ingress-desired.ts'
    )
    for (const serverId of serverIds) {
      await enqueueManagedIngressReconcile(db, deps.commandQueue, {
        serverId,
        actorType: 'system',
        actorId: envelope.serverId,
        secretsConfig: deps.secretsConfig,
        dataEncryptionSecrets: deps.dataEncryptionSecrets,
      })
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.promote side effect failed for command ${record.id}: ${message}`,
    )
  }
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
