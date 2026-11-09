import type { Context, Env, Hono } from 'hono'
import { upgradeWebSocket } from 'hono/deno'
import type { WSContext } from 'hono/ws'
import type {
  DaemonCellRegistry,
  DaemonCellSnapshot,
  PendingRequestRecord,
} from '../contracts/cell.ts'
import type {
  BackupCopyReportResultMessage,
  BackupRunReportResultMessage,
  CommandOutcomeAckMessage,
  DaemonInboundEnvelope,
  DaemonInboundFrameResult,
  DaemonMessage,
  DaemonOutboundEnvelope,
  DevHostStatusMessage,
} from '../contracts/cell-protocol.ts'
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_WS_POLICY_VIOLATION_CLOSE,
  outboundEnvelopeToWireMessage,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from '../contracts/cell-protocol.ts'
import { instanceAttachVersionFrame } from './attach-version.ts'
import {
  createDaemonSessionSender,
  type DaemonSessionPhase,
  type DaemonSessionSender,
  decideFirstFrame,
  PANEL_IDENTITY_CLOSE_CODE,
  SIGNED_SEND_FAILED_REASON,
} from './signed-session-gate.ts'
import { buildSignedHello } from '../lib/panel-identity/signed-session.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { HEARTBEAT_SECONDS_DEFAULT } from '../features/install/heartbeat-policy.ts'
import type { DaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import { tryAssignColocatedDaemonToInstalledOrganization } from '../client/authn/install-state.ts'
import { emitCertificateRenewalFailed } from '../features/notifications/certificate-alerts.ts'
import { handleRepoKeyChanged } from '../features/notifications/repo-key-alerts.ts'
import { intakeHelloPinReport } from './pin-report-intake.ts'
import { handleAcmeIssuanceEvent } from '../client/tls/acme-issuance-event.ts'
import { handleHttpIssuanceInbound } from '../features/tls/http-issuance/events.ts'
import {
  type InstanceAcmeIssuanceMessage,
  recordInstanceAcmeIssuanceFromServer,
} from './instance-acme-inbound.ts'
import {
  persistDaemonReachedTarget,
  persistUpgradeOutcome,
  persistUpgradeProgress,
} from '../features/upgrades/persist.ts'
import { recordCommandProgress } from '../features/commands/command-progress.ts'
import {
  ackForReportedOutcome,
  noteReportedCommands,
} from '../features/commands/command-recovery.ts'
import { getDb } from '../db/connection.ts'
import type { Db } from '../db/connection.ts'
import { compatLogError, compatLogInfo, compatLogWarn } from '../lib/log-compat.ts'
import { forEachSequential } from '../lib/sequential.ts'
import { cellTrace, daemonCellLog, logWarn } from '../lib/logger.ts'
import {
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonInbound,
  onDaemonUpdateResult,
} from './cell/control-plane-monitor.ts'
import { CLIENT_WS_PATH, DAEMON_WS_PATH, DEVELOPER_WS_PATH } from '../app/surfaces.ts'
import { resolveSelfHostedGeo } from '../features/geo/self-hosted-geo-provider.ts'
import {
  DIRECT_ATTACH_SENTINEL,
  parseTrustedProxyCidrs,
  resolvePeerAddress,
} from '../lib/peer-address.ts'
import { resourcesFromDaemonPresence } from '../features/servers/server-metadata.ts'
import { parseServiceRunStates } from '../contracts/service-run-state.ts'
import { touchServerMetadata } from '../features/servers/server-registry.ts'
import { verifyDaemonJwt } from './authn/daemon-jwt.ts'
import {
  getServerDaemonStateByServerId,
  isCurrentActiveDaemonKey,
} from '../features/servers/server-identity-db.ts'
import type { CommandQueue } from '../features/commands/queue.ts'
import type { RateLimiter } from './rate-limit/contracts.ts'
import {
  backupRunReportResultMessage,
  createBackupRunReportStore,
  handleBackupRunReport,
} from '../features/backups/run-report.ts'
import {
  backupCopyReportResultMessage,
  createBackupCopyReportStore,
  handleBackupCopyReport,
} from '../features/backups/copy-report.ts'
import { handleManagedHaEvent } from '../features/managed/ha-event.ts'
import { handleManagedHealthReport } from '../features/managed/health-report.ts'
import {
  FabricPeerReportThrottle,
  handleFabricPeersReport,
  takeFabricPeersReport,
} from '../features/fabric/peer-report.ts'
import {
  resolveAutoFailoverFromDenoEnv,
  resolveFreshStandbyMarginMsFromDenoEnv,
} from '../features/managed/auto-failover-switch.ts'
import { createFreshStandbyProbe } from '../client/managed/health-probe.ts'
import { enqueueLatestRecordedCapabilityPlan } from '../client/servers/capability-plan-push.ts'
import { recordTopologyGeneration } from '../features/servers/server-topology-records.ts'
import { createInboundWindowGate } from './rate-limit/inbound-window.ts'
import { daemonConnectRateLimitKey } from './rate-limit/keys.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { resolveSession } from '../client/authn/middleware.ts'
import { isSuperadminRole } from '../client/authn/session-store.ts'
import { verifyLocalConsoleAuthorization } from '../developer/local-console-auth.ts'
import { refuseUnsignedDaemonUpgrade } from './authn/upgrade-signature.ts'
import {
  ATTACH_PROOF_CLOSE_CODE,
  ATTACH_PROOF_MISSING_REASON,
  ATTACH_PROOF_REFUSED_REASON,
  DAEMON_PROOF_TRUST_LEVEL,
  decideAttachProof,
} from './authn/attach-proof.ts'
import { helloListsSignedReports, intakeSignedSessionReport } from './authn/report-signature.ts'
import {
  raiseServerTrustLevel,
  recordServerSignsReports,
  recordTrustDowngradeRefused,
} from '../features/servers/trust-level.ts'

/** Max idle block for outbox pump reads — keep low so new commands aren't stuck behind a long sleep. */
const OUTBOX_PUMP_BLOCK_MS = 250

/** Longest wait between two failed outbox pump turns. */
const OUTBOX_PUMP_MAX_BACKOFF_MS = 5_000

/**
 * How long the outbox pump waits before its next turn after `consecutiveFailures`
 * failed turns in a row: nothing while it is healthy, then 250 ms doubling up to
 * five seconds. A failed read can come back at once (Redis answers an error
 * before any block), so without this wait one lasting error spins the pump and
 * fills the log.
 */
export function outboxPumpBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  return Math.min(OUTBOX_PUMP_BLOCK_MS * 2 ** (consecutiveFailures - 1), OUTBOX_PUMP_MAX_BACKOFF_MS)
}

