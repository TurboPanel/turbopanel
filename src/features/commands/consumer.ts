/**
 * **Status projection:** The consumer is the single writer of terminal `command` rows.
 * The WS inbound path (`handleInbound` in `redis/cell.ts` and `do.ts`) only updates the
 * hot `PendingRequestRecord` in the cell. The consumer reads the terminal
 * `PendingRequestRecord` returned by `waitForRequest` and maps it to a
 * `transitionCommand` call. Polling for terminal status runs in the caller
 * isolate (worker stub or Deno process), not inside the Durable Object.
 * There is no per-server polling or cross-cell fan-out.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../../contracts/cell.ts'
import { generateDeliveryId } from '../../contracts/cell-protocol.ts'
import { resultSummaryForPersist } from './result-summary.ts'
import { getResolveFleetPresence } from '../../platform/ports/fleet-presence.ts'
import { getServerLicenseBinding, touchServerMetadata } from '../servers/server-registry.ts'
import { commandConsumerTrace } from '../../lib/logger.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  claimCommandMetadataFlag,
  type CommandRecord,
  createCommandRecord,
  getCommandDispatchPayload,
  getCommandMetadata,
  getCommandRecord,
  transitionCommand,
} from './command-records.ts'
import { reconcileEnvironmentContainers } from '../environments/container-records.ts'
import { recordDeployedSiteApps } from '../environments/app-facts.ts'
import {
  classifyDeployFailure,
  DEPLOY_CANCELLED_ERROR_CODE,
  deployOutcomeErrorCode,
  isCancelledDeployError,
} from '../deploy/deploy-outcome.ts'
import {
  advanceRollout,
  failTimedOutDeploy,
  failDeployByContext,
  haltRollout,
} from '../deploy/rollout.ts'
import {
  deploymentDurationMs,
  type DeploymentOutcome,
  markDeploymentApplied,
  markDeploymentFailed,
} from '../deploy/deployment-records.ts'
import {
  clearRelayAppliedPayloadHash,
  getFabricById,
  stampRelayPublicKey,
  stampRelayReconcileSuccess,
} from '../fabric/fabric-records.ts'
import { reconcileFabricMembership } from '../fabric/enqueue.ts'
import {
  command,
  container,
  managed,
  replica,
  server,
  service,
  storage,
  storageCopy,
} from '../../db/schema.ts'
import {
  MANAGED_DESTROY_GATE_CLAIM_KEY,
  MANAGED_DESTROY_GATE_METADATA_KEY,
  parseManagedDestroyGate,
} from '../managed/destroy-gate.ts'
import { deleteManagedBackup, insertManagedBackup } from '../backups/backup-records.ts'
import { applyStorageBackupSideEffect } from '../backups/storage-command-effects.ts'
import { applyBackupsReconcileSideEffect } from '../backups/reconcile-effects.ts'
import {
  commandMayChangeFirewallPreview,
  enqueueFirewallPreview,
  FIREWALL_RECONCILE_COMMAND,
  recordFirewallPreviewFailure,
  recordFirewallPreviewResult,
} from '../firewall/preview.ts'
import type { FirewallApplyGate } from '../firewall/enforcement.ts'
import type { CommandEnvelope } from './envelope.ts'
import { nowIso } from './ids.ts'
import { isNoopCommandQueue } from './noop-command-queue.ts'
import {
  captureManagedBackupHost,
  enqueueBackupsReconcile,
  reconcileBackupsAfterManagedMove,
} from '../backups/reconcile.ts'
import type { CommandQueue } from './queue.ts'
import {
  type ManagedDestroyCommandPayload,
  parseEnvironmentDeployPayload,
  parseEnvironmentDeployResult,
  type EnvironmentDeployResultSite,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentLifecycleResult,
  parseEnvironmentStopPayload,
  parseEnvironmentStopResult,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
  parseHostnameSetResult,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedHaFailoverPayload,
  parseManagedHaFailoverResult,
  parseManagedHaReconcilePayload,
  parseManagedHaReconcileResult,
  parseManagedIngressReconcilePayload,
  parseManagedIngressReconcileResult,
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
} from '../../contracts/commands/schemas.ts'
import { updateManagedMemberObservedReplication } from '../managed/members.ts'
import { findManagedHaHierarchy, findManagedIngressHierarchy } from '../system/hierarchy.ts'
import {
  commitPendingTlsLeafTracking,
  parsePendingTlsLeafValue,
  pendingTlsLeafMetadata,
} from '../tls/leaf-tracking.ts'
import {
  fencePhaseFromCommandMetadata,
  onFenceCommandFailed,
  onFenceCommandSucceeded,
  onPromoteSucceeded,
  logRecoveryAdvanceFailure,
  onRecoveryCommandFailed,
  onRecoveryStepFailed,
  recoveryIdFromCommandMetadata,
} from '../managed/ha-recovery.ts'
import { isManagedEngineCode, type ManagedEngineCode } from '../managed/types.ts'
import { isValidWireguardPublicKey } from '../fabric/wg.ts'
import { type CommandType, TERMINAL_COMMAND_STATUSES } from './types.ts'

import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { daemonUnsupportedReason, resolveDaemonSupport } from '../../lib/version-wire.ts'

export { isPostgresUniqueViolation } from '../../db/unique-violation.ts'

/** Secrets used to reseal command payloads onto a target daemon key. */
export type CommandResealDeps = {
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

/** Optional deps for follow-up mesh-complete and managed-ingress applies. */
export type CommandConsumerDeps = {
  commandQueue?: CommandQueue
  resealDeps?: CommandResealDeps
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
  /** The deploy-time firewall apply key; required so a dropped gate fails the type check. */
  firewallApplyGate: FirewallApplyGate
}

const COMMAND_TIMEOUT_MS: Record<CommandType, number> = {
  'daemon.ping': 30_000,
  'server.hostname.set': 120_000,
  'server.ntp.set': 300_000,
  'server.reboot': 120_000,
  'server.timezone.set': 300_000,
  'server.fabric.reconcile': 300_000,
  'server.tls.trust.reconcile': 300_000,
  // Writes a handful of small files, runs `sshd -t`, reloads. Nothing here
  // installs a package or waits on the network.
  'server.principals.reconcile': 120_000,
  // A handful of iptables calls, an sshd -T, two restores. No package install,
  // no network wait; the xtables lock wait is bounded at 5 s per call.
  'server.firewall.reconcile': 120_000,
  // One file move and one systemctl stop; confirms are small and must not queue behind work.
  'server.firewall.confirm': 60_000,
  // Writes a few unit files, one daemon-reload, enables what moved. No dump runs here.
  'server.backups.reconcile': 120_000,
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
  'managed.ha.reconcile': 300_000,
  'managed.ha.failover': 600_000,
  // Streams one volume archive to disk; sized like managed.backup.
  'storage.backup': 1_800_000,
  // Stops the copy's containers, extracts one archive, starts them again.
  'storage.restore': 1_800_000,
  'system.reconcile': 300_000,
}

/**
 * A command plus its daemon execution payload, loaded once from `dispatch` at
 * the start of processing. The payload never lives on the permanent `command`
 * row, and `transitionCommand` cleans it up on any terminal transition
 * (deleted on success, retained ~24h on failure — see `command-records.ts`).
 */
export type DispatchableCommandRecord = CommandRecord & { payload: unknown }

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

/** Per-type consumer wait budget; unknown types fall back to 60s. */
export function commandTimeoutMs(type: string): number {
  if (
    type === 'daemon.ping' ||
    type === 'server.hostname.set' ||
    type === 'server.ntp.set' ||
    type === 'server.reboot' ||
    type === 'server.timezone.set' ||
    type === 'server.fabric.reconcile' ||
    type === 'server.tls.trust.reconcile' ||
    type === 'server.principals.reconcile' ||
    type === 'server.firewall.reconcile' ||
    type === 'server.firewall.confirm' ||
    type === 'server.backups.reconcile' ||
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
    type === 'managed.ha.reconcile' ||
    type === 'managed.ha.failover' ||
    type === 'storage.backup' ||
    type === 'storage.restore' ||
    type === 'system.reconcile'
  ) {
    return COMMAND_TIMEOUT_MS[type]
  }
  return DEFAULT_COMMAND_TIMEOUT_MS
}

function recoveryEngine(engine: unknown): ManagedEngineCode {
  return typeof engine === 'string' && isManagedEngineCode(engine) ? engine : 'postgres'
}

function recoveryActor(record: CommandRecord): {
  actorType: 'user' | 'system'
  actorId: string
} {
  return {
    actorType: record.actorEntityType === 'user' ? 'user' : 'system',
    actorId: record.actorEntityId,
  }
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name.toLowerCase()
    if (name.includes('timeout') || name.includes('network') || name.includes('connection')) {
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
  pending: { sentAt?: string }
): unknown {
  if (type !== 'daemon.ping') return result
  const parsed = parsePingResult(result)
  if (!pending.sentAt) return parsed
  return { ...parsed, cellDispatchedAt: pending.sentAt }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Load the permanent command row plus its one-shot `dispatch` payload.
 * The payload is read exactly once per processing attempt and kept in memory for
 * the side effects that need it — it is never re-read from `command`.
 */
async function loadDispatchableRecord(
  db: Db,
  envelope: CommandEnvelope
): Promise<DispatchableCommandRecord | null> {
  const record = await getCommandRecord(db, envelope.commandId)
  if (!record) {
    return null
  }

  if (TERMINAL_COMMAND_STATUSES.has(record.status)) {
    return null
  }

  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    await transitionCommand(db, record.id, { status: 'timed_out' })
    if (record.type === 'environment.deploy') {
      await failTimedOutDeploy(db, {
        commandId: record.id,
        serverId: record.serverId,
        context: record.context,
        error: 'command expired before the daemon reported an outcome',
      })
    }
    return null
  }

  if (record.serverId !== envelope.serverId) {
    compatLogWarn(
      'command-consumer',
      `envelope mismatch for command ${envelope.commandId}: record server=${record.serverId}, envelope server=${envelope.serverId}`
    )
    return null
  }

  const payload = await getCommandDispatchPayload(db, record.id)
  if (payload === null) {
    compatLogWarn('command-consumer', `missing dispatch payload for command ${envelope.commandId}`)
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command dispatch payload unavailable',
      errorCode: 'dispatch_payload_missing',
    })
    if (record.type === 'environment.deploy') {
      // No payload to read the environment from; the command's context names it.
      await failDeployByContext(db, {
        commandId: record.id,
        serverId: record.serverId,
        context: record.context,
        error: 'Command dispatch payload unavailable',
        outcome: 'failed',
      })
    }
    return null
  }

  return { ...record, payload }
}

