/**
 * Per-server TurboFabric membership: the `server.is_fabric_enabled` switch,
 * the `server.fabric_role` choice (gateway or client, automatic by default)
 * and the checks that guard switching a server out.
 *
 * Phase 1 stores and shows the role only. Path planning, peer lists and
 * forwarding read neither value, so either one is safe for every server.
 */
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  binding,
  datacenter,
  environment,
  ip,
  login,
  managed,
  network,
  project,
  relay,
  replica,
  server,
  service,
  subnet,
} from '../../db/schema.ts'
import { firstSequential, forEachSequential } from '../../lib/sequential.ts'
import { consumerServerIdsForManaged } from '../bindings/resolve-endpoint.ts'
import {
  isPrivateEndpointError,
  resolvePrivateEndpoints,
  serversShareTrustedLan,
} from '../net/private-endpoint.ts'
import { loadLanPairInputs } from './lan-pairs.ts'
import { relayServerSwitchedOn } from './relay-filters.ts'
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
  kind: 'container_network' | 'database_replication' | 'database_connection' | 'lan_gateway'
  id: string
  label: string
}

async function loadNetworkPieces(
  db: Db,
  networkIds: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (networkIds.length === 0) return out
  const rows = await db
    .select({ networkId: subnet.networkId, serverId: subnet.serverId })
    .from(subnet)
    .where(inArray(subnet.networkId, [...networkIds]))
  for (const row of rows) out.set(row.networkId, [...(out.get(row.networkId) ?? []), row.serverId])
  return out
}

