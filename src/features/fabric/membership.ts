/**
 * Per-server TurboFabric membership: the `server.is_fabric_enabled` switch,
 * the `server.fabric_role` choice (gateway or client, automatic by default)
 * and the checks that guard switching a server out.
 *
 * Phase 1 stores and shows the role only. Path planning, peer lists and
 * forwarding read neither value, so either one is safe for every server.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, managed, network, replica, server, subnet } from '../../db/schema.ts'
import {
  loadEndpointCaches,
  type RelayRecord,
  resolveRelayGlobalEndpointAddress,
} from './fabric-records.ts'
import { type FabricServerRole, isFabricServerRole } from './membership-vocabulary.ts'

export type FabricRoleSource = 'automatic' | 'operator'

export type FabricServerMembership = {
  serverId: string
  name: string
  /** The server's switch: false keeps it out of the mesh. */
  enabled: boolean
  /** Holds a relay (a `tp0` address) in the org's fabric right now. */
  member: boolean
  role: FabricServerRole
  roleSource: FabricRoleSource
  /** What `automatic` resolves to today, shown next to an operator choice. */
  automaticRole: FabricServerRole
}

type MembershipServerRow = {
  id: string
  name: string | null
  hostname: string | null
  isFabricEnabled: boolean
  fabricRole: string | null
}

/**
 * Automatic role: a server with a public address (operator pin, public `ip`
 * row or a reported public IPv4 — the same rule the path planner uses for a
 * `direct_public` endpoint) is a gateway; anything else is a client.
 */
export function automaticFabricRole(publicEndpoint: string | null): FabricServerRole {
  return publicEndpoint ? 'gateway' : 'client'
}

export function resolveFabricRole(
  stored: string | null,
  automatic: FabricServerRole
): { role: FabricServerRole; roleSource: FabricRoleSource } {
  if (isFabricServerRole(stored)) return { role: stored, roleSource: 'operator' }
  return { role: automatic, roleSource: 'automatic' }
}

function displayName(row: Pick<MembershipServerRow, 'id' | 'name' | 'hostname'>): string {
  return row.name ?? row.hostname ?? row.id
}

async function loadMembershipServerRows(
  db: Db,
  organizationId: string,
  serverId?: string
): Promise<MembershipServerRow[]> {
  const scope = eq(server.organizationId, organizationId)
  return await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      isFabricEnabled: server.isFabricEnabled,
      fabricRole: server.fabricRole,
    })
    .from(server)
    .where(serverId ? and(scope, eq(server.id, serverId)) : scope)
    .orderBy(asc(server.createdAt), asc(server.id))
}

/** Every org server's membership, for the org fabric page and the server page. */
export async function loadFabricServerMemberships(
  db: Db,
  params: { organizationId: string; relays: readonly RelayRecord[]; serverId?: string }
): Promise<FabricServerMembership[]> {
  const rows = await loadMembershipServerRows(db, params.organizationId, params.serverId)
  if (rows.length === 0) return []
  const relayByServer = new Map(params.relays.map((row) => [row.serverId, row]))
  const { caches } = await loadEndpointCaches(
    db,
    rows.map((row) => row.id)
  )
  return rows.map((row) => {
    const relayRow = relayByServer.get(row.id)
    const automaticRole = automaticFabricRole(
      resolveRelayGlobalEndpointAddress(
        { serverId: row.id, endpointAddress: relayRow?.endpointAddress ?? null },
        caches
      )
    )
    return {
      serverId: row.id,
      name: displayName(row),
      enabled: row.isFabricEnabled,
      member: relayRow !== undefined,
      automaticRole,
      ...resolveFabricRole(row.fabricRole, automaticRole),
    }
  })
}

/** Write the server's switch and/or role choice (`null` role = automatic). */
export async function updateServerFabricMembership(
  db: Db,
  params: { serverId: string; enabled?: boolean; role?: FabricServerRole | null }
): Promise<void> {
  const set: { isFabricEnabled?: boolean; fabricRole?: string | null } = {}
  if (params.enabled !== undefined) set.isFabricEnabled = params.enabled
  if (params.role !== undefined) set.fabricRole = params.role
  if (Object.keys(set).length === 0) return
  await db.update(server).set(set).where(eq(server.id, params.serverId))
}

/** Something that reaches a server over TurboFabric, in words an operator knows. */
export type FabricDependent = {
  kind: 'container_network' | 'database_replication'
  id: string
  label: string
}

async function loadSpanningNetworkDependents(db: Db, serverId: string): Promise<FabricDependent[]> {
  const rows = await db
    .select({
      id: network.id,
      name: network.name,
      composeKey: network.composeKey,
      environmentName: environment.name,
    })
    .from(subnet)
    .innerJoin(network, eq(network.id, subnet.networkId))
    .leftJoin(environment, eq(environment.id, network.environmentId))
    .where(eq(subnet.serverId, serverId))
  return rows.map((row) => {
    const name = row.composeKey ?? row.name ?? row.id
    return {
      kind: 'container_network',
      id: row.id,
      label: row.environmentName
        ? `container network "${name}" in environment "${row.environmentName}"`
        : `container network "${name}"`,
    }
  })
}

async function loadFabricReplicationDependents(
  db: Db,
  serverId: string
): Promise<FabricDependent[]> {
  const clusters = await db
    .selectDistinct({ managedId: replica.managedId })
    .from(replica)
    .where(eq(replica.serverId, serverId))
  if (clusters.length === 0) return []
  const rows = await db
    .selectDistinct({ id: managed.id, name: managed.name })
    .from(replica)
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .where(
      and(
        inArray(
          replica.managedId,
          clusters.map((row) => row.managedId)
        ),
        eq(replica.replicationTransport, 'fabric')
      )
    )
  return rows.map((row) => ({
    kind: 'database_replication',
    id: row.id,
    label: `replication of managed database "${row.name ?? row.id}"`,
  }))
}

/**
 * What would break if this server left the mesh: a cross-server container
 * network with a piece on it, or a managed database whose replication runs
 * over TurboFabric with a member on it.
 */
export async function findFabricDependents(db: Db, serverId: string): Promise<FabricDependent[]> {
  const [networks, replication] = await Promise.all([
    loadSpanningNetworkDependents(db, serverId),
    loadFabricReplicationDependents(db, serverId),
  ])
  return [...networks, ...replication]
}

/** The plain sentence a refused opt-out answers with. */
export function fabricDependentsMessage(serverName: string, dependents: FabricDependent[]): string {
  const labels = dependents.map((row) => row.label)
  return `TurboFabric stays on for ${serverName} because ${labels.join(', ')} ${
    labels.length === 1 ? 'reaches' : 'reach'
  } it over TurboFabric. Move or remove ${labels.length === 1 ? 'it' : 'them'} first, then switch TurboFabric off for this server.`
}
