/**
 * Rotate a tunnel's run token without removing the tunnel.
 *
 * 1. A tunnel secret is chosen once and sealed before the provider is ever
 *    asked; under a short lease the provider is given that secret, which
 *    issues the new token (`rotateRunToken`). Sending the same secret again is
 *    harmless, so a retry, a crash or two advancers all end with one token.
 *    Connectors already connected stay up, but the old token can no longer
 *    open a connection.
 * 2. The new token is sealed into a second `secret` row. Until the rotation
 *    ends, each carrying server is given the old or the new token on its own
 *    (`runSecretFor`): servers still waiting keep the old one, so a resend or a
 *    placement change never moves them early.
 * 3. One server at a time is moved: once no older connector list is still on
 *    its way to it, its list goes out with the new token (the daemon restarts
 *    that connector in place, feature `tunnel-connector-token-change-v1`), the
 *    server is asked for its connector status until it reports `connected` on
 *    the new token, and traffic is given ten minutes to move onto it (the
 *    provider's documented wait) before the next server. A server that cannot
 *    be reached waits behind the others.
 * 4. Every connection of the tunnel is dropped once, so one opened with the old
 *    token cannot stay; our connectors reconnect at once. The tunnel then takes
 *    the new secret row and the old one is deleted.
 *
 * Progress lives in `tunnel.metadata.runTokenRotation` (no new table, column
 * or status). When no remaining server can be reached the rotation stops and
 * the sweep resumes it on its own; a server that refuses the list, does not
 * confirm the token or does not connect in time stops it until a person
 * starts it again (which resumes from where it stopped). The token and the
 * secret are never logged, audited or returned.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, secret, server, tunnel } from '../../db/schema.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  TUNNEL_CONNECTOR_FEATURE,
  TUNNEL_CONNECTOR_TOKEN_CHANGE_FEATURE,
  TUNNEL_STATUS_FEATURE,
} from '../../lib/version-wire.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { parseTunnelStatusResult } from '../../contracts/commands/tunnel-status.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { newTunnelSecret, type TunnelAdapter } from './adapter.ts'
import { useBadges } from './badge-use.ts'
import { connectorServerProblem, syncServerTunnelConnectors } from './connector-sync.ts'
import { carryingServers, refuse, TunnelRefusal, type TunnelRow } from './lifecycle.ts'
import { findCarrier } from './records.ts'
import { createTunnelAdapterRegistry } from './registry.ts'
import { compareText } from './order.ts'
import { RUN_SECRET_PROVIDER, type TunnelProvider } from './vocabulary.ts'
import {
  type ApiRotation,
  claimHeld,
  dueForRetry,
  readRotation,
  ROTATION_SERVER_LIMIT_MS,
  ROTATION_SETTLE_MS,
  type RotationState,
  settling,
  STATUS_ASK_AGAIN_MS,
  rotationActive,
  rotationWarnings,
  toApiRotation,
} from './rotation-state.ts'

// ---------------------------------------------------------------------------
// Storage

/**
 * Save the rotation onto the tunnel row, but only if no one saved a newer step
 * in between. Returns the saved state, or null when another writer was first.
 */
async function saveRotation(
  db: Db,
  tunnelId: string,
  read: RotationState | null,
  next: Omit<RotationState, 'step'>
): Promise<RotationState | null> {
  const step = (read?.step ?? 0) + 1
  const saved: RotationState = { ...next, step }
  const guard = read
    ? sql`(${tunnel.metadata} -> 'runTokenRotation' ->> 'step')::int = ${read.step}`
    : sql`(${tunnel.metadata} -> 'runTokenRotation') IS NULL`
  const rows = await db
    .update(tunnel)
    .set({
      metadata: sql`jsonb_set(coalesce(${tunnel.metadata}, '{}'::jsonb), '{runTokenRotation}', ${JSON.stringify(saved)}::jsonb)`,
    })
    .where(and(eq(tunnel.id, tunnelId), guard))
    .returning({ id: tunnel.id })
  return rows.length > 0 ? saved : null
}

async function loadTunnel(db: Db, tunnelId: string): Promise<TunnelRow | null> {
  const [row] = await db.select().from(tunnel).where(eq(tunnel.id, tunnelId)).limit(1)
  return row ?? null
}

// ---------------------------------------------------------------------------
// Readiness