/** Decode a Hono/Deno WS frame (`string | Blob | ArrayBufferLike`) to UTF-8 text. */
export async function wsMessageDataToString(
  data: string | Blob | ArrayBufferLike
): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return await data.text()
  return new TextDecoder().decode(data)
}

export function isClosedConnectionError(err: unknown): boolean {
  return /connection is closed/i.test(String(err))
}

function assignColocatedDaemonOnConnect(db: Db, registry: DaemonCellRegistry): void {
  void tryAssignColocatedDaemonToInstalledOrganization(db, registry).catch((err) => {
    compatLogError('ws', `failed to assign colocated server: ${String(err)}`)
  })
}

/**
 * After license invalidation, Redis purge cannot close the live socket — reject
 * the next inbound frame when the JWT kid no longer matches an active key. The
 * upgrade runs the same check first, so this one only catches a key revoked
 * while the socket was already open.
 */
async function assertDaemonKeyStillActive(
  db: Db,
  serverId: string,
  keyId: string,
  ws: WSContext<WebSocket>
): Promise<boolean> {
  const daemonRow = await getServerDaemonStateByServerId(db, serverId)
  if (!isCurrentActiveDaemonKey(daemonRow, keyId)) {
    cellTrace('inbound-key-revoked', { serverId, keyId })
    ws.close(DAEMON_WS_POLICY_VIOLATION_CLOSE, 'key_revoked')
    return false
  }
  return true
}

export type DaemonOutboxPumpParams = {
  cell: Pick<
    ReturnType<DaemonCellRegistry['getCell']>,
    'readOutboxBatch' | 'markSent' | 'ackOutbox' | 'putSnapshot'
  >
  serverId: string
  connectionId: string
  consumer: string
  /** The socket's sender: plain JSON, or a signed envelope once the session is signed. */
  send: (wire: { type: string }) => Promise<void>
  abortRef: { abort: boolean }
  /** Waits out the pause after a failed turn. Tests pass their own; the default is a timer. */
  sleep?: (ms: number) => Promise<void>
}

/** Failed turns in a row, and the error already logged for this run of failures. */
type OutboxPumpHealth = { failures: number; loggedError: string | null }

function sleepForOutboxPump(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // A pause must never keep the process alive on its own at shutdown.
    Deno.unrefTimer(setTimeout(resolve, ms))
  })
}

/** Send one outbox batch to the socket: mark sent, send, then ack, one envelope at a time. */
async function sendOutboxBatch(
  params: DaemonOutboxPumpParams,
  batch: DaemonOutboundEnvelope[]
): Promise<void> {
  const { cell, serverId, connectionId, consumer, send } = params
  await forEachSequential(batch, async (envelope) => {
    const wireMsg = outboundEnvelopeToWireMessage(envelope)
    await cell.markSent(envelope.deliveryId, connectionId)
    cellTrace('outbox-send', {
      serverId,
      conn: connectionId,
      deliveryId: envelope.deliveryId,
      requestId: envelope.requestId,
      kind: envelope.kind,
    })
    await send(wireMsg)
    await cell.ackOutbox([envelope.deliveryId], consumer)
  })
  if (batch.length > 0) {
    await cell.putSnapshot({
      lastOutboundAt: new Date().toISOString(),
    })
  }
}

/**
 * One turn of the outbox pump: read a batch and send it. True when the pump
 * must keep going, false once it was aborted or the connection is closed. A
 * failed turn is counted in `health` and the pump goes on; the error is logged
 * when it first appears or changes, never once per turn, and one line marks the
 * recovery.
 */
async function pumpOutboxOnce(
  params: DaemonOutboxPumpParams,
  health: OutboxPumpHealth
): Promise<boolean> {
  const { cell, consumer, abortRef, serverId } = params
  try {
    const batch = await cell.readOutboxBatch({
      consumer,
      count: 50,
      blockMs: OUTBOX_PUMP_BLOCK_MS,
    })
    await sendOutboxBatch(params, batch)
    if (health.failures > 0) {
      compatLogInfo(
        'ws',
        `outbox pump for ${serverId} recovered after ${health.failures} failed turn(s)`
      )
      health.failures = 0
      health.loggedError = null
    }
    return true
  } catch (err) {
    if (abortRef.abort) return false
    if (isClosedConnectionError(err)) {
      abortRef.abort = true
      return false
    }
    health.failures += 1
    const message = String(err)
    if (health.loggedError !== message) {
      health.loggedError = message
      compatLogWarn(
        'ws',
        `outbox pump error for ${serverId}, retrying with a growing pause (repeats are not logged): ${message}`
      )
    }
    return true
  }
}

/**
 * Nothing awaits the pump: it lives as long as the socket, so each turn
 * schedules the next one detached instead of looping inside one promise. After
 * a failed turn the next one waits `outboxPumpBackoffMs` first.
 *
 * Exported for tests.
 */
export function startDaemonOutboxPump(params: DaemonOutboxPumpParams): void {
  const health: OutboxPumpHealth = { failures: 0, loggedError: null }
  const sleep = params.sleep ?? sleepForOutboxPump
  const turn = (): void => {
    if (params.abortRef.abort) return
    void pumpOutboxOnce(params, health).then(async (keepGoing) => {
      if (!keepGoing) return
      const pauseMs = outboxPumpBackoffMs(health.failures)
      if (pauseMs > 0) await sleep(pauseMs)
      turn()
    })
  }
  turn()
}

function detachDaemonSocketSafe(
  cell: ReturnType<DaemonCellRegistry['getCell']>,
  params: {
    connectionId: string
    reason: string
    closedAt: string
  },
  db: Db,
  serverId: string,
  connectionId: string | undefined
): void {
  void cell
    .detachDaemonSocket(params)
    .then(async () => {
      cellTrace('detach', {
        serverId,
        conn: connectionId,
        reason: params.reason,
      })
      await onDaemonDisconnected(db, serverId, cell)
      daemonCellLog('INFO', serverId, connectionId, 'daemon disconnected')
    })
    .catch((err) => {
      if (isClosedConnectionError(err)) {
        return
      }
      compatLogWarn('ws', `detachDaemonSocket failed: ${String(err)}`)
    })
}

/**
 * Handle the wire cell ping: pong immediately, refresh presence, and repair a
 * Postgres-only false-offline that can linger after a prior Redis demotion.
 *
 * Exported for tests — this is the only frame an idle daemon sends.
 */