async function markDispatching(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope
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

/** `null` when the command can be delivered; otherwise the error it was failed with. */
async function ensureServerAndDaemonOnline(
  db: Db,
  registry: DaemonCellRegistry,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope
): Promise<string | null> {
  const serverBinding = await getServerLicenseBinding(db, envelope.serverId)
  if (!serverBinding) {
    compatLogWarn(
      'command-consumer',
      `server ${envelope.serverId} not found for command ${envelope.commandId}`
    )
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Server not found',
    })
    return 'Server not found'
  }

  const presenceMap = await getResolveFleetPresence()(db, registry, [envelope.serverId])
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
    return 'Daemon not connected'
  }

  // A daemon below the supported floor keeps its connection — that is how it
  // gets updated (the update envelope is not a command) — but gets no
  // commands until it is. Builds that report no version are `unknown` and
  // pass; see lib/version-wire.ts.
  const support = resolveDaemonSupport(presence.daemonBuild?.version)
  if (support.status === 'unsupported') {
    commandConsumerTrace('dispatch-failed', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      reason: 'daemon_unsupported',
    })
    const error = daemonUnsupportedReason(support)
    await transitionCommand(db, record.id, {
      status: 'failed',
      errorCode: 'daemon_unsupported',
      error,
    })
    return error
  }

  return null
}

/**
 * How long a dispatched command may go without the daemon's `command-ack`.
 * The daemon acks the instant it receives the frame, so silence this long
 * means the frame never arrived (a half-open connection), not slow work.
 */
export const COMMAND_ACK_DEADLINE_MS = 45_000

export const COMMAND_UNACKED_ERROR =
  'The server did not acknowledge the command in time; its connection looked dead and was reset. Try again once it reconnects.'

/**
 * Wait for a terminal outcome, but fail fast when the daemon never acks a
 * command that was written to its socket.
 *
 * Only a `sent` request is failed: a `queued` one is still waiting for the
 * outbox to retry, so it keeps its whole budget. Never re-sends. The dead
 * connection is dropped first so a frame still buffered on it cannot run
 * later, and the request is expired in the cell so the outbox cannot deliver
 * it after the caller was told it failed (the daemon also ignores a command id
 * it has already seen). A backend that cannot drop a connection and expire a
 * request (Redis) does a plain wait, so the message never claims a reset that
 * did not happen. The result is a synthetic `failed` record, which flows
 * through the normal failure side effects.
 */
export async function awaitOutcomeWithAckDeadline(
  cell: DaemonCell,
  requestId: string,
  timeoutMs: number,
  ackDeadlineMs = COMMAND_ACK_DEADLINE_MS
): Promise<PendingRequestRecord | null> {
  const { dropDaemonConnection, expireRequest } = cell
  if (ackDeadlineMs >= timeoutMs || !dropDaemonConnection || !expireRequest) {
    return cell.waitForRequest(requestId, timeoutMs)
  }
  const restMs = timeoutMs - ackDeadlineMs
  const first = await cell.waitForRequest(requestId, ackDeadlineMs)
  if (first) return first
  const current = await cell.getRequest(requestId)
  if (current?.status !== 'sent' || current.ackAt) {
    return cell.waitForRequest(requestId, restMs)
  }
  await dropDaemonConnection.call(cell, 'command_unacked').catch(() => undefined)
  // The ack may have landed while the connection was being dropped.
  const settled = await cell.getRequest(requestId)
  if (settled && ['done', 'failed', 'expired'].includes(settled.status)) return settled
  if (settled?.ackAt || (settled && settled.status !== 'sent')) {
    return cell.waitForRequest(requestId, restMs)
  }
  const expired = await expireRequest.call(cell, requestId).catch(() => null)
  if (expired && (expired.status === 'done' || expired.status === 'failed')) return expired
  return { ...(settled ?? current), status: 'failed', error: COMMAND_UNACKED_ERROR }
}

async function enqueueAndAwaitOutcome(
  db: Db,
  registry: DaemonCellRegistry,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  deps?: CommandConsumerDeps
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

  const pending = await awaitOutcomeWithAckDeadline(cell, record.id, timeoutMs)
  if (!pending) {
    await transitionCommand(db, record.id, { status: 'timed_out' })
    commandConsumerTrace('dispatch-result', {
      commandId: record.id,
      commandType: record.type,
      serverId: envelope.serverId,
      resultStatus: 'timed_out',
    })
    await applyManagedFailedSideEffect(db, record, deps, 'Command timed out')
    await applyEnvironmentDeployFailedSideEffect(db, record, envelope, 'timed_out', 'timed_out')
    await applyFabricFailedSideEffect(db, record, envelope)
  }
  return pending
}

/**
 * `outcome` carries the command's real terminal status so deploy history can
 * distinguish a daemon-reported failure from an expired consumer wait; callers
 * pass `'timed_out'` on the timeout paths. `deployment.status` stays `failed`
 * for both.
 */
async function applyEnvironmentDeployFailedSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  error: string,
  outcome: DeploymentOutcome = 'failed'
): Promise<void> {
  if (record.type !== 'environment.deploy') return
  try {
    const payload = parseEnvironmentDeployPayload(record.payload)
    const finishedAt = nowIso()
    const deployFailure = classifyDeployFailure(error)
    const cancelled = isCancelledDeployError(error)
    const marked = await markDeploymentFailed(db, {
      environmentId: payload.environmentId,
      serverId: envelope.serverId,
      error,
      commandId: record.id,
      expectedCommandId: record.id,
      outcome,
      ...(deployFailure === null ? {} : { strategyOutcome: deployFailure.outcome }),
      ...(cancelled ? { cancelled } : {}),
      finishedAt,
      durationMs: deploymentDurationMs({
        startedAt: record.startedAt,
        queuedAt: record.queuedAt ?? record.createdAt,
        finishedAt,
      }),
    })
    if (marked !== null && payload.generation !== undefined) {
      await haltRollout(db, {
        environmentId: payload.environmentId,
        generation: payload.generation,
        reason: cancelled ? 'the deploy was cancelled' : `${envelope.serverId} failed`,
      })
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `deployment failure side effect failed for command ${record.id}: ${message}`
    )
  }
}

async function applyHostnameSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
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
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type === 'server.timezone.set') {
    try {
      const timezoneResult = parseTimezoneSetResult(result)
      await db
        .update(server)
        .set({
          options: sql`COALESCE(${server.options}, '{}'::jsonb) || ${JSON.stringify({
            timezone: timezoneResult.timezone,
          })}::jsonb`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(server.id, envelope.serverId))
      await touchServerMetadata(db, envelope.serverId, {
        timeSync: { timezone: timezoneResult.timezone },
      })
    } catch {
      // Malformed success payload — leave columns for the next heartbeat.
    }
    return
  }
  if (record.type !== 'server.ntp.set') return
  try {
    const ntpResult = parseNtpSetResult(result)
    await touchServerMetadata(db, envelope.serverId, {
      timeSync: {
        ...(ntpResult.ntpEnabled === undefined ? {} : { ntpEnabled: ntpResult.ntpEnabled }),
        ...(ntpResult.ntpSynced === undefined ? {} : { ntpSynced: ntpResult.ntpSynced }),
        ntpServers: ntpResult.ntpServers,
        ...(ntpResult.fallbackNtpServers === undefined
          ? {}
          : { fallbackNtpServers: ntpResult.fallbackNtpServers }),
      },
    })
  } catch {
    // Malformed success payload — leave columns for the next heartbeat.
  }
}

function consumerFabricSecretFields(deps?: CommandConsumerDeps): {
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
} {
  const secretsConfig = deps?.secretsConfig ?? deps?.resealDeps?.secretsConfig
  const dataEncryptionSecrets =
    deps?.dataEncryptionSecrets ?? deps?.resealDeps?.dataEncryptionSecrets
  return {
    ...(secretsConfig ? { secretsConfig } : {}),
    ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
  }
}

async function stampFabricSuccessFromResult(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  fabricId: string,
  fabricResult: ReturnType<typeof parseFabricReconcileResult>
): Promise<void> {
  const metadata = await getCommandMetadata(db, record.id)
  const desiredHash = typeof metadata?.desiredHash === 'string' ? metadata.desiredHash : null
  if (!desiredHash) return
  await stampRelayReconcileSuccess(db, {
    fabricId,
    serverId: envelope.serverId,
    appliedPayloadHash: desiredHash,
    ...(fabricResult.peers ? { observedPeers: fabricResult.peers } : {}),
  })
}

async function reconcileFabricAfterFilledKey(
  db: Db,
  record: DispatchableCommandRecord,
  fabricId: string,
  deps?: CommandConsumerDeps
): Promise<void> {
  const commandQueue = deps?.commandQueue
  if (!commandQueue || isNoopCommandQueue(commandQueue)) return
  const fabric = await getFabricById(db, fabricId)
  if (!fabric) return
  await reconcileFabricMembership({
    db,
    commandQueue,
    actorType: record.actorEntityType,
    actorId: record.actorEntityId,
    organizationId: fabric.organizationId,
    ...consumerFabricSecretFields(deps),
  })
}

async function applyEnabledFabricReconcileSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  const payload = parseFabricReconcilePayload(record.payload)
  if (!payload.enabled) return
  const fabricResult = parseFabricReconcileResult(result)
  // Stamp-match skips (`skipped: true`) still carry a valid publicKey — stamp
  // the desired hash so membership convergence does not re-enqueue forever.
  if (!fabricResult.publicKey) return
  if (!isValidWireguardPublicKey(fabricResult.publicKey)) return
  const fabricId = payload.fabricId
  if (!fabricId) return

  const filledNullKey = await stampRelayPublicKey(db, {
    fabricId,
    serverId: envelope.serverId,
    publicKey: fabricResult.publicKey,
  })
  await stampFabricSuccessFromResult(db, record, envelope, fabricId, fabricResult)
  if (!filledNullKey) return
  await reconcileFabricAfterFilledKey(db, record, fabricId, deps)
}

async function applyFabricSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  if (record.type !== 'server.fabric.reconcile') return
  try {
    await applyEnabledFabricReconcileSideEffect(db, record, envelope, result, deps)
  } catch (err) {
    compatLogWarn(
      'command-consumer',
      `fabric reconcile side effect failed for command ${record.id}: ${errorMessage(err)}`
    )
  }
}