/** The carrying servers whose daemon cannot follow a rotation (or report status). */
export async function serversThatCannotRotate(
  db: Db,
  serverIds: readonly string[]
): Promise<string[]> {
  const states = await Promise.all(serverIds.map((id) => getServerDaemonStateByServerId(db, id)))
  return serverIds.filter((_, index) => {
    const features = states[index]?.projection?.features ?? []
    return ![
      TUNNEL_CONNECTOR_FEATURE,
      TUNNEL_CONNECTOR_TOKEN_CHANGE_FEATURE,
      TUNNEL_STATUS_FEATURE,
    ].every((feature) => features.includes(feature))
  })
}

/** Carrying servers that cannot be sent a connector list now. */
async function serversNotReady(
  db: Db,
  organizationId: string,
  serverIds: readonly string[]
): Promise<string[]> {
  const problems = await Promise.all(
    serverIds.map((id) => connectorServerProblem(db, organizationId, id))
  )
  return serverIds.filter((_, index) => problems[index] !== null)
}

export type RotationDeps = Readonly<{
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
  adapter?: TunnelAdapter
  /** The wait after a server connects before the next one is moved (tests set 0). */
  settleMs?: number
}>

function adapterFor(deps: RotationDeps, row: TunnelRow): TunnelAdapter {
  return deps.adapter ?? createTunnelAdapterRegistry()(row.provider as TunnelProvider)
}

const IN_PROGRESS = 'The run token of this Tunnel is already being replaced'

/**
 * The refusals that come before anything changes. Returns the carrying servers,
 * sorted (the order they are moved in), and the warnings for the person.
 */
/**
 * Why a rotation cannot start now (removing, not at the provider, under way,
 * a daemon that cannot follow, a carrier that cannot be reached), or null.
 * The screen reads it to hide or disable the action with the reason; a start
 * throws it. A single carrier is not a block (it needs a confirmation).
 */
export async function rotationBlock(
  db: Db,
  row: TunnelRow,
  read: RotationState | null = readRotation(row.metadata)
): Promise<TunnelRefusal | null> {
  if (row.status === 'removing') {
    return new TunnelRefusal('tunnel_removing', 409, 'This Tunnel is being removed')
  }
  if (!row.externalId || !row.carrierId) {
    return new TunnelRefusal(
      'tunnel_not_ready',
      409,
      'This Tunnel does not exist at the provider yet'
    )
  }
  if (rotationActive(read)) return new TunnelRefusal('rotation_in_progress', 409, IN_PROGRESS)
  const carrying = (await carryingServers(db, row)).toSorted(compareText)
  const old = await serversThatCannotRotate(db, carrying)
  if (old.length > 0) {
    const names = old.length === 1 ? '1 server runs' : `${old.length} servers run`
    return new TunnelRefusal(
      'tunnel_daemon_too_old',
      409,
      `${names} a daemon that cannot move its connector to a new run token. Update it first.`,
      { serverIds: old }
    )
  }
  // Everything knowable is checked before the provider is asked: that call cannot be undone.
  const notReady = await serversNotReady(db, row.routingOrganizationId, carrying)
  if (notReady.length > 0) {
    const names =
      notReady.length === 1 ? '1 server that runs' : `${notReady.length} servers that run`
    return new TunnelRefusal(
      'server_not_ready',
      409,
      `${names} this Tunnel cannot be sent its connector right now (offline, or its daemon key is not usable). Try again once it is back.`,
      { serverIds: notReady }
    )
  }
  return null
}

async function checkCanRotate(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  read: RotationState | null,
  options: { confirmSingleServer: boolean }
): Promise<{ carrying: string[]; warnings: string[] }> {
  if (isNoopCommandQueue(deps.commandQueue)) {
    throw new TunnelRefusal('rotation_unavailable', 409, 'Servers cannot be reached from here')
  }
  const blocked = await rotationBlock(db, row, read)
  if (blocked) throw blocked
  const carrying = (await carryingServers(db, row)).toSorted(compareText)
  const warnings = rotationWarnings(carrying)
  if (carrying.length === 1 && !options.confirmSingleServer) {
    throw new TunnelRefusal('rotation_single_server', 409, warnings[0]!, { warnings })
  }
  return { carrying, warnings }
}

/**
 * The state a start saves: a stopped rotation resumes where it stopped (the
 * server that stopped it is checked again from the start), keeping the secret
 * it chose and the token it got, so nothing is ever rotated twice; otherwise a
 * new one begins.
 */