export async function handleDaemonCellPing(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  ws: WSContext<WebSocket>
}): Promise<void> {
  const { cell, db, serverId, connectionId, ws } = params
  const pingAt = new Date().toISOString()
  cellTrace('ping', { serverId, conn: connectionId })
  ws.send(DAEMON_CELL_PONG)
  cellTrace('pong', { serverId, conn: connectionId })
  // Snapshot before recordInbound: after a false Redis demotion the cell may
  // still show connected=0 so we can re-project Postgres online. recordInbound
  // alone self-heals Redis and would make a later inbound hit
  // steadyStateInboundSkipsDbRead while Postgres stays offline (UI shows Offline
  // despite a live socket).
  const snapshotBefore = await cell.getSnapshot()
  await cell.recordInbound({ connectionId, at: pingAt })
  if (!snapshotBefore.connected) {
    await onDaemonConnected(db, serverId, cell, snapshotBefore.connectedAt ?? pingAt)
    return
  }
  // Redis already connected — still repair Postgres-only false offline (stuck
  // after a prior demotion that self-healed Redis only).
  const daemonRow = await getServerDaemonStateByServerId(db, serverId)
  if (daemonRow?.status?.connected === false) {
    await onDaemonConnected(db, serverId, cell, snapshotBefore.connectedAt ?? pingAt)
  }
}

function rejectDaemonInboundFrame(
  ws: WSContext<WebSocket>,
  serverId: string,
  connectionId: string | undefined,
  reason: string
): void {
  cellTrace('inbound-rejected', {
    serverId,
    conn: connectionId,
    reason,
  })
  compatLogWarn('ws', `rejected inbound frame from ${connectionId ?? 'unknown'}: ${reason}`)
  ws.close(DAEMON_WS_POLICY_VIOLATION_CLOSE, 'policy_violation')
}

/** A well-formed frame whose `type` this process does not know. Socket stays up. */
function traceIgnoredUnknownInboundType(
  serverId: string,
  connectionId: string | undefined,
  reason: string
): void {
  cellTrace('inbound-ignored-unknown-type', {
    serverId,
    conn: connectionId,
    reason,
  })
}

async function handleUpdateProgressInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'update-progress' }>
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  await cell.recordInbound({ connectionId, at: message.at })
  await persistUpgradeProgress(db, {
    serverId,
    upgradeId: message.upgradeId,
    unit: message.unit,
    stage: message.stage,
    at: message.at,
    detail: message.detail,
    errorCode: message.errorCode,
    restart: message.restart,
    requestId: message.id,
  })
}

/**
 * Fire-and-forget deploy progress: liveness, then the step plan onto the
 * command row (own server, still live). A bad payload is dropped, the socket
 * stays up.
 */
async function handleCommandProgressInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'command-progress' }>
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  await cell.recordInbound({ connectionId, at: message.at })
  const result = await recordCommandProgress(db, {
    serverId,
    commandId: message.commandId,
    progress: message.progress,
  })
  if (result !== 'stored') {
    cellTrace(`command-progress-${result}`, {
      serverId,
      conn: connectionId,
      commandId: message.commandId,
    })
  }
}

async function handleDaemonPresenceInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'hello' | 'heartbeat' }>
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  const presence = message as unknown as Record<string, unknown>
  // Snapshot before recordInbound, which marks Redis connected again; otherwise
  // onDaemonInbound sees a connected cell and skips the Postgres online write
  // after a stale sweep (same ordering rule as handleDaemonCellPing).
  const snapshotBefore = await cell.getSnapshot()
  const resources = resourcesFromDaemonPresence(presence)
  const services = parseServiceRunStates(presence.services)

  if (message.type === 'hello') {
    await touchServerMetadata(db, serverId, {
      hostname: message.hostname,
      machineKey: message.machineKey,
      os: message.os,
      resources,
      timeSync: message.timeSync,
      docker: message.docker,
      releaseLinkScan: message.releaseLinkScan,
      services,
      features: message.features ?? [],
      ...(message.panelPin ? { panelPin: message.panelPin } : {}),
    })
  } else if (
    message.timeSync ||
    resources !== undefined ||
    message.docker ||
    message.releaseLinkScan ||
    services !== undefined
  ) {
    await touchServerMetadata(db, serverId, {
      resources,
      timeSync: message.timeSync,
      docker: message.docker,
      releaseLinkScan: message.releaseLinkScan,
      services,
    })
  }

  await noteReportedCommands(db, serverId, message.commands)
  await cell.recordInbound({
    connectionId,
    at: message.at,
    daemonBuild: message.daemonBuild,
  })
  await onDaemonInbound(db, serverId, cell, {
    at: message.at,
    daemonBuild: message.daemonBuild,
    runtimeWasOffline: !snapshotBefore.connected,
  })
  const commit = message.daemonBuild?.commit
  if (commit) {
    await persistDaemonReachedTarget(db, serverId, commit, message.at)
  }
}

async function handleDaemonManagedHaInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'managed-ha-event' }>
  commandQueue?: CommandQueue
  registry?: DaemonCellRegistry
  reporterServerId: string
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await handleManagedHaEvent(
    db,
    {
      managedId: message.managedId,
      sourceMemberId: message.sourceMemberId,
      ...(message.detector ? { detector: message.detector } : {}),
      ...(message.instanceHost ? { instanceHost: message.instanceHost } : {}),
      ...(message.instancePort ? { instancePort: message.instancePort } : {}),
      ...(message.evidence ? { evidence: message.evidence } : {}),
      at: message.at,
    },
    {
      commandQueue: params.commandQueue,
      reporterServerId: params.reporterServerId,
      autoFailover: resolveAutoFailoverFromDenoEnv(),
      probeStandby: createFreshStandbyProbe(db, params.registry),
      freshStandbyMarginMs: resolveFreshStandbyMarginMsFromDenoEnv(),
    }
  )
  await cell.recordInbound({ connectionId, at: message.at })
}

async function handleDaemonManagedHealthReportInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'managed-health-report' }>
  reporterServerId: string
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await handleManagedHealthReport(db, {
    reporterServerId: params.reporterServerId,
    members: message.members,
  })
  await cell.recordInbound({ connectionId, at: message.at })
}

/**
 * Process-wide "once per 60 s per server, unless a peer's health class
 * changed" gate for `fabric-peers-report`.
 */
const fabricPeerReportThrottle = new FabricPeerReportThrottle()

async function handleDaemonFabricPeersReportInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'fabric-peers-report' }>
  reporterServerId: string
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  if (
    takeFabricPeersReport(fabricPeerReportThrottle, params.reporterServerId, message, Date.now())
  ) {
    await handleFabricPeersReport(db, {
      reporterServerId: params.reporterServerId,
      peers: message.peers,
      observedAt: message.observedAt,
    })
  }
  await cell.recordInbound({ connectionId, at: message.at })
}

async function handleDaemonRepoKeyChangedInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'repo-key-changed' }>
  dataEncryptionSecrets: DerivedSecretsConfig | undefined
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  await handleRepoKeyChanged(db, params.dataEncryptionSecrets, serverId, message)
  await cell.recordInbound({ connectionId, at: message.at })
}