async function applyFabricFailedSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope
): Promise<void> {
  if (record.type !== 'server.fabric.reconcile') return
  try {
    const payload = parseFabricReconcilePayload(record.payload)
    await clearRelayAppliedPayloadHash(db, {
      serverId: envelope.serverId,
      ...(payload.enabled && payload.fabricId ? { fabricId: payload.fabricId } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'command-consumer',
      `fabric reconcile failure side effect failed for command ${record.id}: ${message}`
    )
  }
}

async function reconcileContainersSafely(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  environmentId: string,
  containers: Parameters<typeof reconcileEnvironmentContainers>[1]['containers'],
  expectedAllocations?: Parameters<typeof reconcileEnvironmentContainers>[1]['expectedAllocations']
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

/**
 * Store what the daemon detected in each applied site's document root. Best
 * effort like the container reconcile: a deploy that already succeeded on the
 * host is never recorded as failed over a reporting field.
 */
async function recordSiteAppsSafely(
  db: Db,
  record: DispatchableCommandRecord,
  environmentId: string,
  sites: EnvironmentDeployResultSite[] | undefined
): Promise<void> {
  if (sites === undefined) return
  try {
    await recordDeployedSiteApps(db, { environmentId, sites })
  } catch (err) {
    compatLogWarn(
      'command-consumer',
      `site app facts failed for command ${record.id}: ${errorMessage(err)}`
    )
  }
}

/**
 * Deliver the next rolling-deploy batch once the current one is applied. Best
 * effort like the other deploy side effects: the command already succeeded, so
 * a failure here is logged and the stalled batch is visible as `pending`.
 */
async function advanceRolloutSafely(
  db: Db,
  deps: CommandConsumerDeps | undefined,
  environmentId: string,
  generation: number
): Promise<void> {
  const commandQueue = deps?.commandQueue
  if (commandQueue === undefined || isNoopCommandQueue(commandQueue)) return
  try {
    await advanceRollout(
      db,
      { enqueue: (envelope) => commandQueue.enqueue(envelope) },
      { environmentId, generation }
    )
  } catch (err) {
    compatLogWarn(
      'command-consumer',
      `rollout advance failed for environment ${environmentId}: ${errorMessage(err)}`
    )
  }
}

/**
 * A successful deploy created the environment's docker volumes on this server: their `pending`
 * primary copies are ready. Scratch, non-docker and other-server copies are left alone.
 */
async function markEnvironmentCopiesReady(
  db: Db,
  environmentId: string,
  serverId: string
): Promise<void> {
  await db
    .update(storageCopy)
    .set({ state: 'ready' })
    .where(
      and(
        eq(storageCopy.serverId, serverId),
        eq(storageCopy.state, 'pending'),
        eq(storageCopy.provider, 'docker'),
        eq(storageCopy.role, 'primary'),
        inArray(
          storageCopy.storageId,
          db
            .select({ id: storage.id })
            .from(storage)
            .where(
              or(
                eq(storage.environmentId, environmentId),
                // Storage owned by a service of this environment that runs on this server.
                inArray(
                  storage.serviceId,
                  db
                    .select({ id: service.id })
                    .from(service)
                    .innerJoin(container, eq(container.serviceId, service.id))
                    .where(
                      and(
                        eq(service.environmentId, environmentId),
                        eq(container.serverId, serverId)
                      )
                    )
                )
              )
            )
        )
      )
    )
}

async function applyEnvironmentDeploySideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  if (record.type !== 'environment.deploy') return
  try {
    const payload = parseEnvironmentDeployPayload(record.payload)
    if (payload.generation !== undefined) {
      const finishedAt = nowIso()
      const marked = await markDeploymentApplied(db, {
        environmentId: payload.environmentId,
        serverId: envelope.serverId,
        generation: payload.generation,
        commandId: record.id,
        expectedCommandId: record.id,
        finishedAt,
        durationMs: deploymentDurationMs({
          startedAt: record.startedAt,
          queuedAt: record.queuedAt ?? record.createdAt,
          finishedAt,
        }),
      })
      // A result from a deploy a newer one replaced changes nothing and advances nothing.
      if (marked !== null) {
        await advanceRolloutSafely(db, deps, payload.environmentId, payload.generation)
      }
    }
    await markEnvironmentCopiesReady(db, payload.environmentId, envelope.serverId)
    const deployResult = parseEnvironmentDeployResult(result)
    await recordSiteAppsSafely(db, record, payload.environmentId, deployResult.sites)
    // Only reconcile when the daemon included an authoritative containers
    // report (including `[]`). Omitting the field means collection failed.
    if (deployResult.containers === undefined) return
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      payload.environmentId,
      deployResult.containers
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

async function applyEnvironmentStopSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type !== 'environment.stop') return
  try {
    const { environmentId } = parseEnvironmentStopPayload(record.payload)
    const stopResult = parseEnvironmentStopResult(result)
    if (stopResult.containers === undefined) return
    await reconcileContainersSafely(db, record, envelope, environmentId, stopResult.containers)
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

async function applyEnvironmentLifecycleSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type !== 'environment.lifecycle') return
  try {
    const { environmentId } = parseEnvironmentLifecyclePayload(record.payload)
    const lifecycleResult = parseEnvironmentLifecycleResult(result)
    // Live `compose ps` rows update pins; omitted field means collection failed.
    if (lifecycleResult.containers === undefined) return
    await reconcileContainersSafely(db, record, envelope, environmentId, lifecycleResult.containers)
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

async function applySystemReconcileSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
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
      expectedAllocations
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

async function applyManagedIngressReconcileSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type !== 'managed.ingress.reconcile') return
  try {
    const payload = parseManagedIngressReconcilePayload(record.payload)
    const reconcileResult = parseManagedIngressReconcileResult(result)
    // Omitted containers = collection failed — skip reconcile. An explicit
    // empty array is authoritative teardown (empty-cluster ProxySQL removal).
    if (reconcileResult.containers === undefined) return
    const hierarchy = await findManagedIngressHierarchy(db, {
      serverId: payload.serverId,
    })
    if (!hierarchy) return
    const expectedAllocations = [
      {
        serviceId: hierarchy.serviceId,
        role: 'ingress' as const,
        ordinal: 1,
      },
    ]
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      hierarchy.environmentId,
      reconcileResult.containers,
      expectedAllocations
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

async function applyManagedHaReconcileSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type !== 'managed.ha.reconcile') return
  try {
    const payload = parseManagedHaReconcilePayload(record.payload)
    const reconcileResult = parseManagedHaReconcileResult(result)
    if (reconcileResult.containers === undefined) return
    const hierarchy = await findManagedHaHierarchy(db, {
      serverId: payload.serverId,
    })
    if (!hierarchy) return
    const expectedAllocations = [
      {
        serviceId: hierarchy.serviceId,
        role: 'turbopanel' as const,
        ordinal: 1,
      },
    ]
    await reconcileContainersSafely(
      db,
      record,
      envelope,
      hierarchy.environmentId,
      reconcileResult.containers,
      expectedAllocations
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
      `container reconcile failed for command ${record.id}: ${message}`
    )
  }
}

async function applyManagedApplySideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  if (record.type !== 'managed.apply') return
  try {
    const payload = parseManagedApplyPayload(record.payload)
    const applyResult = parseManagedApplyResult(result)
    const updatedAt = nowIso()
    const isPrimary = payload.memberRole === 'primary'
    // Captured before a primary apply can re-pin the engine, so its backup
    // policies can follow it to the new host.
    const backupHost = isPrimary
      ? await captureManagedBackupHost(db, deps?.commandQueue, payload.managedId)
      : null
    // `managed.server_id` is the primary placement pin. Fan-out apply sends one
    // command per member — only the primary member may update the pin / host /
    // port so a late replica success cannot re-home the cluster.
    if (isPrimary) {
      await db
        .update(managed)
        .set({
          status: 'ready',
          serverId: envelope.serverId,
          metadata: sql`COALESCE(${managed.metadata}, '{}'::jsonb) || ${JSON.stringify({
            host: applyResult.host,
            port: applyResult.port,
            error: null,
          })}::jsonb`,
          updatedAt,
        })
        .where(eq(managed.id, payload.managedId))
    } else {
      await db
        .update(managed)
        .set({
          status: 'ready',
          metadata: sql`COALESCE(${managed.metadata}, '{}'::jsonb) || ${JSON.stringify({
            error: null,
          })}::jsonb`,
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
        applyResult.containers
      )
    }
    await projectManagedMemberObservedStatus(db, applyResult.member, record.id, record.type)
    await reconcileBackupsAfterManagedMove(db, deps?.commandQueue, {
      managedId: payload.managedId,
      previousServerId: backupHost,
      actorId: envelope.serverId,
    })

    // Primary success → enqueue deferred standby applies (if any).
    if (isPrimary && deps?.commandQueue && !isNoopCommandQueue(deps.commandQueue)) {
      await enqueuePendingStandbyApplies(db, record, deps)
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.apply side effect failed for command ${record.id}: ${message}`
    )
  }
}

type PendingStandbyApply = {
  serverId: string
  memberId: string
  payload: unknown
  pendingTlsLeaf?: unknown
}

async function enqueuePendingStandbyApplies(
  db: Db,
  record: DispatchableCommandRecord,
  deps: CommandConsumerDeps
): Promise<void> {
  const meta = await getCommandMetadata(db, record.id)
  const raw = meta?.pendingStandbyApplies
  if (!Array.isArray(raw) || raw.length === 0) return

  const commandQueue = deps.commandQueue!
  await forEachSequential(raw, async (entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as PendingStandbyApply).serverId !== 'string' ||
      typeof (entry as PendingStandbyApply).memberId !== 'string'
    ) {
      return
    }
    const standby = entry as PendingStandbyApply
    let payload: unknown
    try {
      payload = parseManagedApplyPayload(standby.payload)
    } catch {
      return
    }
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    const pendingTlsLeaf = parsePendingTlsLeafValue(standby.pendingTlsLeaf)
    const metadata = pendingTlsLeaf ? pendingTlsLeafMetadata(pendingTlsLeaf) : undefined
    try {
      const next = await createCommandRecord(db, {
        serverId: standby.serverId,
        actorType: record.actorEntityType,
        actorId: record.actorEntityId,
        type: 'managed.apply',
        payload,
        expiresAt,
        ...(metadata ? { metadata } : {}),
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
        `standby apply follow-up failed for command ${record.id}: ${message}`
      )
    }
  })
}

/**
 * Release the deferred primary `managed.destroy` once every replica of the
 * fan-out has succeeded.
 *
 * Same shape as {@link enqueuePendingStandbyApplies}: the route enqueues the
 * replicas, records what must happen afterwards on their command metadata, and
 * returns. Here the gate is an **AND across siblings** rather than a single
 * predecessor — the primary's `deleteAfterDestroy` removes the `managed` row,
 * so it must not run while another host is still tearing its replica down.
 *
 * Every replica command carries the same gate and reaches this function, so the
 * work is: is every sibling `succeeded` yet, and am I the one that enqueues?
 * The second question is settled by a conditional UPDATE on a deterministic
 * anchor row, not by "am I last" — two replicas can finish in the same instant
 * and both see a satisfied gate.
 *
 * A replica that fails, expires, or never enqueues simply never opens the gate.
 * The primary keeps no command row, the `managed` row survives, and the
 * operator can retry or force-delete (which skips the gate).
 */
async function enqueuePendingManagedDestroys(
  db: Db,
  record: DispatchableCommandRecord,
  deps: CommandConsumerDeps | undefined
): Promise<void> {
  if (!deps?.commandQueue || isNoopCommandQueue(deps.commandQueue)) return

  const meta = await getCommandMetadata(db, record.id)
  const gate = parseManagedDestroyGate(meta?.[MANAGED_DESTROY_GATE_METADATA_KEY])
  if (!gate || gate.followups.length === 0) return

  const siblings = await loadManagedDestroyGateCommands(db, gate.gateId)
  // One command row per gated replica, all succeeded — anything less means a
  // sibling is still running, failed, or was never created.
  if (siblings.length !== gate.memberIds.length) return
  if (!siblings.every((sibling) => sibling.status === 'succeeded')) return

  // Deterministic anchor so simultaneous completions contend for one row.
  const anchorCommandId = siblings
    .map((sibling) => sibling.id)
    .toSorted((a, b) => a.localeCompare(b))[0]
  if (!anchorCommandId) return
  const claimed = await claimCommandMetadataFlag(
    db,
    anchorCommandId,
    MANAGED_DESTROY_GATE_CLAIM_KEY
  )
  if (!claimed) return

  const commandQueue = deps.commandQueue
  await forEachSequential(gate.followups, async (followup) => {
    let payload: unknown
    try {
      payload = parseManagedDestroyPayload(followup.payload)
    } catch {
      return
    }
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    try {
      const next = await createCommandRecord(db, {
        serverId: followup.serverId,
        actorType: record.actorEntityType,
        actorId: record.actorEntityId,
        type: 'managed.destroy',
        payload,
        expiresAt,
      })
      const envelope: CommandEnvelope = {
        commandId: next.id,
        serverId: followup.serverId,
        type: 'managed.destroy',
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
        `primary destroy follow-up failed for command ${record.id}: ${message}`
      )
    }
  })
}

/**
 * Every command stamped with this gate, with its status.
 *
 * Keyed on the gate id in jsonb rather than a stored command-id list, because
 * the gate is written at insert time — before any sibling's id exists. Reads
 * `command` only: the `dispatch` payload is deleted once a command succeeds,
 * which is precisely the state this query has to see.
 */
async function loadManagedDestroyGateCommands(
  db: Db,
  gateId: string
): Promise<Array<{ id: string; status: string }>> {
  return await db
    .select({ id: command.id, status: command.status })
    .from(command)
    .where(eq(command.managedDestroyGateId, gateId))
}

/** Observed statuses the consumer may project onto `managed.status`. */
const MANAGED_OBSERVED_STATUSES = new Set(['ready', 'stopped', 'failed'])

/**
 * Project daemon-observed per-member status + replication health onto
 * `replica`. Only what the daemon reported — never reverse-inferred.
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
  commandType: string
): Promise<void> {
  if (member === undefined) return
  try {
    await updateManagedMemberObservedReplication(db, member.memberId, {
      status: member.status,
      ...(member.replication !== undefined ? { replication: member.replication } : {}),
    })
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed member projection failed for ${commandType} command ${commandId}: ${message}`
    )
  }
}

export function isManagedObservedStatus(value: string): value is 'ready' | 'stopped' | 'failed' {
  return MANAGED_OBSERVED_STATUSES.has(value)
}

async function projectManagedObservedStatus(
  db: Db,
  managedId: string,
  status: string,
  commandId: string,
  commandType: string
): Promise<void> {
  if (!isManagedObservedStatus(status)) {
    compatLogWarn(
      'command-consumer',
      `ignored non-projectable managed status ${JSON.stringify(
        status
      )} for ${commandType} command ${commandId}`
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
  record: DispatchableCommandRecord,
  _envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
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
      record.type
    )
    await projectManagedMemberObservedStatus(db, lifecycleResult.member, record.id, record.type)

    const meta = await getCommandMetadata(db, record.id)
    const recoveryId = recoveryIdFromCommandMetadata(meta)
    if (recoveryId && payload.action === 'stop') {
      await onFenceCommandSucceeded(db, deps?.commandQueue, {
        recoveryId,
        commandId: record.id,
        fencePhase: 'stop',
        engine: recoveryEngine(payload.engine),
        actor: recoveryActor(record),
      })
      return
    }

    // Legacy fence-then-promote: only enqueue promote after a successful fence stop.
    if (payload.action === 'stop' && deps?.commandQueue && !isNoopCommandQueue(deps.commandQueue)) {
      const followUp = meta?.followUpPromote as
        | {
            serverId: string
            payload: unknown
          }
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
            `promote follow-up after fence failed for ${record.id}: ${message}`
          )
        }
      }
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.lifecycle side effect failed for command ${record.id}: ${message}`
    )
  }
}

async function applyManagedBackupSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  _envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type !== 'managed.backup') return
  try {
    const payload = parseManagedBackupPayload(record.payload)
    const backupResult = parseManagedBackupResult(result)

    await forEachSequential(backupResult.pruned ?? [], (prunedId) =>
      deleteManagedBackup(db, payload.managedId, prunedId)
    )

    if (payload.action === 'delete') {
      await deleteManagedBackup(db, payload.managedId, payload.backupId)
    } else if (
      backupResult.path !== undefined &&
      backupResult.sizeBytes !== undefined &&
      backupResult.checksum !== undefined
    ) {
      await insertManagedBackup(db, {
        id: backupResult.backupId,
        managedId: payload.managedId,
        sizeBytes: backupResult.sizeBytes,
        checksum: backupResult.checksum,
        ...(backupResult.database !== undefined ? { database: backupResult.database } : {}),
        path: backupResult.path,
        ...(backupResult.completedAt !== undefined ? { createdAt: backupResult.completedAt } : {}),
      })
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.backup side effect failed for command ${record.id}: ${message}`
    )
  }
}