function startingState(
  read: RotationState | null,
  carrying: string[],
  now: string
): Omit<RotationState, 'step'> {
  if (read?.phase === 'stopped' && (read.newSecretId || read.tunnelSecretId)) {
    return resumedState(read, now)
  }
  return { phase: 'starting', startedAt: now, pending: carrying, moved: [] }
}

/** A stopped rotation, going again. */
function resumedState(read: RotationState, now: string): Omit<RotationState, 'step'> {
  return {
    ...read,
    phase: read.newSecretId ? 'rolling' : 'starting',
    stoppedReason: undefined,
    stoppedAt: undefined,
    retryable: undefined,
    claimedAt: undefined,
    current: read.current ? { serverId: read.current.serverId, since: now } : undefined,
  }
}

/**
 * Start (or resume a stopped) rotation. Refuses a tunnel that is not at the
 * provider yet, is being removed or is already rotating, a carrying server
 * whose daemon cannot follow, and a single carrier without `confirmSingleServer`.
 */
export async function startRunTokenRotation(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  options: { confirmSingleServer: boolean }
): Promise<{ rotation: ApiRotation; warnings: string[] }> {
  const read = readRotation(row.metadata)
  const { carrying, warnings } = await checkCanRotate(db, deps, row, read, options)
  const saved = await saveRotation(
    db,
    row.id,
    read,
    startingState(read, carrying, new Date().toISOString())
  )
  if (!saved) throw new TunnelRefusal('rotation_in_progress', 409, IN_PROGRESS)
  const advanced = await advanceRunTokenRotation(db, deps, row.id)
  return { rotation: toApiRotation(advanced ?? saved)!, warnings }
}

// ---------------------------------------------------------------------------
// Advancing

async function stop(
  db: Db,
  tunnelId: string,
  state: RotationState,
  reason: string,
  options: { retryable?: boolean } = {}
): Promise<RotationState | null> {
  compatLogWarn('tunnel-rotation', `tunnel ${tunnelId}: stopped: ${reason}`)
  return await saveRotation(db, tunnelId, state, {
    ...state,
    phase: 'stopped',
    stoppedReason: reason,
    stoppedAt: new Date().toISOString(),
    claimedAt: undefined,
    ...(options.retryable ? { retryable: true } : {}),
  })
}

/** Choose the tunnel secret once and seal it, before the provider is ever asked. */
async function chooseSecret(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  const [sealed] = await db
    .insert(secret)
    .values({
      organizationId: row.organizationId,
      provider: RUN_SECRET_PROVIDER,
      name: `${row.name} tunnel secret (rotation)`.slice(0, 120),
      secretEnvelope: await encryptSecret(deps.dataEncryptionSecrets, newTunnelSecret()),
    })
    .returning({ id: secret.id })
  const saved = await saveRotation(db, row.id, state, { ...state, tunnelSecretId: sealed!.id })
  // Lost to another writer: its secret is the one in use, not this one.
  if (!saved) await db.delete(secret).where(eq(secret.id, sealed!.id))
  return saved
}

async function openSecret(db: Db, deps: RotationDeps, secretId: string): Promise<string | null> {
  const [stored] = await db
    .select({ secretEnvelope: secret.secretEnvelope })
    .from(secret)
    .where(eq(secret.id, secretId))
    .limit(1)
  return stored ? await decryptSecret(deps.dataEncryptionSecrets, stored.secretEnvelope) : null
}

/**
 * Give the tunnel the chosen secret at the provider and seal the token that
 * comes back beside the old one. The secret was saved before, and a short
 * lease (a guarded save) lets only one advancer ask at a time, so a retry, a
 * crash or two advancers all send the same secret and get the same token.
 */
