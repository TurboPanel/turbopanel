/**
 * Database side of the server traffic map (`GET /servers/:id/traffic-map`):
 * load what {@link buildServerTrafficMap} reads, then build it. Read-only.
 */

import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { datacenter, server } from '../../db/schema.ts'
import { reportedIpsFromServerMetadata } from '../../contracts/server-addresses.ts'
import { getOrganizationFabric, listFabricRelays } from '../fabric/fabric-records.ts'
import {
  loadDatacenterMembershipsForServers,
  sharedDatacenterIds,
} from './datacenter-membership.ts'
import { loadPrivateEndpointCaches } from './private-endpoint.ts'
import {
  buildServerTrafficMap,
  type ServerTrafficMap,
  type TrafficMapNicMetrics,
  type TrafficMapRelay,
} from './server-traffic-map.ts'
import { computeSlotMapping } from '../../contracts/topology-slot-mapping.ts'
import { EMPTY_TOPOLOGY_OVERRIDES, type TopologySnapshot } from '../../contracts/topology-types.ts'
import { getLatestTopologyGeneration } from '../servers/server-topology-records.ts'
import { loadServerHardwareProfile } from '../servers/hardware-profile.ts'
import { serverMetadataWithoutHardware } from '../servers/server-metadata-select.ts'

/** Peers shown per server; keeps the response and the queries bounded. */
const SERVER_TRAFFIC_MAP_MAX_PEERS = 100

export type ServerTrafficMapCandidate = { serverId: string; name: string | null }

async function loadServerRows(
  db: Db,
  serverIds: string[]
): Promise<Map<string, { name: string | null; metadata: unknown }>> {
  const out = new Map<string, { name: string | null; metadata: unknown }>()
  if (serverIds.length === 0) return out
  const rows = await db
    .select({ id: server.id, name: server.name, metadata: serverMetadataWithoutHardware })
    .from(server)
    .where(inArray(server.id, serverIds))
  for (const row of rows) out.set(row.id, { name: row.name, metadata: row.metadata })
  return out
}

async function loadDatacenterNames(db: Db, datacenterIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (datacenterIds.length === 0) return out
  const rows = await db
    .select({ id: datacenter.id, name: datacenter.name })
    .from(datacenter)
    .where(inArray(datacenter.id, datacenterIds))
  for (const row of rows) if (row.name) out.set(row.id, row.name)
  return out
}

async function loadFabricRelays(db: Db, organizationId: string): Promise<TrafficMapRelay[]> {
  const fabricRecord = await getOrganizationFabric(db, organizationId)
  if (!fabricRecord) return []
  return await listFabricRelays(db, fabricRecord.id)
}

/**
 * Per-NIC pointers into the metrics store: the topology device id of each
 * uplink and whether it is in the monitored NIC set. Best-effort: a server
 * with no recorded topology just has no pointers.
 */
async function loadNicMetrics(
  db: Db,
  serverId: string
): Promise<Map<string, TrafficMapNicMetrics>> {
  const out = new Map<string, TrafficMapNicMetrics>()
  try {
    const latest = await getLatestTopologyGeneration(db, serverId)
    if (!latest) return out
    const snapshot = latest.snapshot as TopologySnapshot
    const { hardwareProfile } = await loadServerHardwareProfile(db, serverId)
    const monitored = new Set(
      computeSlotMapping(snapshot, {
        ...EMPTY_TOPOLOGY_OVERRIDES,
        nicSlotDeviceIds: [...(hardwareProfile?.nicSlotDeviceIds ?? [])],
      }).normalNicSlots
    )
    for (const device of snapshot.networks ?? []) {
      if (device.kind !== 'uplink') continue
      out.set(device.name, {
        deviceId: device.deviceId,
        monitored: monitored.has(device.deviceId),
        speedMbps: device.speedMbps ?? null,
      })
    }
  } catch {
    // Pointers are a convenience; the map is still useful without them.
  }
  return out
}

type ServerTrafficMapResult = ServerTrafficMap & {
  /** More peers share a network with this server than the cap shows. */
  truncated: boolean
}

/**
 * The candidates that share a datacenter or the fabric with this server,
 * ordered by name then id so the cut is the same on every call.
 */
async function selectPeers(
  db: Db,
  params: Readonly<{
    serverId: string
    candidates: readonly ServerTrafficMapCandidate[]
  }>,
  fabricRelays: readonly TrafficMapRelay[]
): Promise<ServerTrafficMapCandidate[]> {
  const others = params.candidates.filter((candidate) => candidate.serverId !== params.serverId)
  const pinsByServer = await loadDatacenterMembershipsForServers(db, [
    params.serverId,
    ...others.map((candidate) => candidate.serverId),
  ])
  const selfPins = pinsByServer.get(params.serverId) ?? []
  const fabricServerIds = new Set(fabricRelays.map((row) => row.serverId))
  return others
    .filter((candidate) => {
      const sharesDatacenter =
        sharedDatacenterIds(selfPins, pinsByServer.get(candidate.serverId) ?? []).length > 0
      const sharesFabric =
        fabricServerIds.has(params.serverId) && fabricServerIds.has(candidate.serverId)
      return sharesDatacenter || sharesFabric
    })
    .sort(
      (a, b) =>
        (a.name ?? a.serverId).localeCompare(b.name ?? b.serverId) ||
        a.serverId.localeCompare(b.serverId)
    )
}

/**
 * Traffic map of `serverId` toward the `candidates` it may talk to (the
 * caller has already filtered them to the servers the viewer may see). A
 * candidate that shares neither a datacenter nor the fabric with this server
 * is left out: there is no private path to describe. At most
 * {@link SERVER_TRAFFIC_MAP_MAX_PEERS} peers are returned, cut after that
 * filter in name order, and `truncated` says when it happened.
 */
export async function loadServerTrafficMap(
  db: Db,
  params: Readonly<{
    serverId: string
    organizationId: string
    candidates: readonly ServerTrafficMapCandidate[]
  }>
): Promise<ServerTrafficMapResult> {
  const fabricRelays = await loadFabricRelays(db, params.organizationId)
  const sharing = await selectPeers(db, params, fabricRelays)
  const peers = sharing.slice(0, SERVER_TRAFFIC_MAP_MAX_PEERS)
  const caches = await loadPrivateEndpointCaches(db, [
    params.serverId,
    ...peers.map((peer) => peer.serverId),
  ])

  const datacenterIds = new Set<string>()
  for (const pins of caches.membershipsByServer.values()) {
    for (const pin of pins) datacenterIds.add(pin.datacenterId)
  }
  const [rows, datacenterNames, nicMetrics] = await Promise.all([
    loadServerRows(db, [params.serverId, ...peers.map((peer) => peer.serverId)]),
    loadDatacenterNames(db, [...datacenterIds]),
    loadNicMetrics(db, params.serverId),
  ])
  const reportedIpsByServer = new Map(
    [...rows.entries()].map(([id, row]) => [id, reportedIpsFromServerMetadata(row.metadata) ?? []])
  )

  const map = buildServerTrafficMap({
    serverId: params.serverId,
    peers,
    caches,
    datacenterNames,
    reportedIpsByServer,
    fabricRelays,
    nicMetrics,
  })
  return { ...map, truncated: sharing.length > peers.length }
}
