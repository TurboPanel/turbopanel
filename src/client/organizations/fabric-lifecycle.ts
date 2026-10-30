/**
 * TurboFabric lifecycle answers for the org fabric routes: pause (turn off and
 * keep keys), remove completely (purges what needs a tunnel), and switching one server in
 * or out of the mesh.
 *
 * Every database write happens inside the request: on Workers the request's
 * client is closed once the response is sent.
 */
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { FABRIC_RETAIN_KEYS_FEATURE } from '../../lib/version-wire.ts'
import { and, eq, inArray } from 'drizzle-orm'
import { network, server } from '../../db/schema.ts'
import { parseServerDaemonState } from '../../features/servers/daemon-state.ts'
import {
  clearRelayAppliedPayloadHash,
  deleteComposeNetworkIds,
  disableOrganizationFabric,
  type FabricRecord,
  getOrganizationFabric,
  isFabricPaused,
  listFabricRelays,
  pauseOrganizationFabric,
  resetRelaysAfterQueuedTeardown,
  setFabricEnabled,
} from '../../features/fabric/fabric-records.ts'
import { type AuditEntry, recordAudit } from '../../features/audit/audit-records.ts'
import {
  enqueueFabricReconcileForServers,
  type FabricEnqueueResult,
} from '../../features/fabric/enqueue.ts'
import { reconcileServerNetworking } from '../../features/fabric/server-networking.ts'
import {
  loadContainerNetworkPieces,
  networkRidesLan,
} from '../../features/fabric/lan-pair-guard.ts'
import { loadLanPairInputs } from '../../features/fabric/lan-pairs.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  type FabricDependent,
  fabricDependentsMessage,
  findFabricDependents,
  findStoredFabricDependents,
  loadFabricServerMemberships,
  updateServerFabricMembership,
} from '../../features/fabric/membership.ts'
import {
  type FabricMembershipSecrets,
  type FabricServerPatch,
  fabricTypedEnqueueErrorResponse,
} from './fabric-routes-helpers.ts'

export type FabricLifecycleParams = {
  db: Db
  commandQueue: CommandQueue
  organizationId: string
  actorId: string
  actorEmail?: string | null
  secrets: FabricMembershipSecrets
}

function notQueuedServerIds(results: readonly FabricEnqueueResult[]): string[] {
  return results.filter((result) => result.status === 'failed').map((result) => result.serverId)
}

function queuedServerIds(results: readonly FabricEnqueueResult[]): string[] {
  return results.filter((result) => result.status !== 'failed').map((result) => result.serverId)
}

function teardownNotQueuedResponse(c: Context, message: string, serverIds: string[]): Response {
  return c.json({ error: 'fabric_teardown_not_queued', message, serverIds }, 503)
}

async function sendTeardown(
  params: FabricLifecycleParams,
  fabricRecord: FabricRecord,
  serverIds: readonly string[],
  retainKeys: boolean
): Promise<FabricEnqueueResult[]> {
  return enqueueFabricReconcileForServers({
    db: params.db,
    commandQueue: params.commandQueue,
    actorType: 'user',
    actorId: params.actorId,
    fabric: fabricRecord,
    serverIds,
    enabled: false,
    ...(retainKeys ? { retainKeys: true } : {}),
    ...params.secrets,
  })
}

/**
 * Servers whose daemon cannot pause (it would read a pause as a full tear
 * down), from the features each daemon last advertised.
 */
async function serversThatCannotPause(db: Db, serverIds: readonly string[]): Promise<string[]> {
  if (serverIds.length === 0) return []
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const ready = new Set(
    rows
      .filter((row) =>
        (parseServerDaemonState(row.daemon)?.projection?.features ?? []).includes(
          FABRIC_RETAIN_KEYS_FEATURE
        )
      )
      .map((row) => row.id)
  )
  return serverIds.filter((id) => !ready.has(id))
}

async function serverNames(
  db: Db,
  organizationId: string,
  serverIds: readonly string[]
): Promise<string[]> {
  const wanted = new Set(serverIds)
  const rows = await loadFabricServerMemberships(db, { organizationId, relays: [] })
  return rows.filter((row) => wanted.has(row.serverId)).map((row) => row.name)
}

function pauseNeedsUpdateResponse(c: Context, names: string[], serverIds: string[]): Response {
  return c.json(
    {
      error: 'fabric_pause_needs_daemon_update',
      message: `TurboFabric is still on: ${names.join(', ')} ${
        names.length === 1 ? 'runs a TurboPanel daemon' : 'run TurboPanel daemons'
      } too old to turn TurboFabric off and keep the keys. Update ${
        names.length === 1 ? 'that server' : 'those servers'
      }, or remove TurboFabric completely instead.`,
      serverIds,
    },
    409
  )
}