async function handleAcmeIssuanceInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'acme-issuance-event' }>
  dataEncryptionSecrets: DerivedSecretsConfig | undefined
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  await cell.recordInbound({ connectionId, at: message.at })
  await handleAcmeIssuanceEvent(
    db,
    {
      serverId,
      hostname: message.hostname,
      ok: message.ok,
      at: message.at,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      ...(message.notAfter ? { notAfter: message.notAfter } : {}),
    },
    {
      onNewFailure: (failure) =>
        emitCertificateRenewalFailed(db, params.dataEncryptionSecrets, failure),
    }
  )
}

async function handleInstanceAcmeIssuanceInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  message: InstanceAcmeIssuanceMessage
}): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  await cell.recordInbound({ connectionId, at: message.at })
  await recordInstanceAcmeIssuanceFromServer(db, serverId, message)
}

async function handleDaemonTopologyReportInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'topology-report' }>
  reporterServerId: string
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await recordTopologyGeneration(db, params.reporterServerId, {
    generation: message.generation,
    bootGeneration: message.bootGeneration,
    snapshot: message.snapshot,
    appliedAt: message.at,
  })
  await cell.recordInbound({ connectionId, at: message.at })
}

async function applyDaemonInboundEnvelope(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  envelope: DaemonInboundEnvelope
}): Promise<PendingRequestRecord | null> {
  const { cell, db, serverId, envelope } = params
  const record = await cell.handleInbound(envelope)
  if (envelope.kind === 'update-result' && record) {
    await onDaemonUpdateResult(
      db,
      serverId,
      envelope.requestId,
      envelope.ok,
      envelope.at,
      envelope.error,
      envelope.errorCode
    )
  }
  if (envelope.kind === 'update-result') {
    await persistUpgradeOutcome(db, {
      serverId,
      unit: 'daemon',
      upgradeId: envelope.upgradeId,
      ok: envelope.ok,
      at: envelope.at,
      error: envelope.error,
      errorCode: envelope.errorCode,
      requestId: envelope.requestId,
    })
  }
  if (envelope.kind === 'instance-update-result') {
    await persistUpgradeOutcome(db, {
      serverId,
      unit: 'instance',
      upgradeId: envelope.upgradeId,
      ok: envelope.ok,
      at: envelope.at,
      error: envelope.error,
      errorCode: envelope.errorCode,
      requestId: envelope.requestId,
    })
  }
  return record
}

/**
 * Receives `dev-host-status` from the co-located daemon (feature
 * `dev-host-v1`). Supplied only by the development entry (`src/deno-dev.ts`);
 * without it, and for any daemon that is not co-located, the frame only
 * records liveness.
 */
export type DevHostStatusSink = (report: {
  serverId: string
  status: DevHostStatusMessage['status']
  at: string
}) => void

/** Everything the per-type inbound handlers need for one validated frame. */
type DaemonInboundDispatch = {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  serverId: string
  connectionId: string | undefined
  commandQueue?: CommandQueue
  /** Reaches other servers' cells (the HA event probes a standby's daemon). */
  registry?: DaemonCellRegistry
  message: DaemonMessage
  /** Seals alert channel addresses when an event notifies; omit and only the bell is written. */
  dataEncryptionSecrets?: DerivedSecretsConfig
  /** True when the frame came over the co-located Unix-socket attach (no peer address). */
  colocated?: boolean
  /** Development entry only: receives the co-located daemon's `dev-host-status`. */
  onDevHostStatus?: DevHostStatusSink
  /** Answer on the socket the frame arrived on (daemon-initiated requests). */
  reply: (
    message: BackupRunReportResultMessage | CommandOutcomeAckMessage | BackupCopyReportResultMessage
  ) => void
}

/**
 * Answer only once the outcome is known: an error escapes to the socket's
 * exception boundary, nothing is sent, and the daemon resends the report.
 */
async function handleBackupRunReportInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'backup-run-report' }>
  reporterServerId: string
  reply: DaemonInboundDispatch['reply']
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await cell.recordInbound({ connectionId, at: message.at })
  const outcome = await handleBackupRunReport(createBackupRunReportStore(db), message, {
    reporterServerId: params.reporterServerId,
  })
  params.reply(backupRunReportResultMessage(message.id, outcome, new Date().toISOString()))
}

/** Same answer rule as the run report: reply once the outcome is known; an error escapes and the daemon resends. */
async function handleBackupCopyReportInbound(params: {
  cell: ReturnType<DaemonCellRegistry['getCell']>
  db: Db
  connectionId: string | undefined
  message: Extract<DaemonMessage, { type: 'backup-copy-report' }>
  reporterServerId: string
  reply: DaemonInboundDispatch['reply']
}): Promise<void> {
  const { cell, db, connectionId, message } = params
  await cell.recordInbound({ connectionId, at: message.at })
  const outcome = await handleBackupCopyReport(createBackupCopyReportStore(db), message, {
    reporterServerId: params.reporterServerId,
  })
  params.reply(backupCopyReportResultMessage(message.id, outcome, new Date().toISOString()))
}

/**
 * Route one validated, key-checked daemon frame to its handler. Types with no
 * dedicated handler record liveness and, when they carry a correlated result,
 * apply the inbound envelope to the cell.
 */
export async function dispatchDaemonInboundMessage(params: DaemonInboundDispatch): Promise<void> {
  const { cell, db, serverId, message } = params
  if (message.type === 'hello' || message.type === 'heartbeat') {
    await dispatchDaemonInboundByType(params)
    return
  }
  // Every other frame marks Redis connected via recordInbound but projects
  // nothing to Postgres: re-project online when a stale sweep had demoted it.
  const snapshotBefore = await cell.getSnapshot()
  try {
    await dispatchDaemonInboundByType(params)
  } catch (err) {
    // A handler that fails after recordInbound leaves Redis connected, so the
    // next frame would see steady state: repair here when it got that far.
    if (!snapshotBefore.connected && (await cell.getSnapshot()).connected) {
      await restoreProjectedOnline(db, serverId, cell, snapshotBefore, message.at)
    }
    throw err
  }
  if (!snapshotBefore.connected) {
    await restoreProjectedOnline(db, serverId, cell, snapshotBefore, message.at)
  }
}

async function restoreProjectedOnline(
  db: Db,
  serverId: string,
  cell: ReturnType<DaemonCellRegistry['getCell']>,
  snapshotBefore: DaemonCellSnapshot,
  at: string | undefined
): Promise<void> {
  await onDaemonConnected(
    db,
    serverId,
    cell,
    snapshotBefore.connectedAt ?? at ?? new Date().toISOString()
  )
}