async function applyManagedRestoreSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  _envelope: CommandEnvelope,
  result: unknown
): Promise<void> {
  if (record.type !== 'managed.restore') return
  try {
    const payload = parseManagedRestorePayload(record.payload)
    // Result parser is lenient; a successful restore always projects `ready`
    // regardless of whether the daemon included an optional `status` field.
    parseManagedRestoreResult(result)
    await projectManagedObservedStatus(db, payload.managedId, 'ready', record.id, record.type)
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.restore side effect failed for command ${record.id}: ${message}`
    )
  }
}

/**
 * Narrows `deps` to the shape required to enqueue managed follow-up commands
 * (primary re-apply after member destroy, ProxySQL ingress reconcile) — a
 * live, non-noop queue plus the secrets needed to reseal credentials.
 */
export function hasManagedFollowUpDeps(
  deps: CommandConsumerDeps | undefined
): deps is CommandConsumerDeps & {
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
} {
  return Boolean(
    deps?.commandQueue &&
    deps.secretsConfig &&
    deps.dataEncryptionSecrets &&
    !isNoopCommandQueue(deps.commandQueue)
  )
}

/** Primary re-apply for slot cleanup is stamped on metadata as `pendingPrimaryReapply`. */
async function reapplyPrimaryAfterMemberDestroy(
  db: Db,
  record: DispatchableCommandRecord,
  deps: CommandConsumerDeps & { commandQueue: CommandQueue }
): Promise<void> {
  const meta = await getCommandMetadata(db, record.id)
  const reapply = meta?.pendingPrimaryReapply as
    | {
        serverId: string
        payload: unknown
      }
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
      `primary re-apply after member destroy failed for ${record.id}: ${message}`
    )
  }
}

/**
 * Member-delete path: remove the member only after destroy confirms success,
 * then re-apply the primary so slots shrink (orphaned slot cleanup).
 */
async function cleanupDestroyedMember(
  db: Db,
  record: DispatchableCommandRecord,
  payload: ManagedDestroyCommandPayload,
  deps: CommandConsumerDeps | undefined
): Promise<void> {
  if (!payload.deleteMemberAfterDestroy || !payload.memberId) return
  const [member] = await db
    .select({ serverId: replica.serverId, ordinal: replica.ordinal })
    .from(replica)
    .where(eq(replica.id, payload.memberId))
    .limit(1)
  await db.delete(replica).where(eq(replica.id, payload.memberId))
  // The destroy already tore down the runtime — drop the member's container
  // allocation row too, or the status panel keeps a phantom EXITED entry
  // (`reconcileEnvironmentContainers` only resets rows on an empty report,
  // which is stop semantics, not removal).
  if (member) {
    const [managedRow] = await db
      .select({ environmentId: managed.environmentId })
      .from(managed)
      .where(eq(managed.id, payload.managedId))
      .limit(1)
    if (managedRow) {
      const serviceRows = await db
        .select({ id: service.id })
        .from(service)
        .where(eq(service.environmentId, managedRow.environmentId))
      if (serviceRows.length > 0) {
        await db.delete(container).where(
          and(
            eq(container.serverId, member.serverId),
            inArray(
              container.serviceId,
              serviceRows.map((row) => row.id)
            ),
            eq(container.ordinal, member.ordinal),
            eq(container.role, 'service')
          )
        )
      }
    }
  }
  if (hasManagedFollowUpDeps(deps)) {
    await reapplyPrimaryAfterMemberDestroy(db, record, deps)
  }
}

/** Reconcile ProxySQL so destroyed members leave the frontend backends. */
async function reconcileManagedIngressAfterDestroy(
  db: Db,
  envelope: CommandEnvelope,
  deps: CommandConsumerDeps | undefined
): Promise<void> {
  if (!hasManagedFollowUpDeps(deps)) return
  const { enqueueManagedIngressReconcile } = await import('../managed/ingress-desired.ts')
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
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
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
      record.type
    )
    // Payload-first environmentId: concurrent member destroys must not lose
    // their side effects when the primary's outcome (deleteAfterDestroy)
    // already deleted the managed row — an early `if (!row) return` here left
    // the other servers' container rows 'running' (blocking project delete)
    // and skipped their ProxySQL ingress teardown entirely.
    let environmentId = payload.environmentId
    if (!environmentId) {
      const [row] = await db
        .select({ environmentId: managed.environmentId })
        .from(managed)
        .where(eq(managed.id, payload.managedId))
        .limit(1)
      environmentId = row?.environmentId
    }
    if (environmentId) {
      await reconcileContainersSafely(db, record, envelope, environmentId, destroyResult.containers)
    }

    // `applyManagedDestroySideEffect` only runs from `applySucceededSideEffects`
    // (the command already reported `succeeded`), so a `deleteAfterDestroy`
    // marker here always means the daemon actually tore down the runtime.
    // Delete the `managed` row so `principal.managed_id` cascades — this is
    // the API-delete completion, distinct from any future "destroy runtime
    // only" action that would omit the marker and leave the row in place.
    if (payload.deleteAfterDestroy) {
      // The engine's backup policies cascade with the row; its host gets the
      // smaller set so no timer outlives the engine.
      const backupHost = await captureManagedBackupHost(db, deps?.commandQueue, payload.managedId)
      await db.delete(managed).where(eq(managed.id, payload.managedId))
      await enqueueBackupsReconcile(
        db,
        deps?.commandQueue,
        { actorType: 'system', actorId: envelope.serverId },
        [backupHost]
      )
    }

    await cleanupDestroyedMember(db, record, payload, deps)
    await reconcileManagedIngressAfterDestroy(db, envelope, deps)
    // Replica teardown is done and its side effects above have committed —
    // release the primary destroy if this was the last replica of the fan-out.
    await enqueuePendingManagedDestroys(db, record, deps)
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.destroy side effect failed for command ${record.id}: ${message}`
    )
  }
}