async function issueNewToken(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  const owner = await findCarrier(db, row.organizationId, row.carrierId!)
  if (!owner) return await stop(db, row.id, state, 'The provider account of this Tunnel is gone')
  if (!state.tunnelSecretId) return await chooseSecret(db, deps, row, state)
  // Another attempt is asking the provider right now: wait for it.
  if (claimHeld(state, Date.now())) return state
  const claimed = await saveRotation(db, row.id, state, {
    ...state,
    claimedAt: new Date().toISOString(),
  })
  if (!claimed) return null
  const tunnelSecret = await openSecret(db, deps, claimed.tunnelSecretId!)
  if (!tunnelSecret) return await stop(db, row.id, claimed, 'The chosen tunnel secret is gone')
  const adapter = adapterFor(deps, row)
  let runToken: string
  try {
    const used = await useBadges(
      db,
      deps.dataEncryptionSecrets,
      owner.id,
      { capability: 'tunnels' },
      (token) =>
        adapter.rotateRunToken(token, {
          accountId: owner.externalAccountId,
          externalId: row.externalId!,
          tunnelSecret,
        })
    )
    runToken = used.value
  } catch (err) {
    const refused = refuse(err, 'edit Tunnels')
    const reason = refused instanceof Error ? refused.message : 'The provider refused'
    return await stop(db, row.id, claimed, reason)
  }
  const [sealed] = await db
    .insert(secret)
    .values({
      organizationId: row.organizationId,
      provider: RUN_SECRET_PROVIDER,
      name: `${row.name} run token (new)`.slice(0, 120),
      secretEnvelope: await encryptSecret(deps.dataEncryptionSecrets, runToken),
    })
    .returning({ id: secret.id })
  const saved = await saveRotation(db, row.id, claimed, {
    ...claimed,
    phase: claimed.pending.length > 0 ? 'rolling' : 'finishing',
    newSecretId: sealed!.id,
    tunnelSecretId: undefined,
    claimedAt: undefined,
  })
  if (!saved) {
    await db.delete(secret).where(eq(secret.id, sealed!.id))
    return null
  }
  // The secret did its job: the token is what servers run on now.
  await db.delete(secret).where(eq(secret.id, claimed.tunnelSecretId!))
  return saved
}

async function commandRow(db: Db, commandId: string | undefined) {
  if (!commandId) return undefined
  const [row] = await db
    .select({ status: command.status, resultSummary: command.resultSummary })
    .from(command)
    .where(eq(command.id, commandId))
    .limit(1)
  return row
}

async function askStatus(db: Db, queue: CommandQueue, serverId: string): Promise<string | null> {
  const record = await createCommandRecord(db, {
    serverId,
    actorType: 'system',
    actorId: serverId,
    type: 'server.tunnel.status',
    payload: {},
    expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: 'server.tunnel.status',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await queue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, { status: 'failed', error: 'Command queue unavailable' })
    return null
  }
  return record.id
}

/**
 * Did the connector list that carried the new token leave this tunnel's
 * connector on it? The daemon lists a connector it (re)installed under
 * `installed`, and one already on exactly the token sent under `unchanged`
 * (a token it cannot unseal fails the command instead). Anything else, or an
 * answer that cannot be read, is not a confirmation.
 */
export function listHoldsToken(resultSummary: unknown, externalId: string): boolean {
  const result = resultSummary as { installed?: unknown; unchanged?: unknown } | null
  const has = (list: unknown) => Array.isArray(list) && list.includes(externalId)
  return has(result?.installed) || has(result?.unchanged)
}

/** Is this tunnel's connector on the server connected, from a finished status answer? */
export function connectorConnected(resultSummary: unknown, externalId: string): boolean | null {
  try {
    const result = parseTunnelStatusResult(resultSummary)
    const connector = result.connectors.find((c) => c.tunnelId === externalId)
    if (!connector) return false
    if (connector.status === 'connected') return true
    return connector.status === 'connecting' ? null : false
  } catch {
    return null
  }
}

async function serverReachable(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ isConnected: server.isConnected })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.isConnected === true
}

/** The first waiting server that can be reached, and the queue with unreachable ones moved behind it. */
async function nextReachable(
  db: Db,
  pending: readonly string[]
): Promise<{ serverId: string | null; queue: string[] }> {
  const reachable = await Promise.all(pending.map((id) => serverReachable(db, id)))
  const index = reachable.indexOf(true)
  if (index < 0) return { serverId: null, queue: [...pending] }
  return {
    serverId: pending[index]!,
    queue: [...pending.slice(index + 1), ...pending.slice(0, index)],
  }
}

/**
 * Move the next waiting server: give it the new token and remember the
 * command. A server that cannot be reached now waits behind the others; when
 * none can be reached the rotation stops, and the sweep resumes it on its own.
 */