async function dispatchDaemonInboundByType(params: DaemonInboundDispatch): Promise<void> {
  const { cell, db, serverId, connectionId, message } = params
  switch (message.type) {
    case 'hello':
    case 'heartbeat':
      await handleDaemonPresenceInbound({
        cell,
        db,
        serverId,
        connectionId,
        message,
      })
      return
    case 'managed-ha-event':
      await handleDaemonManagedHaInbound({
        cell,
        db,
        connectionId,
        message,
        commandQueue: params.commandQueue,
        registry: params.registry,
        reporterServerId: serverId,
      })
      return
    case 'managed-health-report':
      await handleDaemonManagedHealthReportInbound({
        cell,
        db,
        connectionId,
        message,
        reporterServerId: serverId,
      })
      return
    case 'fabric-peers-report':
      await handleDaemonFabricPeersReportInbound({
        cell,
        db,
        connectionId,
        message,
        reporterServerId: serverId,
      })
      return
    case 'dev-host-status':
      await cell.recordInbound({ connectionId, at: message.at })
      if (params.colocated === true && params.onDevHostStatus) {
        params.onDevHostStatus({ serverId, status: message.status, at: message.at })
      }
      return
    case 'topology-report':
      await handleDaemonTopologyReportInbound({
        cell,
        db,
        connectionId,
        message,
        reporterServerId: serverId,
      })
      return
    case 'repo-key-changed':
      await handleDaemonRepoKeyChangedInbound({
        cell,
        db,
        serverId,
        connectionId,
        message,
        dataEncryptionSecrets: params.dataEncryptionSecrets,
      })
      return
    case 'acme-issuance-event':
      await handleAcmeIssuanceInbound({
        cell,
        db,
        serverId,
        connectionId,
        message,
        dataEncryptionSecrets: params.dataEncryptionSecrets,
      })
      return
    case 'acme-issue-event':
    case 'acme-proof-forward-ready':
    case 'acme-proof-forward-failed':
      await cell.recordInbound({ connectionId, at: message.at })
      await handleHttpIssuanceInbound(db, serverId, message)
      return
    case 'instance-acme-issuance-event':
      await handleInstanceAcmeIssuanceInbound({
        cell,
        db,
        serverId,
        connectionId,
        message,
      })
      return
    case 'backup-run-report':
      await handleBackupRunReportInbound({
        cell,
        db,
        connectionId,
        message,
        reporterServerId: serverId,
        reply: params.reply,
      })
      return
    case 'backup-copy-report':
      await handleBackupCopyReportInbound({
        cell,
        db,
        connectionId,
        message,
        reporterServerId: serverId,
        reply: params.reply,
      })
      return
    case 'update-progress':
      await handleUpdateProgressInbound({
        cell,
        db,
        serverId,
        connectionId,
        message,
      })
      return
    case 'command-progress':
      await handleCommandProgressInbound({
        cell,
        db,
        serverId,
        connectionId,
        message,
      })
      return
    default:
      await cell.recordInbound({ connectionId, at: message.at })
      await applyWireMessageEnvelope(cell, db, serverId, message, params.reply)
  }
}

async function applyWireMessageEnvelope(
  cell: ReturnType<DaemonCellRegistry['getCell']>,
  db: Db,
  serverId: string,
  message: DaemonMessage,
  reply: DaemonInboundDispatch['reply']
): Promise<void> {
  const envelope = wireMessageToInboundEnvelope(message)
  if (!envelope) return
  const record = await applyDaemonInboundEnvelope({ cell, db, serverId, envelope })
  if (envelope.kind !== 'command-outcome') return
  // The daemon keeps its copy of the result until this confirms it is stored.
  const ack = await ackForReportedOutcome(db, { serverId, envelope, record })
  if (ack !== null) reply(ack)
}

export type DaemonWebSocketOptions = {
  developerSurface?: boolean
  db?: Db
  secrets?: DaemonJwtKeyring
  /** Session keyring used to authorize the placeholder client/developer WS. */
  sessionSecrets?: DerivedSecretsConfig
  /** Reads and seals notification channel addresses for alerts the daemon's events raise. */
  dataEncryptionSecrets?: DerivedSecretsConfig
  daemonCellRegistry?: DaemonCellRegistry
  connectLimiter?: RateLimiter
  inboundMessageLimit?: number
  inboundMessageWindowMs?: number
  commandQueue?: CommandQueue
  /**
   * Peer addresses whose forwarding headers are believed. Defaults to loopback
   * (`TURBOPANEL_TRUSTED_PROXY_CIDRS` widens it for a connector on another
   * host); see `peer-address.ts`.
   */
  trustedProxyCidrs?: readonly string[]
  /**
   * Cached advised heartbeat in seconds for the attach `version` frame. Must
   * not touch the database: the attach path calls it once per connection.
   */
  heartbeatSeconds?: () => number
  /** Waits out the pause after a failed outbox pump turn. Tests pass their own; the default is a timer. */
  outboxPumpSleep?: (ms: number) => Promise<void>
  /** The identity key; null or absent = no signed sessions (a pinned daemon is refused). */
  panelIdentity?: () => Promise<PanelIdentity | null>
  /** The control plane's public origins, sent in the signed hello. */
  identityUrls?: (db: Db) => Promise<string[]>
  /** Development entry only: the co-located daemon's `dev-host-status` sink. */
  onDevHostStatus?: DevHostStatusSink
}

/**
 * Env-configured trusted proxies, read once per process. `Deno.env` is absent
 * on Workers, where this transport is not registered at all.
 */
let cachedTrustedProxyCidrs: string[] | undefined
function trustedProxyCidrs(): string[] {
  cachedTrustedProxyCidrs ??= parseTrustedProxyCidrs(
    (
      globalThis as {
        Deno?: { env?: { get(key: string): string | undefined } }
      }
    ).Deno?.env?.get('TURBOPANEL_TRUSTED_PROXY_CIDRS')
  )
  return cachedTrustedProxyCidrs
}

