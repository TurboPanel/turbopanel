/**
 * Deliver cross-server container networking to every server that needs it,
 * whether or not TurboFabric is on.
 *
 * Two servers on a shared trusted LAN run a cross-server container network
 * with no tunnel: each routes the other's container range via its LAN address
 * (`lanRoutes`). With TurboFabric on, members get that inside their normal
 * `server.fabric.reconcile` payload; a server outside the mesh (TurboFabric
 * off or paused, or this server switched off) gets a payload with no tunnel:
 * `{ enabled: true, tunnel: false, prefix, networks, lanRoutes }`, no `tp0`
 * address and no peers. Only daemons that list `fabric-lan-routes-v1` get one;
 * the planner never puts an older daemon on a LAN-only network.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { FabricReconcileCommandPayload } from '../../contracts/commands/schemas.ts'
import { relay, server, subnet } from '../../db/schema.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { mapSequential } from '../../lib/sequential.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { loadServerContainerPrefixes } from './container-prefix.ts'
import {
  enqueueFabricReconcileCommand,
  type FabricEnqueueResult,
  reconcileFabricMembership,
} from './enqueue.ts'
import {
  buildLanRoutes,
  type FabricRecord,
  getOrganizationFabric,
  hashFabricReconcileDesired,
  isFabricPaused,
  listSubnetsForServers,
  type RelayMetadata,
} from './fabric-records.ts'
import { daemonAdvertisesLanRoutes, loadLanPairInputs } from './lan-pairs.ts'

export type ServerNetworkingActor = { type: string; id: string }

export type ServerNetworkingSecrets = {
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
}

type TunnellessTarget = { serverId: string; prefix: string }

/**
 * Org servers holding a piece of a cross-server network whose daemon can take
 * a payload with no tunnel. `switchedOffOnly` keeps those switched out of the
 * mesh (the ones a running fabric does not reach).
 */
async function loadTunnellessTargets(
  db: Db,
  params: {
    organizationId: string
    switchedOffOnly: boolean
    containerPrefixByServer: ReadonlyMap<string, string>
  }
): Promise<TunnellessTarget[]> {
  const rows = await db
    .selectDistinct({
      id: server.id,
      daemon: server.daemon,
      isFabricEnabled: server.isFabricEnabled,
    })
    .from(subnet)
    .innerJoin(server, eq(server.id, subnet.serverId))
    .where(eq(server.organizationId, params.organizationId))
  const out: TunnellessTarget[] = []
  for (const row of rows) {
    if (params.switchedOffOnly && row.isFabricEnabled !== false) continue
    if (!daemonAdvertisesLanRoutes(row.daemon)) continue
    const prefix = params.containerPrefixByServer.get(row.id)
    if (prefix) out.push({ serverId: row.id, prefix })
  }
  return out.sort((a, b) => a.serverId.localeCompare(b.serverId))
}

async function appliedHashFor(
  db: Db,
  fabric: FabricRecord | null,
  serverId: string
): Promise<string | undefined> {
  if (!fabric) return undefined
  const [row] = await db
    .select({ metadata: relay.metadata })
    .from(relay)
    .where(and(eq(relay.fabricId, fabric.id), eq(relay.serverId, serverId)))
    .limit(1)
  return (row?.metadata as RelayMetadata | null | undefined)?.appliedPayloadHash
}

/**
 * The payload with no tunnel for one server: its container range, its pieces
 * of cross-server networks and routes to its trusted LAN partners.
 */
export function tunnellessPayload(params: {
  fabricId?: string
  prefix: string
  networks: ReadonlyArray<{ name: string; subnet: string }>
  lanRoutes: ReadonlyArray<{ cidr: string; via: string }>
}): Extract<FabricReconcileCommandPayload, { enabled: true }> {
  return {
    enabled: true,
    ...(params.fabricId ? { fabricId: params.fabricId } : {}),
    tunnel: false,
    prefix: params.prefix,
    peers: [],
    ...(params.networks.length > 0 ? { networks: [...params.networks] } : {}),
    lanRoutes: [...params.lanRoutes],
  }
}

/**
 * Send the payload with no tunnel to every server a running fabric does not
 * reach. A server whose relay already applied the same payload is skipped;
 * without a fabric row there is nowhere to record what was applied, so the
 * payload is sent each time (the daemon applies it idempotently).
 */
export async function reconcileTunnellessServers(params: {
  db: Db
  commandQueue: CommandQueue
  actor: ServerNetworkingActor
  organizationId: string
  /** The org fabric row (paused or not), or null when there is none. */
  fabric: FabricRecord | null
  switchedOffOnly: boolean
}): Promise<FabricEnqueueResult[]> {
  const { db } = params
  const containerPrefixByServer = await loadServerContainerPrefixes(db, params.organizationId)
  const targets = await loadTunnellessTargets(db, {
    organizationId: params.organizationId,
    switchedOffOnly: params.switchedOffOnly,
    containerPrefixByServer,
  })
  if (targets.length === 0) return []
  const targetIds = targets.map((row) => row.serverId)
  const [inputs, segmentsByServer] = await Promise.all([
    loadLanPairInputs(db, [...targetIds, ...containerPrefixByServer.keys()]),
    listSubnetsForServers(db, targetIds),
  ])
  const expiresAt = new Date(Date.now() + 300_000).toISOString()
  return mapSequential(targets, async (target) => {
    const payload = tunnellessPayload({
      ...(params.fabric ? { fabricId: params.fabric.id } : {}),
      prefix: target.prefix,
      networks: segmentsByServer.get(target.serverId) ?? [],
      lanRoutes: buildLanRoutes(target.serverId, containerPrefixByServer, inputs),
    })
    const desiredHash = await hashFabricReconcileDesired(payload)
    if ((await appliedHashFor(db, params.fabric, target.serverId)) === desiredHash) {
      return { serverId: target.serverId, status: 'converged' as const }
    }
    return enqueueFabricReconcileCommand({
      db,
      commandQueue: params.commandQueue,
      actorType: params.actor.type,
      actorId: params.actor.id,
      serverId: target.serverId,
      payload,
      expiresAt,
      desiredHash,
    })
  })
}

/**
 * Re-converge cross-server networking for the organization: with TurboFabric
 * on, the mesh (payloads carry `lanRoutes` / `tunnel`) plus the servers
 * switched out of it; with it off or paused, every server that holds a piece
 * of a cross-server network gets the payload with no tunnel.
 */
export async function reconcileServerNetworking(params: {
  db: Db
  commandQueue: CommandQueue
  actor: ServerNetworkingActor
  organizationId: string
  secrets: ServerNetworkingSecrets
  registry?: DaemonCellRegistry
  /** The caller already converges the mesh (a deploy's fabric gate): only reach the rest. */
  meshAlreadyConverging?: boolean
}): Promise<FabricEnqueueResult[]> {
  const fabric = await getOrganizationFabric(params.db, params.organizationId)
  const active = fabric !== null && !isFabricPaused(fabric)
  const mesh =
    active && !params.meshAlreadyConverging
      ? await reconcileFabricMembership({
          db: params.db,
          commandQueue: params.commandQueue,
          actorType: params.actor.type,
          actorId: params.actor.id,
          organizationId: params.organizationId,
          ...params.secrets,
          ...(params.registry ? { registry: params.registry } : {}),
        })
      : []
  const outside = await reconcileTunnellessServers({
    db: params.db,
    commandQueue: params.commandQueue,
    actor: params.actor,
    organizationId: params.organizationId,
    fabric,
    switchedOffOnly: active,
  })
  return [...mesh, ...outside]
}