async function audit(
  params: FabricLifecycleParams,
  entry: Pick<AuditEntry, 'action' | 'targetType' | 'targetId' | 'context'>
): Promise<void> {
  await recordAudit(params.db, {
    organizationId: params.organizationId,
    actorUserId: params.actorId,
    actorEmail: params.actorEmail ?? null,
    ...entry,
  })
}

/**
 * Pause: every server takes `tp0` down and keeps its key; the fabric row,
 * relays and container networks stay. The row is marked paused first, so a
 * deploy waiting on the fabric never sends a tunnel back up meanwhile; when a
 * teardown cannot be queued the mark is undone. Answers null when done (or
 * nothing to do), else the refusal.
 */
export async function pauseFabric(
  c: Context,
  params: FabricLifecycleParams
): Promise<Response | null> {
  const { db, organizationId } = params
  const existing = await getOrganizationFabric(db, organizationId)
  if (!existing || isFabricPaused(existing)) return null
  const serverIds = (await listFabricRelays(db, existing.id)).map((row) => row.serverId)

  const tooOld = await serversThatCannotPause(db, serverIds)
  if (tooOld.length > 0) {
    return pauseNeedsUpdateResponse(c, await serverNames(db, organizationId, tooOld), tooOld)
  }

  const paused = await pauseOrganizationFabric(db, existing)
  const notQueued = notQueuedServerIds(await sendTeardown(params, paused, serverIds, true))
  if (notQueued.length > 0) {
    // Back on: the servers that were reached get their tunnel back on the next
    // apply (what they applied was forgotten above). Their keys are kept.
    await setFabricEnabled(db, existing, true)
    return teardownNotQueuedResponse(
      c,
      'TurboFabric is still on: turning it off could not reach every server. Servers that were reached have dropped their tunnel and get it back on the next apply. Try turning it off again.',
      notQueued
    )
  }
  await audit(params, {
    action: 'fabric.pause',
    targetType: 'organization',
    targetId: organizationId,
    context: { servers: serverIds.length },
  })
  return null
}

/** Record a resume (PUT enabled:true on a paused fabric). */
export async function auditFabricResume(params: FabricLifecycleParams): Promise<void> {
  await audit(params, {
    action: 'fabric.resume',
    targetType: 'organization',
    targetId: params.organizationId,
  })
}

/**
 * The compose networks to purge: those that need a tunnel (some pair of their
 * servers is not a trusted LAN pair) and those with no piece left. A network
 * whose servers all share a trusted LAN rides the LAN and survives the removal.
 */
async function tunnelledComposeNetworkIds(db: Db, organizationId: string): Promise<string[]> {
  const [networks, rows] = await Promise.all([
    loadContainerNetworkPieces(db, organizationId),
    db
      .select({ id: network.id })
      .from(network)
      .where(and(eq(network.organizationId, organizationId), eq(network.kind, 'compose'))),
  ])
  const inputs = await loadLanPairInputs(
    db,
    networks.flatMap((row) => row.serverIds)
  )
  const kept = new Set(networks.filter((row) => networkRidesLan(row, inputs)).map((row) => row.id))
  // A network with no piece left rides nothing: it goes too, as before.
  return rows.map((row) => row.id).filter((id) => !kept.has(id))
}

/**
 * The teardown also removed LAN routes and bridges: send the payload with no
 * tunnel again to every server still holding a network that rides the LAN.
 * Best effort: the removal is done; a server not reached now is reached by
 * the next networking change or deploy.
 */
async function resendLanOnlyNetworking(params: FabricLifecycleParams): Promise<void> {
  const results = await reconcileServerNetworking({
    db: params.db,
    commandQueue: params.commandQueue,
    actor: { type: 'user', id: params.actorId },
    organizationId: params.organizationId,
    secrets: params.secrets,
  })
  const failed = notQueuedServerIds(results)
  if (failed.length > 0) {
    compatLogWarn(
      'fabric-remove',
      `LAN-only container networking was not resent to ${failed.join(', ')} after TurboFabric was removed`
    )
  }
}

/**
 * Remove completely: tear every server down (keys deleted, including servers
 * switched out of the mesh, which kept theirs), then purge the cross-server
 * container networks that need a tunnel and the fabric row together, and
 * send the payload with no tunnel again to servers whose networks ride a
 * trusted LAN (they keep working without TurboFabric). The rows go only once
 * every teardown is queued: with the relay rows deleted nothing could ever
 * send a teardown again. A never-enabled org is a no-op.
 */