async function moveNext(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  // Traffic is given time to move onto the last server's new connector first.
  if (settling(state, Date.now(), deps.settleMs ?? ROTATION_SETTLE_MS)) return state
  const carrying = new Set(await carryingServers(db, row))
  // A server that no longer carries the tunnel needs no new token.
  const pending = state.pending.filter((id) => carrying.has(id))
  if (pending.length === 0) {
    return await saveRotation(db, row.id, state, {
      ...state,
      pending: [],
      current: undefined,
      phase: 'finishing',
    })
  }
  const { serverId, queue } = await nextReachable(db, pending)
  if (!serverId) {
    const names = pending.join(', ')
    return await stop(db, row.id, { ...state, pending }, `Server ${names} cannot be reached`, {
      retryable: true,
    })
  }
  const moved = await saveRotation(db, row.id, state, {
    ...state,
    pending: queue,
    moved: [...state.moved, serverId],
    current: { serverId, since: new Date().toISOString() },
  })
  if (!moved) return null
  return await sendNewToken(db, deps, row, moved)
}

/** Is a connector list still on its way to this server? */
async function connectorsCommandOpen(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: command.id })
    .from(command)
    .where(
      and(
        eq(command.serverId, serverId),
        eq(command.name, 'server.tunnel.connectors'),
        inArray(command.status, [...OPEN_STATUSES])
      )
    )
    .limit(1)
  return row !== undefined
}

const OPEN_STATUSES = ['queued', 'dispatching', 'sent', 'acked', 'running'] as const

/** Send the current server its connector list (it now carries the new token). */
async function sendNewToken(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  const current = state.current!
  // An older list still on its way could land after this one and put the old
  // token back: wait until the server has none outstanding.
  if (await connectorsCommandOpen(db, current.serverId)) return state
  // Always sent, even when the list looks current: the server must answer for this token.
  const outcome = await syncServerTunnelConnectors(db, deps, {
    organizationId: row.routingOrganizationId,
    serverId: current.serverId,
    force: true,
  })
  if (outcome.status !== 'sent') {
    const reason = outcome.status === 'unchanged' ? 'nothing to send' : outcome.reason
    return await stop(db, row.id, state, `Server ${current.serverId}: ${reason}`)
  }
  return await saveRotation(db, row.id, state, {
    ...state,
    current: { ...current, connectorsCommandId: outcome.commandId },
  })
}

const FINISHED = new Set(['succeeded', 'failed', 'expired', 'cancelled'])

/** Check the current server; when its connector is connected on the new token, move on. */
async function checkCurrent(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  const current = state.current!
  if (Date.now() - Date.parse(current.since) > ROTATION_SERVER_LIMIT_MS) {
    return await stop(
      db,
      row.id,
      state,
      `Server ${current.serverId} did not connect on the new token within ${ROTATION_SERVER_LIMIT_MS / 60_000} minutes`
    )
  }
  if (!current.connectorsCommandId) return await sendNewToken(db, deps, row, state)
  const sent = await commandRow(db, current.connectorsCommandId)
  if (!sent || (FINISHED.has(sent.status) && sent.status !== 'succeeded')) {
    return await stop(db, row.id, state, `Server ${current.serverId} did not take the new token`)
  }
  if (sent.status !== 'succeeded') return state
  if (!listHoldsToken(sent.resultSummary, row.externalId!)) {
    return await stop(
      db,
      row.id,
      state,
      `Server ${current.serverId} did not confirm its connector on the new token`
    )
  }
  const asked = await commandRow(db, current.statusCommandId)
  if (
    asked?.status === 'succeeded' &&
    connectorConnected(asked.resultSummary, row.externalId!) === true
  ) {
    return await saveRotation(db, row.id, state, {
      ...state,
      current: undefined,
      lastConnectedAt: new Date().toISOString(),
    })
  }
  const askedLongAgo =
    !current.statusAskedAt || Date.now() - Date.parse(current.statusAskedAt) > STATUS_ASK_AGAIN_MS
  if (current.statusCommandId && !askedLongAgo) return state
  const statusCommandId = await askStatus(db, deps.commandQueue, current.serverId)
  if (!statusCommandId) return state
  return await saveRotation(db, row.id, state, {
    ...state,
    current: { ...current, statusCommandId, statusAskedAt: new Date().toISOString() },
  })
}