export function resolveManagedIdFromPayload(type: string, payload: unknown): string | null {
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
    if (type === 'managed.ha.failover') {
      return parseManagedHaFailoverPayload(payload).managedId
    }
  } catch {
    return null
  }
  return null
}

/**
 * Member id on a failed managed command payload (apply always has one;
 * lifecycle/destroy/promote when fan-out targets a single replica).
 * Does not invent ids — only what the typed payload already carried.
 */
export function resolveManagedMemberIdFromFailedPayload(
  type: string,
  payload: unknown
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
    if (type === 'managed.ha.failover') {
      return parseManagedHaFailoverPayload(payload).targetMemberId
    }
  } catch {
    return null
  }
  return null
}

function payloadEngine(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as { engine?: unknown }).engine
}

/**
 * Advance / fail the HA recovery journal when a fenced or promote/failover
 * command fails. Returns true when the fence path already handled the failure
 * (caller must not also flip `managed.status`).
 */
async function applyManagedRecoveryFailedSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  meta: Record<string, unknown> | null | undefined,
  deps?: CommandConsumerDeps
): Promise<boolean> {
  const recoveryId = recoveryIdFromCommandMetadata(meta)
  if (!recoveryId) return false

  const fencePhase =
    fencePhaseFromCommandMetadata(meta) ?? (record.type === 'managed.lifecycle' ? 'stop' : null)
  if (fencePhase) {
    await onFenceCommandFailed(db, deps?.commandQueue, {
      recoveryId,
      commandId: record.id,
      engine: recoveryEngine(payloadEngine(record.payload)),
      actor: recoveryActor(record),
    })
    return true
  }

  if (record.type === 'managed.promote' || record.type === 'managed.ha.failover') {
    await onRecoveryCommandFailed(db, recoveryId)
  }
  return false
}

function shouldMarkManagedFailedOnCommandType(type: string): boolean {
  return (
    type === 'managed.apply' ||
    type === 'managed.lifecycle' ||
    type === 'managed.destroy' ||
    type === 'managed.restore' ||
    type === 'managed.promote' ||
    type === 'managed.ha.failover'
  )
}