export async function removeFabric(
  c: Context,
  params: FabricLifecycleParams
): Promise<Response | null> {
  const { db, organizationId } = params
  const existing = await getOrganizationFabric(db, organizationId)
  if (!existing) return null
  const relays = await listFabricRelays(db, existing.id, { includeSwitchedOff: true })
  const results = await sendTeardown(
    params,
    existing,
    relays.map((row) => row.serverId),
    false
  )
  const notQueued = notQueuedServerIds(results)
  if (notQueued.length > 0) {
    await resetRelaysAfterQueuedTeardown(db, {
      fabricId: existing.id,
      serverIds: queuedServerIds(results),
    })
    return teardownNotQueuedResponse(
      c,
      'TurboFabric is still there: removing it could not reach every server. Servers that were reached have dropped their tunnel and key. Try removing it again.',
      notQueued
    )
  }
  const purgeIds = await tunnelledComposeNetworkIds(db, organizationId)
  await db.transaction(async (tx) => {
    await deleteComposeNetworkIds(tx, purgeIds)
    await disableOrganizationFabric(tx, organizationId)
  })
  await resendLanOnlyNetworking(params)
  await audit(params, {
    action: 'fabric.remove',
    targetType: 'organization',
    targetId: organizationId,
    context: { servers: relays.length },
  })
  return null
}

type SwitchParams = FabricLifecycleParams & { serverId: string; serverName: string }

function serverInUseResponse(
  c: Context,
  serverName: string,
  dependents: FabricDependent[]
): Response {
  return c.json(
    {
      error: 'fabric_server_in_use',
      message: fabricDependentsMessage(serverName, dependents),
      dependents,
    },
    409
  )
}

/**
 * Take one switched-off server's tunnel down and keep its key when its daemon
 * can (an older daemon drops the key, so the relay forgets it and the next
 * key reaches the peers). Null when queued (or nothing to do).
 */
async function tearDownSwitchedOffServer(
  c: Context,
  params: SwitchParams
): Promise<Response | null> {
  const { db, serverId } = params
  const existing = await getOrganizationFabric(db, params.organizationId)
  if (!existing || isFabricPaused(existing)) return null
  const relays = await listFabricRelays(db, existing.id, { includeSwitchedOff: true })
  if (!relays.some((row) => row.serverId === serverId)) return null
  const keepKey = (await serversThatCannotPause(db, [serverId])).length === 0
  const results = await sendTeardown(params, existing, [serverId], keepKey)
  if (notQueuedServerIds(results).length > 0) {
    return teardownNotQueuedResponse(
      c,
      `TurboFabric is still on for ${params.serverName}: its tunnel could not be taken down. Try again when the server is online.`,
      [serverId]
    )
  }
  if (keepKey) {
    await clearRelayAppliedPayloadHash(db, { serverId, fabricId: existing.id })
  } else {
    await resetRelaysAfterQueuedTeardown(db, { fabricId: existing.id, serverIds: [serverId] })
  }
  return null
}

/**
 * Switch one server out. The relay row stays (address, prefix, endpoint pin,
 * preshared key and LAN sharing are kept for when it comes back), but the
 * server leaves every peer list, ladder and exposure. Refused while something
 * reaches it over the fabric; the check runs again after the switch is
 * written, so a deploy that planned onto the server in between is caught and
 * the switch is undone.
 */
async function switchServerOut(c: Context, params: SwitchParams): Promise<Response | null> {
  const { db, serverId } = params
  const scope = { serverId, organizationId: params.organizationId }
  const before = await findFabricDependents(db, scope)
  if (before.length > 0) return serverInUseResponse(c, params.serverName, before)

  await updateServerFabricMembership(db, { serverId, enabled: false })
  // Stored rows only: see findStoredFabricDependents for why connections are not re-read.
  const after = await findStoredFabricDependents(db, serverId)
  if (after.length > 0) {
    await updateServerFabricMembership(db, { serverId, enabled: true })
    return serverInUseResponse(c, params.serverName, after)
  }
  const refused = await tearDownSwitchedOffServer(c, params)
  if (refused) {
    await updateServerFabricMembership(db, { serverId, enabled: true })
    return refused
  }
  return null
}

/**
 * `PATCH /organizations/:id/fabric/servers/:serverId`: write the switch and
 * role, tear down or join as needed, and re-plan the mesh. Null when done.
 */
export async function applyServerFabricPatch(
  c: Context,
  params: SwitchParams & {
    currentlyEnabled: boolean
    patch: FabricServerPatch
  }
): Promise<Response | null> {
  const { db, serverId, patch } = params
  if (patch.enabled === false && params.currentlyEnabled) {
    const refused = await switchServerOut(c, params)
    if (refused) return refused
  }
  await updateServerFabricMembership(db, {
    serverId,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.role === undefined ? {} : { role: patch.role }),
  })
  await audit(params, {
    action: 'server.fabric.set',
    targetType: 'server',
    targetId: serverId,
    context: {
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
    },
  })
  if (patch.enabled === undefined || patch.enabled === params.currentlyEnabled) return null
  // Re-plan the mesh and reach a switched-off server that still holds a
  // network it shares over a trusted LAN (its payload has no tunnel).
  const results = await reconcileServerNetworking({
    db,
    commandQueue: params.commandQueue,
    actor: { type: 'user', id: params.actorId },
    organizationId: params.organizationId,
    secrets: params.secrets,
  })
  return fabricTypedEnqueueErrorResponse(results)
}