/** Drop every old connection, adopt the new secret row and delete the old one. */
async function finish(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  const owner = await findCarrier(db, row.organizationId, row.carrierId!)
  const adapter = adapterFor(deps, row)
  if (!owner) {
    return await stop(
      db,
      row.id,
      state,
      'Old connections were not dropped: the provider account of this Tunnel is gone'
    )
  }
  if (!adapter.dropConnections) {
    return await stop(
      db,
      row.id,
      state,
      'Old connections were not dropped: this provider cannot drop them'
    )
  }
  {
    const drop = adapter.dropConnections.bind(adapter)
    try {
      await useBadges(
        db,
        deps.dataEncryptionSecrets,
        owner.id,
        { capability: 'tunnels' },
        (token) => drop(token, { accountId: owner.externalAccountId, externalId: row.externalId! })
      )
    } catch (err) {
      const refused = refuse(err, 'edit Tunnels')
      const reason = refused instanceof Error ? refused.message : 'The provider refused'
      return await stop(db, row.id, state, `Old connections were not dropped: ${reason}`)
    }
  }
  const oldSecretId = row.secretId
  const newSecretId = state.newSecretId!
  const done = await db.transaction(async (tx) => {
    const saved = await saveRotation(tx as unknown as Db, row.id, state, {
      ...state,
      phase: 'done',
      current: undefined,
      finishedAt: new Date().toISOString(),
    })
    if (!saved) return null
    await tx.update(tunnel).set({ secretId: newSecretId }).where(eq(tunnel.id, row.id))
    // It is the tunnel's run token now, not "the new one".
    await tx
      .update(secret)
      .set({ name: `${row.name} run token`.slice(0, 120) })
      .where(eq(secret.id, newSecretId))
    if (oldSecretId && oldSecretId !== newSecretId) {
      await tx.delete(secret).where(eq(secret.id, oldSecretId))
    }
    return saved
  })
  return done
}

/**
 * Take the rotation of one tunnel as far as it can go now, one step after
 * another until it has to wait (a command on its way, a status answer) or ends.
 * Returns the state it left, or null when there is none or another writer won.
 */
export async function advanceRunTokenRotation(
  db: Db,
  deps: RotationDeps,
  tunnelId: string,
  /** Steps left in this call: each one either waits or moves forward, so the call always ends. */
  stepsLeft = 8
): Promise<RotationState | null> {
  const row = await loadTunnel(db, tunnelId)
  if (!row) return null
  const read = readRotation(row.metadata)
  if (!read || !rotationActive(read)) return read
  if (row.status === 'removing') return await stop(db, row.id, read, 'The Tunnel is being removed')
  const next = await stepOnce(db, deps, row, read)
  if (!next) return read
  if (next.step === read.step || stepsLeft <= 1) return next
  return (await advanceRunTokenRotation(db, deps, tunnelId, stepsLeft - 1)) ?? next
}

function stepOnce(
  db: Db,
  deps: RotationDeps,
  row: TunnelRow,
  state: RotationState
): Promise<RotationState | null> {
  if (state.phase === 'starting') return issueNewToken(db, deps, row, state)
  if (state.phase === 'finishing') return finish(db, deps, row, state)
  if (state.current) return checkCurrent(db, deps, row, state)
  return moveNext(db, deps, row, state)
}

/** The sweep: move every rotation that is under way as far as it can go. */
export async function runRunTokenRotationSweepTick(
  db: Db,
  deps: RotationDeps
): Promise<{ advanced: number }> {
  if (isNoopCommandQueue(deps.commandQueue)) return { advanced: 0 }
  const rows = await db
    .select({ id: tunnel.id, metadata: tunnel.metadata })
    .from(tunnel)
    .where(
      sql`(${tunnel.metadata} -> 'runTokenRotation' ->> 'phase') IN ('starting', 'rolling', 'finishing', 'stopped')`
    )
  let advanced = 0
  await forEachSequential(rows, async ({ id, metadata }) => {
    try {
      const read = readRotation(metadata)
      // A stop for a server that could not be reached goes again on its own.
      if (read && dueForRetry(read, Date.now())) {
        await saveRotation(db, id, read, resumedState(read, new Date().toISOString()))
      } else if (!rotationActive(read)) {
        return
      }
      await advanceRunTokenRotation(db, deps, id)
      advanced += 1
    } catch (err) {
      compatLogWarn('tunnel-rotation', `tunnel ${id}: ${err instanceof Error ? err.message : err}`)
    }
  })
  return { advanced }
}