async function markManagedRowsFailedFromCommand(
  db: Db,
  record: DispatchableCommandRecord,
  error?: string
): Promise<void> {
  try {
    const managedId = resolveManagedIdFromPayload(record.type, record.payload)
    if (!managedId) return
    const updatedAt = nowIso()
    const trimmed = error?.trim()
    await db
      .update(managed)
      .set({
        status: 'failed',
        updatedAt,
        ...(trimmed
          ? {
              metadata: sql`COALESCE(${managed.metadata}, '{}'::jsonb) || ${JSON.stringify({
                error: trimmed,
              })}::jsonb`,
            }
          : {}),
      })
      .where(eq(managed.id, managedId))

    const memberId = resolveManagedMemberIdFromFailedPayload(record.type, record.payload)
    if (memberId) {
      await db
        .update(replica)
        .set({
          status: 'failed',
          updatedAt,
        })
        .where(eq(replica.id, memberId))
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed failure side effect failed for command ${record.id}: ${message}`
    )
  }
}

/**
 * Mark the managed row failed when apply/lifecycle/destroy/restore/promote fail
 * or time out. `managed.backup` is deliberately excluded — a read-only backup
 * failure must never mark an otherwise-healthy engine `failed`.
 *
 * Also marks the targeted `replica` failed when the payload names a member —
 * otherwise UI cluster rows stay stuck on `provisioning` after a failed apply
 * while only `managed.status` flipped to `failed`.
 *
 * Does not alter terminal command-row semantics.
 */
async function applyManagedFailedSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  deps?: CommandConsumerDeps,
  error?: string
): Promise<void> {
  const meta = await getCommandMetadata(db, record.id)
  if (await applyManagedRecoveryFailedSideEffect(db, record, meta, deps)) {
    return
  }
  if (!shouldMarkManagedFailedOnCommandType(record.type)) return
  const fromMeta = typeof meta?.error === 'string' ? meta.error : undefined
  await markManagedRowsFailedFromCommand(
    db,
    record,
    error ?? fromMeta ?? record.errorMessage ?? undefined
  )
}

async function applyPendingTlsLeafSideEffect(
  db: Db,
  record: DispatchableCommandRecord
): Promise<void> {
  if (record.type !== 'managed.apply' && record.type !== 'managed.ingress.reconcile') {
    return
  }
  try {
    const meta = await getCommandMetadata(db, record.id)
    await commitPendingTlsLeafTracking(db, meta)
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `pending leaf commit failed for command ${record.id}: ${message}`
    )
  }
}

async function applySucceededSideEffects(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  await applyHostnameSideEffect(db, record, envelope, result)
  await applyTimeSyncSideEffect(db, record, envelope, result)
  await applyFabricSideEffect(db, record, envelope, result, deps)
  await applyEnvironmentDeploySideEffect(db, record, envelope, result, deps)
  await applyEnvironmentStopSideEffect(db, record, envelope, result)
  await applyEnvironmentLifecycleSideEffect(db, record, envelope, result)
  await applySystemReconcileSideEffect(db, record, envelope, result)
  await applyManagedIngressReconcileSideEffect(db, record, envelope, result)
  await applyManagedHaReconcileSideEffect(db, record, envelope, result)
  await applyManagedApplySideEffect(db, record, envelope, result, deps)
  await applyPendingTlsLeafSideEffect(db, record)
  await applyManagedLifecycleSideEffect(db, record, envelope, result, deps)
  await applyManagedDestroySideEffect(db, record, envelope, result, deps)
  await applyManagedPromoteSideEffect(db, record, envelope, result, deps)
  await applyManagedHaFailoverSideEffect(db, record, envelope, result, deps)
  await applyBackupsReconcileSideEffect(db, record, result)
  await applyManagedBackupSideEffect(db, record, envelope, result)
  await applyManagedRestoreSideEffect(db, record, envelope, result)
  await applyStorageBackupSideEffect(db, record, result)
  await applyFirewallPreviewSideEffect(db, record, envelope, result, deps)
}

/**
 * Firewall preview upkeep: keep what a host answered to a preview, and, after
 * a command that can change what the host publishes, send a fresh preview if
 * (and only if) the derived set changed. Sends an apply only for a server both
 * keys of `../firewall/enforcement.ts` allow.
 */
async function applyFirewallPreviewSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  try {
    if (record.type === FIREWALL_RECONCILE_COMMAND) {
      await recordFirewallPreviewResult(db, envelope.serverId, record.payload, result)
    } else if (commandMayChangeFirewallPreview(record.type)) {
      await enqueueFirewallPreview(
        db,
        deps?.commandQueue,
        { actorType: 'system', actorId: envelope.serverId },
        [envelope.serverId],
        { onlyIfPreviewed: true, applyGate: deps?.firewallApplyGate }
      )
    }
  } catch (err) {
    compatLogWarn(
      'command-consumer',
      `firewall preview side effect failed for command ${record.id}: ${errorMessage(err)}`
    )
  }
}

/** A failed or timed-out reconcile is kept on the firewall record so it does not read as queued. */
async function applyFirewallFailedSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  error: string
): Promise<void> {
  if (record.type !== FIREWALL_RECONCILE_COMMAND) return
  try {
    await recordFirewallPreviewFailure(db, envelope.serverId, record.payload, error)
  } catch (err) {
    compatLogWarn(
      'command-consumer',
      `firewall failure record failed for command ${record.id}: ${errorMessage(err)}`
    )
  }
}

/**
 * The side effect of a successful promote threw after the role change. Nothing
 * else advances the recovery row, so end it terminal for the operator instead
 * of leaving it holding the cluster's slot (`managed_busy` for ever).
 */
async function failRecoveryOfSideEffectError(
  db: Db,
  record: DispatchableCommandRecord
): Promise<void> {
  try {
    const recoveryId = recoveryIdFromCommandMetadata(await getCommandMetadata(db, record.id))
    if (recoveryId) await onRecoveryStepFailed(db, recoveryId)
  } catch (err) {
    // The recovery sweep expires the row if even this write fails.
    logRecoveryAdvanceFailure(record.id, errorMessage(err))
  }
}

/**
 * After a successful promote: demote the old primary **before** promoting so
 * `uniq_node_primary` is never violated mid-flip, then re-point
 * `managed.server_id`, project health, and hand off to
 * `fanOutManagedIngressReconcile` so member and consuming servers both
 * re-reconcile ProxySQL against the new primary.
 */
async function applyManagedPromoteSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  if (record.type !== 'managed.promote') return
  try {
    const promoteResult = parseManagedPromoteResult(result)
    const payload = parseManagedPromotePayload(record.payload)
    const managedId = payload.managedId
    const promotedMemberId = promoteResult.promotedMemberId || payload.memberId
    const demotedMemberId = promoteResult.demotedMemberId ?? payload.demoteMemberId
    const updatedAt = nowIso()
    const backupHost = await captureManagedBackupHost(db, deps?.commandQueue, managedId)

    await db.transaction(async (tx) => {
      // Demote first so the partial unique primary index stays satisfied.
      if (demotedMemberId) {
        await tx
          .update(replica)
          .set({
            role: 'replica',
            status: 'needs_resync',
            updatedAt,
          })
          .where(and(eq(replica.id, demotedMemberId), eq(replica.managedId, managedId)))
      }

      if (!promotedMemberId) return

      await tx
        .update(replica)
        .set({
          role: 'primary',
          status: promoteResult.status || 'ready',
          updatedAt,
        })
        .where(and(eq(replica.id, promotedMemberId), eq(replica.managedId, managedId)))

      const [promoted] = await tx
        .select({ serverId: replica.serverId })
        .from(replica)
        .where(eq(replica.id, promotedMemberId))
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
    await reconcileBackupsAfterManagedMove(db, deps?.commandQueue, {
      managedId,
      previousServerId: backupHost,
      actorId: envelope.serverId,
    })

    if (!hasManagedFollowUpDeps(deps)) {
      const meta = await getCommandMetadata(db, record.id)
      const recoveryId = recoveryIdFromCommandMetadata(meta)
      if (recoveryId) {
        await onPromoteSucceeded(db, deps?.commandQueue, {}, recoveryId, envelope.serverId)
      }
      return
    }

    // Consumer-aware tail: recompute member replication transports relative to
    // the new primary, re-materialize binding-owned HOST/PORT/URL variables,
    // then reconcile ProxySQL on member **and** consuming servers. A
    // member-only fan-out left every bound consumer host routing writes at the
    // demoted primary. The fence-then-promote path enqueues a real
    // `managed.promote` command (see `applyManagedLifecycleSideEffect`), so it
    // lands here too once that promote succeeds.
    const meta = await getCommandMetadata(db, record.id)
    const recoveryId = recoveryIdFromCommandMetadata(meta)
    if (recoveryId) {
      await onPromoteSucceeded(
        db,
        deps.commandQueue,
        {
          secretsConfig: deps.secretsConfig,
          dataEncryptionSecrets: deps.dataEncryptionSecrets,
        },
        recoveryId,
        envelope.serverId
      )
      return
    }

    const { fanOutManagedIngressReconcile } = await import('../managed/ingress-desired.ts')
    await fanOutManagedIngressReconcile(db, deps.commandQueue, {
      managedId,
      actorType: 'system',
      actorId: envelope.serverId,
      secretsConfig: deps.secretsConfig,
      dataEncryptionSecrets: deps.dataEncryptionSecrets,
      extraServerIds: [envelope.serverId],
    })
    const { fanOutManagedHaReconcile } = await import('../managed/ha-desired.ts')
    await fanOutManagedHaReconcile(db, deps.commandQueue, {
      managedId,
      actorType: 'system',
      actorId: envelope.serverId,
      secretsConfig: deps.secretsConfig,
      dataEncryptionSecrets: deps.dataEncryptionSecrets,
      extraServerIds: [envelope.serverId],
    })
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.promote side effect failed for command ${record.id}: ${message}`
    )
    await failRecoveryOfSideEffectError(db, record)
  }
}