/**
 * Cross-server container networks with a piece on this server that reach it
 * through a tunnel. A network whose other servers all share a trusted LAN
 * with this one rides the LAN and does not depend on TurboFabric; one with no
 * other piece yet (a deploy may be adding them) still counts.
 */
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
  if (rows.length === 0) return []
  const pieces = await loadNetworkPieces(
    db,
    rows.map((row) => row.id)
  )
  const others = new Set([...pieces.values()].flat())
  const lanInputs = await loadLanPairInputs(db, [serverId, ...others])
  const tunnelled = rows.filter((row) => {
    const peers = (pieces.get(row.id) ?? []).filter((other) => other !== serverId)
    return (
      peers.length === 0 ||
      peers.some((other) => !serversShareTrustedLan(serverId, other, lanInputs))
    )
  })
  return tunnelled.map((row) => {
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

async function managedNames(db: Db, managedIds: readonly string[]): Promise<Map<string, string>> {
  if (managedIds.length === 0) return new Map()
  const rows = await db
    .select({ id: managed.id, name: managed.name })
    .from(managed)
    .where(inArray(managed.id, [...managedIds]))
  return new Map(rows.map((row) => [row.id, row.name ?? row.id]))
}

/** Clusters an app in the organization connects to, with the servers they run on. */
async function loadBoundClusters(
  db: Db,
  organizationId: string
): Promise<Map<string, Set<string>>> {
  const rows = await db
    .selectDistinct({ managedId: replica.managedId, serverId: replica.serverId })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .innerJoin(replica, eq(replica.managedId, login.managedId))
    .innerJoin(service, eq(service.id, binding.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(eq(project.organizationId, organizationId))
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    const members = out.get(row.managedId) ?? new Set<string>()
    members.add(row.serverId)
    out.set(row.managedId, members)
  }
  return out
}

async function anyFabricPath(
  db: Db,
  fromServerIds: readonly string[],
  toServerIds: readonly string[]
): Promise<boolean> {
  return (
    (await firstSequential(fromServerIds, async (fromServerId) => {
      const targets = toServerIds.filter((id) => id !== fromServerId)
      const resolved = await resolvePrivateEndpoints(db, {
        fromServerId,
        toServerIds: targets,
        purpose: 'client-backend',
      })
      return [...resolved.values()].some(
        (row) => !isPrivateEndpointError(row) && row.transport === 'fabric'
      )
        ? true
        : undefined
    })) === true
  )
}

/**
 * App-to-database connections that resolve to a TurboFabric address on this
 * server: an app here reaching a database elsewhere, or an app elsewhere
 * reaching a database member here.
 */
async function loadDatabaseConnectionDependents(
  db: Db,
  params: { serverId: string; organizationId: string }
): Promise<FabricDependent[]> {
  const clusters = await loadBoundClusters(db, params.organizationId)
  const found: string[] = []
  await forEachSequential([...clusters], async ([managedId, members]) => {
    const consumers = await consumerServerIdsForManaged(db, managedId)
    const hostsMember = members.has(params.serverId)
    const fromHere = consumers.includes(params.serverId)
    if (!hostsMember && !fromHere) return
    const dependent =
      (hostsMember && (await anyFabricPath(db, consumers, [params.serverId]))) ||
      (fromHere && (await anyFabricPath(db, [params.serverId], [...members])))
    if (dependent) found.push(managedId)
  })
  const names = await managedNames(db, found)
  return found.map((id) => ({
    kind: 'database_connection',
    id,
    label: `app connections to managed database "${names.get(id) ?? id}"`,
  }))
}

/**
 * Datacenters where this server is the only switched-on member sharing the
 * LAN ranges (`relay.role = 'gateway'`): other servers reach that LAN only
 * through it.
 */
async function loadLanGatewayDependents(db: Db, serverId: string): Promise<FabricDependent[]> {
  const [own] = await db
    .select({ fabricId: relay.fabricId })
    .from(relay)
    .where(and(eq(relay.serverId, serverId), eq(relay.role, 'gateway')))
    .limit(1)
  if (!own) return []
  const pins = await db
    .selectDistinct({ datacenterId: ip.datacenterId, name: datacenter.name })
    .from(ip)
    .innerJoin(datacenter, eq(datacenter.id, ip.datacenterId))
    .where(and(eq(ip.serverId, serverId), isNotNull(ip.datacenterId)))
  const out: FabricDependent[] = []
  await forEachSequential(pins, async (pin) => {
    if (!pin.datacenterId) return
    const [other] = await db
      .select({ id: relay.id })
      .from(relay)
      .innerJoin(ip, eq(ip.serverId, relay.serverId))
      .where(
        and(
          eq(relay.fabricId, own.fabricId),
          eq(relay.role, 'gateway'),
          ne(relay.serverId, serverId),
          eq(ip.datacenterId, pin.datacenterId),
          relayServerSwitchedOn()
        )
      )
      .limit(1)
    if (other) return
    out.push({
      kind: 'lan_gateway',
      id: pin.datacenterId,
      label: `datacenter "${pin.name ?? pin.datacenterId}"`,
    })
  })
  return out
}

/**
 * What would break if this server left the mesh: a cross-server container
 * network with a piece on it, a managed database whose replication runs over
 * TurboFabric with a member on it, an app-to-database connection that resolves
 * to its TurboFabric address, or a datacenter LAN only it shares.
 */
export async function findFabricDependents(
  db: Db,
  params: { serverId: string; organizationId: string }
): Promise<FabricDependent[]> {
  const stored = await findStoredFabricDependents(db, params.serverId)
  const connections = await loadDatabaseConnectionDependents(db, params)
  return [...stored, ...connections]
}

/**
 * The dependents read from stored rows only (container networks, fabric
 * replication, LAN sharing). This is what the check after the switch is
 * written re-reads: those rows can be created by a deploy or an edit racing
 * the switch. App-to-database connections are left out there on purpose:
 * they are worked out from the address ladder, which already leaves a
 * switched-off server out, so any connection resolved after the switch
 * picks another path instead of depending on the server; the ones that did
 * depend on it were refused by the check before the write.
 */
export async function findStoredFabricDependents(
  db: Db,
  serverId: string
): Promise<FabricDependent[]> {
  const networks = await loadSpanningNetworkDependents(db, serverId)
  const replication = await loadFabricReplicationDependents(db, serverId)
  const gateways = await loadLanGatewayDependents(db, serverId)
  return [...networks, ...replication, ...gateways]
}

function lanGatewaySentence(gateways: readonly FabricDependent[]): string {
  const labels = gateways.map((row) => row.label).join(', ')
  return `This server is the only one sharing the LAN of ${labels} over TurboFabric. Let another server share it first, or stop sharing it.`
}

function reachSentence(serverName: string, others: readonly FabricDependent[]): string {
  const labels = others.map((row) => row.label)
  return `TurboFabric stays on for ${serverName} because ${labels.join(', ')} ${
    labels.length === 1 ? 'reaches' : 'reach'
  } it over TurboFabric. Move or remove ${labels.length === 1 ? 'it' : 'them'} first, then switch TurboFabric off for this server.`
}

/** The plain sentences a refused opt-out answers with. */
export function fabricDependentsMessage(serverName: string, dependents: FabricDependent[]): string {
  const gateways = dependents.filter((row) => row.kind === 'lan_gateway')
  const others = dependents.filter((row) => row.kind !== 'lan_gateway')
  return [
    ...(others.length > 0 ? [reachSentence(serverName, others)] : []),
    ...(gateways.length > 0 ? [lanGatewaySentence(gateways)] : []),
  ].join(' ')
}