export function registerDaemonWebSocket<E extends Env>(
  app: Hono<E>,
  options: DaemonWebSocketOptions
): void {
  const inboundMessageLimit = options.inboundMessageLimit ?? 120
  const inboundMessageWindowMs = options.inboundMessageWindowMs ?? 60_000

  app.get(DAEMON_WS_PATH, async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }

    const authHeader = c.req.header('authorization')?.trim() ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : ''
    if (!token || !options.secrets) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
    const payload = await verifyDaemonJwt(token, options.secrets)
    if (!payload) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }

    if (options.connectLimiter) {
      const { success } = await options.connectLimiter.limit({
        key: daemonConnectRateLimitKey(payload.sub),
      })
      if (!success) {
        return c.text('Too Many Requests', 429)
      }
    }

    const db = options.db
    if (!db) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const registry = options.daemonCellRegistry
    if (!registry) {
      return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    }

    // CF-Connecting-IP is honoured only when the immediate peer is a trusted
    // local proxy, so a Cloudflare Tunnel in front of the instance reports
    // the daemon's real address while a daemon dialling Caddy directly
    // cannot forge one. See `peer-address.ts`.
    const peer = resolvePeerAddress(
      {
        realIp: c.req.header('x-real-ip'),
        forwardedFor: c.req.header('x-forwarded-for'),
        cfConnectingIp: c.req.header('cf-connecting-ip'),
      },
      {
        runtime: 'deno',
        trustedProxyCidrs: options.trustedProxyCidrs ?? trustedProxyCidrs(),
      }
    )

    // A valid JWT is not enough to open a socket: it outlives a revoke by up
    // to its full lifetime. Without this, a revoked host reconnected with its
    // cached token, and the open handler re-created its lease, marked it
    // online and pushed its capability plan before the first inbound frame
    // was checked. Hosted refuses at the same point (`workers-ws.ts`).
    //
    // One case passes through: a co-located daemon whose server row is gone.
    // The open handler closes it with 4401 `server row missing`, which is the
    // signal that makes it enroll again.
    const daemonState = await getServerDaemonStateByServerId(db, payload.sub)
    const colocatedRowMissing = daemonState === null && peer?.address === undefined
    if (!colocatedRowMissing && !isCurrentActiveDaemonKey(daemonState, payload.kid)) {
      return c.json({ ok: false, error: 'forbidden' }, 403)
    }
    const refused = daemonState
      ? await refuseUnsignedDaemonUpgrade({
          db,
          request: c.req.raw,
          serverId: payload.sub,
          cnfJkt: payload.cnf?.jkt,
          state: daemonState,
          panelIdentity: options.panelIdentity,
        })
      : null
    if (refused) return c.json({ ok: false, error: refused.error }, refused.status)

    return upgradeWebSocket(() => {
      const remoteAddress = peer?.address
      const identityAddress = remoteAddress ?? DIRECT_ATTACH_SENTINEL
      const connectedAt = new Date().toISOString()

      let connectionId: string | undefined
      let leaseHolder: string | undefined
      const pumpControl = { abort: false }
      let attachReady = false
      const pendingMessages: string[] = []
      const inboundGate = createInboundWindowGate(inboundMessageLimit, inboundMessageWindowMs)
      // Nothing goes to the daemon until its first frame says which session
      // it runs (`signed-session-gate.ts`).
      let phase: DaemonSessionPhase = 'await-first-frame'
      // Set by the first frame; a frame that arrives while it is still being
      // answered waits for it instead of opening a second session.
      let sessionOpening: Promise<boolean> | undefined
      let sender: DaemonSessionSender | undefined
      // A signed session's outbox waits for the daemon's presence hello and
      // its attach proof; the version frame does not.
      let awaitingAttach: { sessionId: string; kid: string } | undefined
      // The signed session's id, and whether the daemon's hello said it signs
      // its reports (`report-signature.ts`).
      let signedSessionId: string | undefined
      let daemonSignsReports = false
      // The server has sent a verified signed report (`trust_reports_signed_at`
      // at upgrade, or earlier on this socket): its unsigned reports are refused.
      let serverSignsReports = daemonState?.reportsSigned === true
      // The unsigned-report warning is logged once per connection.
      let warnedUnsigned = false
      const senderFor = (ws: WSContext<WebSocket>): DaemonSessionSender => {
        sender ??= createDaemonSessionSender({
          sendText: (text) => ws.send(text),
          onSignedSendFailure: () => {
            pumpControl.abort = true
            ws.close(1011, SIGNED_SEND_FAILED_REASON)
          },
        })
        return sender
      }

      /** An answer to a frame the daemon sent; a failed signed send already closed the socket. */
      const replyToDaemon = (ws: WSContext<WebSocket>, answer: { type: string }): void => {
        senderFor(ws)
          .send(answer)
          .catch(() => undefined)
      }

      const startPump = (ws: WSContext<WebSocket>): void => {
        if (!connectionId) return
        const send = senderFor(ws)
        startDaemonOutboxPump({
          cell: registry.getCell(payload.sub),
          serverId: payload.sub,
          connectionId,
          consumer: `ws:${connectionId}`,
          send: (wire) => send.send(wire),
          abortRef: pumpControl,
          sleep: options.outboxPumpSleep,
        })
      }

      const startSession = (ws: WSContext<WebSocket>, pump: boolean): void => {
        const send = senderFor(ws)
        send
          .send(
            instanceAttachVersionFrame(connectedAt, Deno.env.toObject(), {
              heartbeatSeconds: options.heartbeatSeconds?.() ?? HEARTBEAT_SECONDS_DEFAULT,
            })
          )
          .catch((err) => {
            daemonCellLog(
              'WARN',
              payload.sub,
              connectionId,
              `attach version frame failed: ${String(err)}`
            )
          })
        if (pump) startPump(ws)
      }

      /**
       * The first presence hello of a signed session: check the attach proof,
       * raise the server once it verified, then let the outbox run. False when
       * the socket was closed.
       */
      const acceptAttach = async (
        attach: unknown,
        session: { sessionId: string; kid: string },
        ws: WSContext<WebSocket>
      ): Promise<boolean> => {
        const trustLevel = daemonState?.trustLevel ?? 0
        const decision = await decideAttachProof(attach, {
          sessionId: session.sessionId,
          panelFingerprint: session.kid,
          serverId: payload.sub,
          keyId: daemonState?.key.id,
          publicJwk: daemonState?.key.publicJwk,
          trustLevel,
          nowMs: Date.now(),
        })
        if (decision.kind === 'refused') {
          daemonCellLog('WARN', payload.sub, connectionId, `attach refused: ${decision.reason}`)
          pumpControl.abort = true
          ws.close(ATTACH_PROOF_CLOSE_CODE, ATTACH_PROOF_REFUSED_REASON)
          if (decision.reason === ATTACH_PROOF_MISSING_REASON) {
            await recordTrustDowngradeRefused(db, payload.sub, {
              stage: 'attach',
              reason: decision.reason,
            })
          }
          return false
        }
        if (decision.kind === 'verified' && trustLevel < DAEMON_PROOF_TRUST_LEVEL) {
          // Best effort: the next proof raises it again; the session goes on.
          await raiseServerTrustLevel(db, payload.sub, DAEMON_PROOF_TRUST_LEVEL).catch((err) => {
            daemonCellLog(
              'WARN',
              payload.sub,
              connectionId,
              `trust level raise failed: ${String(err)}`
            )
          })
        }
        awaitingAttach = undefined
        startPump(ws)
        return true
      }

      /** Handles the first frame; true when the frame is then processed as usual. */
      const openSession = async (raw: string, ws: WSContext<WebSocket>): Promise<boolean> => {
        const decision = await decideFirstFrame(raw, {
          trustLevel: daemonState?.trustLevel ?? 0,
          panelIdentity: options.panelIdentity,
        })
        if (decision.kind === 'refused') {
          daemonCellLog('WARN', payload.sub, connectionId, `session refused: ${decision.reason}`)
          pumpControl.abort = true
          ws.close(PANEL_IDENTITY_CLOSE_CODE, decision.reason)
          return false
        }
        if (decision.kind === 'legacy') {
          phase = 'legacy'
          startSession(ws, true)
          return true
        }
        const urls = options.identityUrls ? await options.identityUrls(db).catch(() => []) : []
        ws.send(
          await buildSignedHello(decision.identity, decision.nonce, decision.session, {
            heartbeatSeconds: options.heartbeatSeconds?.() ?? HEARTBEAT_SECONDS_DEFAULT,
            urls,
          })
        )
        senderFor(ws).enterSigned(decision.identity, decision.session)
        phase = 'signed'
        signedSessionId = decision.session.sessionId
        awaitingAttach = { sessionId: decision.session.sessionId, kid: decision.session.kid }
        startSession(ws, false)
        return false
      }

      /** The first hello of a signed session passes the attach-proof check; anything else goes on. */
      const presenceAdmitted = async (
        message: { type: string; attach?: unknown; panelPin?: unknown; features?: unknown },
        ws: WSContext<WebSocket>
      ): Promise<boolean> => {
        if (phase === 'signed' && message.type === 'hello') {
          daemonSignsReports = helloListsSignedReports(message.features)
        }
        if (!awaitingAttach || message.type !== 'hello') return true
        const session = awaitingAttach
        if (!(await acceptAttach(message.attach, session, ws))) return false
        // The signed pin report rides on the same hello; it never holds up the session.
        void intakeHelloPinReport(message.panelPin, {
          sessionId: session.sessionId,
          serverId: payload.sub,
          keyId: daemonState?.key.id,
          publicJwk: daemonState?.key.publicJwk,
          identity: async () => (await options.panelIdentity?.()) ?? null,
          secrets: options.dataEncryptionSecrets,
          withDb: (fn) => fn(db),
        }).catch(() => {})
        return true
      }

      const handleInboundMessage = async (raw: string, ws: WSContext<WebSocket>): Promise<void> => {
        // Exception boundary — mirrors DO webSocketMessage (log + swallow) so a
        // transient DB/cell error cannot tear down the daemon WebSocket.
        try {
          await handleInboundMessageBody(raw, ws)
        } catch (err) {
          compatLogError(
            'ws',
            `inbound message error serverId=${payload.sub} conn=${
              connectionId ?? 'unknown'
            }: ${String(err)}`
          )
        }
      }

      const keyStillActive = (ws: WSContext<WebSocket>): Promise<boolean> =>
        assertDaemonKeyStillActive(db, payload.sub, payload.kid, ws)

      const handlePingFrame = async (ws: WSContext<WebSocket>): Promise<void> => {
        if (!(await keyStillActive(ws))) return
        await handleDaemonCellPing({
          cell: registry.getCell(payload.sub),
          db,
          serverId: payload.sub,
          connectionId,
          ws,
        })
      }

      const handleUnacceptedFrame = async (
        failure: Extract<DaemonInboundFrameResult, { ok: false }>,
        ws: WSContext<WebSocket>
      ): Promise<void> => {
        if (!failure.ignored) {
          rejectDaemonInboundFrame(ws, payload.sub, connectionId, failure.reason)
          return
        }
        // Unknown types stay on the socket, but they are still the next
        // inbound frame — a revoked key must close here. Redis purge
        // cannot drop the live socket, and a peer that sends only
        // unrecognized types would otherwise stay up inside the rate cap.
        // The inbound gate already ran in onMessage, ahead of validation.
        if (!(await keyStillActive(ws))) return
        traceIgnoredUnknownInboundType(payload.sub, connectionId, failure.reason)
      }

      /** A signed session's report checked and unwrapped; null = drop it. */
      const screenSignedReport = async (raw: string): Promise<string | null> => {
        if (phase !== 'signed' || !signedSessionId) return raw
        const intake = await intakeSignedSessionReport(raw, {
          sessionId: signedSessionId,
          keyId: daemonState?.key.id,
          publicJwk: daemonState?.key.publicJwk,
          daemonSignsReports,
          serverSignsReports,
          nowMs: Date.now(),
        })
        if (intake.verdict === 'verified' && !serverSignsReports) {
          // From now on on this socket, and on the row for later sessions.
          serverSignsReports = true
          void recordServerSignsReports(db, payload.sub).catch((err) => {
            daemonCellLog(
              'WARN',
              payload.sub,
              connectionId,
              `reports-signed write failed: ${String(err)}`
            )
          })
        }
        // Refusals always log; the unsigned-report warning once per connection.
        const repeat = intake.verdict === 'unsigned' && warnedUnsigned
        if (intake.verdict === 'unsigned') warnedUnsigned = true
        if (intake.warning && !repeat) {
          daemonCellLog('WARN', payload.sub, connectionId, intake.warning)
        }
        return intake.raw
      }

      /** A signed report checked, then the frame validated; null when dropped or refused. */
      const acceptedFrame = async (
        raw: string,
        ws: WSContext<WebSocket>
      ): Promise<Extract<DaemonInboundFrameResult, { ok: true }> | null> => {
        const frame = await screenSignedReport(raw)
        if (frame === null) return null
        const validated = validateDaemonInboundFrame(frame)
        if (validated.ok) return validated
        await handleUnacceptedFrame(validated, ws)
        return null
      }

      const handleInboundMessageBody = async (
        raw: string,
        ws: WSContext<WebSocket>
      ): Promise<void> => {
        if (phase === 'await-first-frame') {
          if (sessionOpening) {
            await sessionOpening
            if (phase === 'await-first-frame') return
          } else {
            sessionOpening = openSession(raw, ws)
            if (!(await sessionOpening)) return
          }
        }
        if (raw === DAEMON_CELL_PING) {
          await handlePingFrame(ws)
          return
        }

        const validated = await acceptedFrame(raw, ws)
        if (!validated) return
        const message = validated.message
        for (const note of validated.notes ?? []) {
          logWarn(
            'daemon-cell',
            `inbound-note serverId=${payload.sub} conn=${connectionId} ${note}`
          )
        }

        if (!(await keyStillActive(ws))) return

        if (!(await presenceAdmitted(message, ws))) return

        cellTrace('inbound', {
          serverId: payload.sub,
          conn: connectionId,
          type: message.type,
        })

        await dispatchDaemonInboundMessage({
          cell: registry.getCell(payload.sub),
          db,
          serverId: payload.sub,
          connectionId,
          commandQueue: options.commandQueue,
          registry,
          message,
          dataEncryptionSecrets: options.dataEncryptionSecrets,
          colocated: remoteAddress === undefined,
          onDevHostStatus: options.onDevHostStatus,
          reply: (answer) => replyToDaemon(ws, answer),
        })
      }

      return {
        async onOpen(_event, ws) {
          // Before attaching, so a co-located daemon whose row is gone (the one
          // case the upgrade lets through without a current key) never takes a
          // lease, joins the online set or reclaims queued work.
          if (identityAddress === DIRECT_ATTACH_SENTINEL) {
            const daemonRow = colocatedRowMissing
              ? null
              : await getServerDaemonStateByServerId(db, payload.sub)
            if (!daemonRow) {
              compatLogWarn(
                'ws',
                `colocated daemon ${payload.sub} has no postgres row; forcing re-enroll`
              )
              pumpControl.abort = true
              ws.close(4401, 'server row missing')
              return
            }
          }

          const cell = registry.getCell(payload.sub)
          try {
            const attached = await cell.attachDaemonSocket({
              keyId: payload.kid,
              remoteAddress: identityAddress,
              connectedAt,
            })
            connectionId = attached.connectionId
            leaseHolder = attached.lease.holder
          } catch (err) {
            daemonCellLog('WARN', payload.sub, undefined, `daemon attach failed: ${String(err)}`)
            ws.close(1013, 'attach failed')
            return
          }

          const geo = resolveSelfHostedGeo(remoteAddress)
          await onDaemonConnected(
            db,
            payload.sub,
            cell,
            connectedAt,
            undefined,
            geo ?? undefined,
            payload.kid
          )

          await enqueueLatestRecordedCapabilityPlan(
            db,
            payload.sub,
            (envelope) => cell.enqueue(envelope),
            'self-hosted'
          )

          cellTrace('attach', {
            serverId: payload.sub,
            conn: connectionId,
            remoteAddress: identityAddress,
          })

          const connectedFromSuffix = peer ? ` from ${peer.address} (${peer.source})` : ''
          daemonCellLog('INFO', payload.sub, connectionId, `daemon connected${connectedFromSuffix}`)

          if (identityAddress === DIRECT_ATTACH_SENTINEL) {
            assignColocatedDaemonOnConnect(db, registry)
          }

          // The `version` frame and the outbox pump wait for the daemon's
          // first frame (`openSession`).
          attachReady = true
          await forEachSequential(pendingMessages.splice(0), (raw) => handleInboundMessage(raw, ws))
        },
        async onMessage(event, ws) {
          const raw = await wsMessageDataToString(event.data)
          const gateKey = connectionId ?? identityAddress
          if (!inboundGate.allow(gateKey)) {
            cellTrace('inbound-rate-limited', {
              serverId: payload.sub,
              conn: connectionId,
            })
            pendingMessages.length = 0
            pumpControl.abort = true
            ws.close(1008, 'rate_limited')
            return
          }
          if (!attachReady) {
            if (pendingMessages.length >= inboundMessageLimit) {
              pendingMessages.length = 0
              pumpControl.abort = true
              ws.close(1008, 'rate_limited')
              return
            }
            pendingMessages.push(raw)
            return
          }
          await handleInboundMessage(raw, ws)
        },
        onClose() {
          pumpControl.abort = true
          if (connectionId) {
            inboundGate.release(connectionId)
          } else {
            inboundGate.release(identityAddress)
          }
          if (connectionId && leaseHolder) {
            const cell = registry.getCell(payload.sub)
            detachDaemonSocketSafe(
              cell,
              {
                connectionId,
                reason: 'closed',
                closedAt: new Date().toISOString(),
              },
              db,
              payload.sub,
              connectionId
            )
          }
        },
        onError() {
          pumpControl.abort = true
          if (connectionId) {
            inboundGate.release(connectionId)
          } else {
            inboundGate.release(identityAddress)
          }
          if (connectionId && leaseHolder) {
            const cell = registry.getCell(payload.sub)
            detachDaemonSocketSafe(
              cell,
              {
                connectionId,
                reason: 'error',
                closedAt: new Date().toISOString(),
              },
              db,
              payload.sub,
              connectionId
            )
          }
        },
      }
    })(c, next)
  })

  if (options.developerSurface) {
    registerStubWebSocket(app, DEVELOPER_WS_PATH, 'developer', (c) =>
      authorizeDeveloperUpgrade(c, options.sessionSecrets)
    )
  }
  registerStubWebSocket(app, CLIENT_WS_PATH, 'client', (c) =>
    authorizeClientUpgrade(c, options.sessionSecrets)
  )
}