async function applyManagedRoleFlip(
  db: Db,
  params: {
    managedId: string
    promotedMemberId: string
    demotedMemberId?: string
    status: string
    updatedAt: string
  }
): Promise<void> {
  await db.transaction(async (tx) => {
    if (params.demotedMemberId) {
      await tx
        .update(replica)
        .set({
          role: 'replica',
          status: 'needs_resync',
          updatedAt: params.updatedAt,
        })
        .where(and(eq(replica.id, params.demotedMemberId), eq(replica.managedId, params.managedId)))
    }

    await tx
      .update(replica)
      .set({
        role: 'primary',
        status: params.status,
        updatedAt: params.updatedAt,
      })
      .where(and(eq(replica.id, params.promotedMemberId), eq(replica.managedId, params.managedId)))

    const [promoted] = await tx
      .select({ serverId: replica.serverId })
      .from(replica)
      .where(eq(replica.id, params.promotedMemberId))
      .limit(1)

    if (promoted) {
      await tx
        .update(managed)
        .set({
          status: 'ready',
          serverId: promoted.serverId,
          updatedAt: params.updatedAt,
        })
        .where(eq(managed.id, params.managedId))
    } else {
      await tx
        .update(managed)
        .set({ status: 'ready', updatedAt: params.updatedAt })
        .where(eq(managed.id, params.managedId))
    }
  })
}

async function applyManagedHaFailoverSideEffect(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  result: unknown,
  deps?: CommandConsumerDeps
): Promise<void> {
  if (record.type !== 'managed.ha.failover') return
  try {
    const payload = parseManagedHaFailoverPayload(record.payload)
    parseManagedHaFailoverResult(result)
    const meta = await getCommandMetadata(db, record.id)
    const recoveryId = recoveryIdFromCommandMetadata(meta)
    if (payload.phase === 'drain') {
      if (!recoveryId) return
      await onFenceCommandSucceeded(db, deps?.commandQueue, {
        recoveryId,
        commandId: record.id,
        fencePhase: 'drain',
        engine: recoveryEngine(payload.engine),
        actor: recoveryActor(record),
      })
      return
    }

    const backupHost = await captureManagedBackupHost(db, deps?.commandQueue, payload.managedId)
    await applyManagedRoleFlip(db, {
      managedId: payload.managedId,
      promotedMemberId: payload.targetMemberId,
      demotedMemberId: payload.sourceMemberId,
      status: 'ready',
      updatedAt: nowIso(),
    })
    await reconcileBackupsAfterManagedMove(db, deps?.commandQueue, {
      managedId: payload.managedId,
      previousServerId: backupHost,
      actorId: envelope.serverId,
    })

    if (recoveryId) {
      await onPromoteSucceeded(
        db,
        deps?.commandQueue,
        {
          secretsConfig: deps?.secretsConfig,
          dataEncryptionSecrets: deps?.dataEncryptionSecrets,
        },
        recoveryId,
        envelope.serverId
      )
    }
  } catch (err) {
    const message = errorMessage(err)
    compatLogWarn(
      'command-consumer',
      `managed.ha.failover side effect failed for command ${record.id}: ${message}`
    )
    await failRecoveryOfSideEffectError(db, record)
  }
}

async function handlePendingDone(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
  deps?: CommandConsumerDeps
): Promise<void> {
  await transitionCommand(db, record.id, {
    status: 'succeeded',
    result: resultSummaryForPersist(
      record.type,
      enrichPingResult(record.type, pending.result, pending)
    ),
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

/** Host text for a restore whose archive is gone (deleted or pruned). */
const BACKUP_NOT_ON_HOST_RE = /backup \S+ is not on this host/

/** Machine-readable `errorCode` for a failed command, when its error text names one. */
export function failureErrorCodeField(
  type: string,
  deployFailure: ReturnType<typeof classifyDeployFailure>,
  error: string
): { errorCode?: string } {
  if (deployFailure !== null) return { errorCode: deployOutcomeErrorCode(deployFailure.outcome) }
  if (type === 'environment.deploy' && isCancelledDeployError(error)) {
    return { errorCode: DEPLOY_CANCELLED_ERROR_CODE }
  }
  if (type === 'storage.restore' && BACKUP_NOT_ON_HOST_RE.test(error)) {
    return { errorCode: 'backup_not_found' }
  }
  return {}
}

async function handlePendingFailed(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
  deps?: CommandConsumerDeps
): Promise<void> {
  const error = pending.error ?? 'Command failed'
  // A sequential deploy that rolled back or needs attention says so in its error
  // text; keep that machine-readable on the row.
  const deployFailure = record.type === 'environment.deploy' ? classifyDeployFailure(error) : null
  // A deploy the daemon stopped on request is `cancelled`, not `failed`.
  const cancelled = record.type === 'environment.deploy' && isCancelledDeployError(error)
  await transitionCommand(db, record.id, {
    status: cancelled ? 'cancelled' : 'failed',
    error,
    ...failureErrorCodeField(record.type, deployFailure, error),
  })
  commandConsumerTrace('dispatch-result', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    pendingStatus: pending.status,
    resultStatus: cancelled ? 'cancelled' : 'failed',
    error,
  })
  await applyManagedFailedSideEffect(db, record, deps, error)
  await applyEnvironmentDeployFailedSideEffect(db, record, envelope, error)
  await applyFabricFailedSideEffect(db, record, envelope)
  await applyFirewallFailedSideEffect(db, record, envelope, error)
}

async function handlePendingExpired(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
  deps?: CommandConsumerDeps
): Promise<void> {
  await transitionCommand(db, record.id, { status: 'timed_out' })
  commandConsumerTrace('dispatch-result', {
    commandId: record.id,
    commandType: record.type,
    serverId: envelope.serverId,
    pendingStatus: pending.status,
    resultStatus: 'timed_out',
  })
  await applyManagedFailedSideEffect(db, record, deps, pending.error ?? 'Command timed out')
  await applyEnvironmentDeployFailedSideEffect(db, record, envelope, 'timed_out', 'timed_out')
  await applyFabricFailedSideEffect(db, record, envelope)
  await applyFirewallFailedSideEffect(db, record, envelope, pending.error ?? 'Command timed out')
}

async function handlePendingUnexpected(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord
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
  await applyEnvironmentDeployFailedSideEffect(db, record, envelope, error)
}

async function applyPendingOutcome(
  db: Db,
  record: DispatchableCommandRecord,
  envelope: CommandEnvelope,
  pending: PendingRequestRecord,
  deps?: CommandConsumerDeps
): Promise<void> {
  switch (pending.status) {
    case 'done':
      await handlePendingDone(db, record, envelope, pending, deps)
      return
    case 'failed':
      await handlePendingFailed(db, record, envelope, pending, deps)
      return
    case 'expired':
      await handlePendingExpired(db, record, envelope, pending, deps)
      return
    default:
      await handlePendingUnexpected(db, record, envelope, pending)
  }
}

export async function processCommandEnvelope(
  db: Db,
  registry: DaemonCellRegistry,
  envelope: CommandEnvelope,
  deps?: CommandConsumerDeps
): Promise<void> {
  const record = await loadDispatchableRecord(db, envelope)
  if (!record) return

  await markDispatching(db, record, envelope)

  const notReady = await ensureServerAndDaemonOnline(db, registry, record, envelope)
  if (notReady !== null) {
    // A deploy that never reached its server fails its row and halts the
    // rollout, or later batches would wait on an `applying` row forever.
    await applyEnvironmentDeployFailedSideEffect(db, record, envelope, notReady)
    await applyFabricFailedSideEffect(db, record, envelope)
    return
  }

  const pending = await enqueueAndAwaitOutcome(db, registry, record, envelope, deps)
  if (!pending) return

  await applyPendingOutcome(db, record, envelope, pending, deps)
}
