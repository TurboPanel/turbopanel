/**
 * TurboFabric lifecycle answers for the org fabric routes: pause (turn off and
 * keep keys), remove completely (today's purge), and switching one server in
 * or out of the mesh.
 *
 * Every database write happens inside the request: on Workers the request's
 * client is closed once the response is sent.
 */
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { FABRIC_RETAIN_KEYS_FEATURE } from '../../lib/version-wire.ts'
import { inArray } from 'drizzle-orm'
import { server } from '../../db/schema.ts'
import { parseServerDaemonState } from '../../features/servers/daemon-state.ts'
import { mapSequential } from '../../lib/sequential.ts'
import {
  clearRelayAppliedPayloadHash,
  deleteServerFabricMembership,
  disableOrganizationFabric,
  type FabricRecord,
  getOrganizationFabric,
  isFabricPaused,
  listFabricRelays,
  pauseOrganizationFabric,
  purgeOrganizationComposeNetworks,
  resetRelaysAfterQueuedTeardown,
} from '../../features/fabric/fabric-records.ts'
import {
  enqueueFabricReconcileForServers,
  type FabricEnqueueResult,
  reconcileFabricMembership,
} from '../../features/fabric/enqueue.ts'
import {
  fabricDependentsMessage,
  findFabricDependents,
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

/**
 * Pause: every server takes `tp0` down and keeps its key; the fabric row,
 * relays and container networks stay. Answers null when done (or nothing to
 * do), else the refusal.
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
    const names = await serverNames(db, organizationId, tooOld)
    return c.json(
      {
        error: 'fabric_pause_needs_daemon_update',
        message: `TurboFabric is still on: ${names.join(', ')} ${
          names.length === 1 ? 'runs a TurboPanel daemon' : 'run TurboPanel daemons'
        } too old to turn TurboFabric off and keep the keys. Update ${
          names.length === 1 ? 'that server' : 'those servers'
        }, or remove TurboFabric completely instead.`,
        serverIds: tooOld,
      },
      409
    )
  }

  const results = await sendTeardown(params, existing, serverIds, true)
  const notQueued = notQueuedServerIds(results)
  if (notQueued.length > 0) {
    // The reached servers dropped their tunnel; forget what they applied so
    // the next reconcile brings them back. Their keys are kept.
    await mapSequential(queuedServerIds(results), (serverId) =>
      clearRelayAppliedPayloadHash(db, { serverId, fabricId: existing.id })
    )
    return teardownNotQueuedResponse(
      c,
      'TurboFabric is still on: turning it off could not reach every server. Servers that were reached have dropped their tunnel and get it back on the next apply. Try turning it off again.',
      notQueued
    )
  }
  await pauseOrganizationFabric(db, existing)
  return null
}

/**
 * Remove completely: tear every server down (keys deleted), then purge the
 * cross-server container networks and the fabric row together. The rows go
 * only once every teardown is queued: with the relay rows deleted nothing
 * could ever send a teardown again. A never-enabled org is a no-op.
 */
export async function removeFabric(
  c: Context,
  params: FabricLifecycleParams
): Promise<Response | null> {
  const { db, organizationId } = params
  const existing = await getOrganizationFabric(db, organizationId)
  if (!existing) return null
  const relays = await listFabricRelays(db, existing.id)
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
  await db.transaction(async (tx) => {
    await purgeOrganizationComposeNetworks(tx, organizationId)
    await disableOrganizationFabric(tx, organizationId)
  })
  return null
}

/**
 * Switch one server out: refuse while something reaches it over the fabric,
 * tear its `tp0` down, drop its relay, then re-plan the rest of the mesh so
 * no peer lists it any more.
 */
async function switchServerOut(
  c: Context,
  params: FabricLifecycleParams & { serverId: string; serverName: string }
): Promise<Response | null> {
  const { db, serverId } = params
  const dependents = await findFabricDependents(db, serverId)
  if (dependents.length > 0) {
    return c.json(
      {
        error: 'fabric_server_in_use',
        message: fabricDependentsMessage(params.serverName, dependents),
        dependents,
      },
      409
    )
  }
  const existing = await getOrganizationFabric(db, params.organizationId)
  const relays = existing ? await listFabricRelays(db, existing.id) : []
  if (existing && relays.some((row) => row.serverId === serverId)) {
    const results = await sendTeardown(params, existing, [serverId], false)
    if (notQueuedServerIds(results).length > 0) {
      return teardownNotQueuedResponse(
        c,
        `TurboFabric is still on for ${params.serverName}: its tunnel could not be taken down. Try again when the server is online.`,
        [serverId]
      )
    }
  }
  await db.transaction(async (tx) => {
    await updateServerFabricMembership(tx, { serverId, enabled: false })
    await deleteServerFabricMembership(tx, serverId)
  })
  return null
}

/**
 * `PATCH /organizations/:id/fabric/servers/:serverId`: write the switch and
 * role, tear down or join as needed, and re-plan the mesh. Null when done.
 */
export async function applyServerFabricPatch(
  c: Context,
  params: FabricLifecycleParams & {
    serverId: string
    serverName: string
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
  if (patch.enabled === undefined || patch.enabled === params.currentlyEnabled) return null
  const results = await reconcileFabricMembership({
    db,
    commandQueue: params.commandQueue,
    actorType: 'user',
    actorId: params.actorId,
    organizationId: params.organizationId,
    ...params.secrets,
  })
  return fabricTypedEnqueueErrorResponse(results)
}