/**
 * Authorize a placeholder-WS upgrade. Returns an error `Response` to reject the
 * upgrade, or `null` when the caller may proceed. Mirrors the access checks of
 * the matching REST surface.
 */
type StubUpgradeGuard = (c: Context) => Promise<Response | null>

/** Client WS requires a valid end-user session cookie (same as client REST). */
async function authorizeClientUpgrade(
  c: Context,
  sessionSecrets: DerivedSecretsConfig | undefined
): Promise<Response | null> {
  if (!sessionSecrets) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  const resolved = await resolveSession(c, sessionSecrets, getDb(c))
  return resolved ? null : c.json({ ok: false, error: 'unauthorized' }, 401)
}

/**
 * Developer WS requires developer access: a superadmin session cookie, or HMAC
 * local-console auth (same as the developer REST surface).
 */
async function authorizeDeveloperUpgrade(
  c: Context,
  sessionSecrets: DerivedSecretsConfig | undefined
): Promise<Response | null> {
  if (sessionSecrets) {
    const resolved = await resolveSession(c, sessionSecrets, getDb(c))
    if (resolved && isSuperadminRole(resolved.data.role)) {
      return null
    }
    if (await verifyLocalConsoleAuthorization(c)) {
      return null
    }
    return resolved
      ? c.json({ ok: false, error: 'forbidden' }, 403)
      : c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  if (await verifyLocalConsoleAuthorization(c)) {
    return null
  }
  return c.json({ ok: false, error: 'unauthorized' }, 401)
}

/**
 * Placeholder WebSocket surface for the admin/client UIs. Today the UIs poll
 * REST; these endpoints reserve the namespace for future live streaming.
 *
 * They are **not** open idle sockets: the upgrade is rejected unless the caller
 * passes the same access check as the matching REST surface, and — because
 * there is no live streaming yet — an authorized peer is greeted once and then
 * immediately closed so placeholder sockets cannot accumulate idle connections.
 */
function registerStubWebSocket<E extends Env>(
  app: Hono<E>,
  path: string,
  surface: string,
  authorize: StubUpgradeGuard
): void {
  app.get(path, async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }
    const denied = await authorize(c)
    if (denied) {
      return denied
    }
    return upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        ws.send(
          JSON.stringify({
            type: 'hello',
            surface,
            at: new Date().toISOString(),
          })
        )
        // No live streaming yet — greet then close so authorized peers cannot
        // hold the placeholder socket open indefinitely.
        ws.close(1000, 'not_implemented')
      },
    }))(c, next)
  })
}
