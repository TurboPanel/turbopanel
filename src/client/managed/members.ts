/**
 * Managed cluster membership helpers — primary + replica fan-out set.
 * Postgres-only; never cell/DO reads.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  resolvePrivateEndpoints,
  type PrivateEndpointError,
  type PrivateEndpointTransport,
  type ResolvedPrivateEndpoint,
} from '../../lib/net/private-endpoint.ts'
import { container, node, server } from '../../lib/db/schema.ts'
import type { ManagedReplicationHealth } from '../../lib/commands/schemas.ts'

/** Max replica members per cluster (ordinals 2 and 3). Primary is unlimited-slot. */
export const MANAGED_MAX_REPLICAS = 2

/**
 * High contiguous host-port range for multi-member private listeners
 * (replication + remote ProxySQL backends).
 */
export const MANAGED_PRIVATE_PORT_MIN = 45_000
export const MANAGED_PRIVATE_PORT_MAX = 45_999

export type ManagedMemberRole = 'primary' | 'replica'

export type ManagedMemberRow = {
  id: string
  managedId: string
  serverId: string
  role: string
  readEligible: boolean
  ordinal: number
  replicationTransport: string | null
  privatePort: number | null
  status: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export type SerializedManagedMember = {
  id: string
  serverId: string
  serverDisplayName: string | null
  role: ManagedMemberRole
  readEligible: boolean
  ordinal: number
  status: string | null
  replicationTransport: PrivateEndpointTransport | null
  privatePort: number | null
  replication?: ManagedReplicationHealth
}

export type ManagedPrivatePortExhaustedError = {
  kind: 'managed_private_port_exhausted'
  serverId: string
}

export type ManagedMemberPeer = {
  memberId: string
  role: ManagedMemberRole
  readEligible: boolean
  address: string
  transport: PrivateEndpointTransport
  port: number
  containerName?: string
}

const MEMBER_RETURNING = {
  id: node.id,
  managedId: node.managedId,
  serverId: node.serverId,
  role: node.role,
  readEligible: node.isReadEligible,
  ordinal: node.ordinal,
  replicationTransport: node.replicationTransport,
  privatePort: node.privatePort,
  status: node.status,
  metadata: node.metadata,
  options: node.options,
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReplicationHealth(metadata: unknown): ManagedReplicationHealth | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.replication)) return undefined
  const r = metadata.replication
  if (
    typeof r.state !== 'string' ||
    typeof r.observedAt !== 'string'
  ) {
    return undefined
  }
  const health: ManagedReplicationHealth = {
    state: r.state,
    observedAt: r.observedAt,
  }
  if (typeof r.lagBytes === 'number' && Number.isFinite(r.lagBytes)) {
    health.lagBytes = r.lagBytes
  }
  if (typeof r.lagSeconds === 'number' && Number.isFinite(r.lagSeconds)) {
    health.lagSeconds = r.lagSeconds
  }
  return health
}

/**
 * Idempotent upsert of the `role='primary'`, `ordinal=1` member for a cluster.
 * Call from create **and** every apply so pre-existing `managed` rows self-heal
 * without a data migration.
 */
export async function ensureManagedPrimaryMember(
  db: Db,
  params: { managedId: string; serverId: string },
): Promise<ManagedMemberRow> {
  const { managedId, serverId } = params

  const existing = await listManagedMembers(db, managedId)
  const primary = existing.find((row) => row.role === 'primary')
  if (primary) {
    if (primary.serverId !== serverId) {
      const [updated] = await db
        .update(node)
        .set({
          serverId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(node.id, primary.id))
        .returning(MEMBER_RETURNING)
      return updated ?? primary
    }
    return primary
  }

  const [inserted] = await db
    .insert(node)
    .values({
      managedId,
      serverId,
      role: 'primary',
      isReadEligible: true,
      ordinal: 1,
      status: 'provisioning',
    })
    .onConflictDoNothing({
      target: [node.managedId, node.ordinal],
    })
    .returning(MEMBER_RETURNING)

  if (inserted) return inserted

  // Race: another txn inserted the primary — re-read.
  const again = await listManagedMembers(db, managedId)
  const raced = again.find((row) => row.role === 'primary' || row.ordinal === 1)
  if (!raced) {
    throw new Error(
      `managed primary member missing after upsert (managedId=${managedId})`,
    )
  }
  return raced
}

export async function listManagedMembers(
  db: Db,
  managedId: string,
): Promise<ManagedMemberRow[]> {
  return await db
    .select(MEMBER_RETURNING)
    .from(node)
    .where(eq(node.managedId, managedId))
    .orderBy(asc(node.ordinal))
}

/** List members for many managed ids in one query (org list path). */
export async function listManagedMembersForManagedIds(
  db: Db,
  managedIds: readonly string[],
): Promise<ManagedMemberRow[]> {
  if (managedIds.length === 0) return []
  return await db
    .select(MEMBER_RETURNING)
    .from(node)
    .where(inArray(node.managedId, [...managedIds]))
    .orderBy(asc(node.ordinal))
}

/** Smallest free ordinal in 2..3, or null when the replica set is full. */
export function nextReplicaOrdinal(members: readonly ManagedMemberRow[]): number | null {
  const used = new Set(members.map((m) => m.ordinal))
  for (let ordinal = 2; ordinal <= MANAGED_MAX_REPLICAS + 1; ordinal++) {
    if (!used.has(ordinal)) return ordinal
  }
  return null
}

export function serializeManagedMember(
  row: ManagedMemberRow,
  serverDisplayName: string | null,
): SerializedManagedMember {
  const role: ManagedMemberRole = row.role === 'replica' ? 'replica' : 'primary'
  const transport =
    row.replicationTransport === 'local' ||
      row.replicationTransport === 'datacenter' ||
      row.replicationTransport === 'fabric'
      ? row.replicationTransport
      : null
  const out: SerializedManagedMember = {
    id: row.id,
    serverId: row.serverId,
    serverDisplayName,
    role,
    readEligible: row.readEligible,
    ordinal: row.ordinal,
    status: row.status,
    replicationTransport: transport,
    privatePort: row.privatePort,
  }
  const replication = parseReplicationHealth(row.metadata)
  if (replication !== undefined) out.replication = replication
  return out
}

/**
 * List members with server display names in a single join (no N+1).
 */
export async function listSerializedManagedMembers(
  db: Db,
  managedId: string,
): Promise<SerializedManagedMember[]> {
  const rows = await db
    .select({
      ...MEMBER_RETURNING,
      serverDisplayName: server.name,
    })
    .from(node)
    .leftJoin(server, eq(node.serverId, server.id))
    .where(eq(node.managedId, managedId))
    .orderBy(asc(node.ordinal))

  return rows.map((row) =>
    serializeManagedMember(row, row.serverDisplayName ?? null)
  )
}

/**
 * Batched private-endpoint resolution from the primary toward every replica.
 * Returns transport per member id, or a typed error.
 */
export async function resolveMemberTransports(
  db: Db,
  members: readonly ManagedMemberRow[],
): Promise<
  | Map<string, PrivateEndpointTransport>
  | PrivateEndpointError
> {
  const primary = members.find((m) => m.role === 'primary')
  if (!primary) {
    return new Map()
  }

  const transports = new Map<string, PrivateEndpointTransport>()
  transports.set(primary.id, 'local')

  const replicas = members.filter((m) => m.id !== primary.id)
  if (replicas.length === 0) return transports

  const endpoints = await resolvePrivateEndpoints(db, {
    fromServerId: primary.serverId,
    toServerIds: replicas.map((replica) => replica.serverId),
  })
  for (const replica of replicas) {
    const resolved = endpoints.get(replica.serverId)
    if (!resolved) {
      return {
        kind: 'private_path_unavailable',
        fromServerId: primary.serverId,
        toServerId: replica.serverId,
      }
    }
    if ('kind' in resolved) return resolved
    transports.set(replica.id, resolved.transport)
  }
  return transports
}

type OccupiedPrivatePortRow = {
  serverId: string
  privatePort: number | null
  id: string
}

/**
 * Ports already held per server: pre-seeded from `current` members (so every
 * server in the cluster has an entry), then filled from cross-cluster
 * `occupied` rows (skipping this cluster's own members — those are
 * re-claimable in place) and finally from `current` members' own ports.
 */
function buildUsedPrivatePortsByServer(
  current: readonly ManagedMemberRow[],
  occupied: readonly OccupiedPrivatePortRow[],
): Map<string, Set<number>> {
  const usedByServer = new Map<string, Set<number>>()
  for (const member of current) {
    usedByServer.set(member.serverId, new Set())
  }

  for (const row of occupied) {
    if (row.privatePort === null) continue
    const heldByThisCluster = current.some((m) => m.id === row.id)
    if (heldByThisCluster) continue
    usedByServer.get(row.serverId)?.add(row.privatePort)
  }

  for (const member of current) {
    if (member.privatePort !== null) {
      usedByServer.get(member.serverId)?.add(member.privatePort)
    }
  }
  return usedByServer
}

/** Smallest free port in the managed private-port range, or null when full. */
function findFreePrivatePort(used: ReadonlySet<number>): number | null {
  for (let port = MANAGED_PRIVATE_PORT_MIN; port <= MANAGED_PRIVATE_PORT_MAX; port++) {
    if (!used.has(port)) return port
  }
  return null
}

/**
 * Allocate or clear private listener ports for a multi-member cluster.
 * Single-member clusters clear any leftover `private_port`.
 * Under a `fabric` transport the port is published on the relay `tp0` address.
 */
export async function ensureMemberPrivatePorts(
  db: Db,
  members: readonly ManagedMemberRow[],
): Promise<ManagedMemberRow[] | ManagedPrivatePortExhaustedError> {
  if (members.length === 0) return []

  if (members.length <= 1) {
    for (const member of members) {
      if (member.privatePort !== null) {
        await db
          .update(node)
          .set({ privatePort: null, updatedAt: new Date().toISOString() })
          .where(eq(node.id, member.id))
      }
    }
    return listManagedMembers(db, members[0]!.managedId)
  }

  const managedId = members[0]!.managedId
  return await db.transaction(async (tx) => {
    const current = await tx
      .select(MEMBER_RETURNING)
      .from(node)
      .where(eq(node.managedId, managedId))
      .orderBy(asc(node.ordinal))

    const serverIds = [...new Set(current.map((m) => m.serverId))]
    const occupied = await tx
      .select({
        serverId: node.serverId,
        privatePort: node.privatePort,
        id: node.id,
      })
      .from(node)
      .where(
        and(
          inArray(node.serverId, serverIds),
          isNotNull(node.privatePort),
        ),
      )

    const usedByServer = buildUsedPrivatePortsByServer(current, occupied)

    for (const member of current) {
      if (member.privatePort !== null) continue
      const used = usedByServer.get(member.serverId) ?? new Set()
      const assigned = findFreePrivatePort(used)
      if (assigned === null) {
        return { kind: 'managed_private_port_exhausted', serverId: member.serverId }
      }
      used.add(assigned)
      await tx
        .update(node)
        .set({
          privatePort: assigned,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(node.id, member.id))
    }

    return await tx
      .select(MEMBER_RETURNING)
      .from(node)
      .where(eq(node.managedId, managedId))
      .orderBy(asc(node.ordinal))
  })
}

async function loadMemberContainerNames(
  db: Db,
  members: readonly ManagedMemberRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (members.length === 0) return out

  const serverIds = [...new Set(members.map((m) => m.serverId))]
  const rows = await db
    .select({
      serverId: container.serverId,
      containerName: container.containerName,
      role: container.role,
      ordinal: container.ordinal,
    })
    .from(container)
    .where(
      and(
        inArray(container.serverId, serverIds),
        eq(container.role, 'service'),
      ),
    )

  for (const member of members) {
    const match = rows.find(
      (r) =>
        r.serverId === member.serverId &&
        r.ordinal === member.ordinal &&
        typeof r.containerName === 'string' &&
        r.containerName.length > 0,
    )
    if (match?.containerName) {
      out.set(member.id, match.containerName)
    }
  }
  return out
}

function unavailablePeerError(
  fromMember: ManagedMemberRow,
  other: ManagedMemberRow,
): PrivateEndpointError {
  return {
    kind: 'private_path_unavailable',
    fromServerId: fromMember.serverId,
    toServerId: other.serverId,
  }
}

function resolveCoResidentPeer(
  fromMember: ManagedMemberRow,
  other: ManagedMemberRow,
  containerNames: ReadonlyMap<string, string>,
  defaultPort: number,
): ManagedMemberPeer | PrivateEndpointError {
  const containerName = containerNames.get(other.id)
  if (!containerName) return unavailablePeerError(fromMember, other)
  return {
    memberId: other.id,
    role: other.role === 'replica' ? 'replica' : 'primary',
    readEligible: other.readEligible,
    address: containerName,
    transport: 'local',
    port: defaultPort,
    containerName,
  }
}

function resolveRemotePeer(
  fromMember: ManagedMemberRow,
  other: ManagedMemberRow,
  endpoints: ReadonlyMap<string, ResolvedPrivateEndpoint | PrivateEndpointError>,
): ManagedMemberPeer | PrivateEndpointError {
  // Address is the peer's `tp0` relay address when transport is `fabric`,
  // matching the address the peer actually publishes.
  const resolved = endpoints.get(other.serverId)
  if (!resolved) return unavailablePeerError(fromMember, other)
  if ('kind' in resolved) return resolved
  if (other.privatePort === null) return unavailablePeerError(fromMember, other)
  return {
    memberId: other.id,
    role: other.role === 'replica' ? 'replica' : 'primary',
    readEligible: other.readEligible,
    address: resolved.address,
    transport: resolved.transport,
    port: other.privatePort,
  }
}

/**
 * Resolve peer endpoints for one member (reachability of every other member
 * from this member's server). Used when building apply payloads.
 *
 * Co-resident peers are dialled by Docker container name on `turbopanel-managed`
 * (never host loopback). Remote peers use the private address + allocated
 * `private_port` private listener.
 */
export async function resolvePeersForMember(
  db: Db,
  members: readonly ManagedMemberRow[],
  fromMember: ManagedMemberRow,
  defaultPort: number,
): Promise<ManagedMemberPeer[] | PrivateEndpointError> {
  const others = members.filter((m) => m.id !== fromMember.id)
  if (others.length === 0) return []

  const containerNames = await loadMemberContainerNames(db, members)
  const endpoints = await resolvePrivateEndpoints(db, {
    fromServerId: fromMember.serverId,
    toServerIds: others.map((m) => m.serverId),
  })

  const peers: ManagedMemberPeer[] = []
  for (const other of others) {
    const peer = other.serverId === fromMember.serverId
      ? resolveCoResidentPeer(fromMember, other, containerNames, defaultPort)
      : resolveRemotePeer(fromMember, other, endpoints)
    if ('kind' in peer) return peer
    peers.push(peer)
  }
  return peers
}

export async function insertManagedReplicaMember(
  db: Db,
  params: {
    managedId: string
    serverId: string
    ordinal: number
    readEligible: boolean
    replicationTransport: PrivateEndpointTransport | null
  },
): Promise<ManagedMemberRow> {
  const [inserted] = await db
    .insert(node)
    .values({
      managedId: params.managedId,
      serverId: params.serverId,
      role: 'replica',
      isReadEligible: params.readEligible,
      ordinal: params.ordinal,
      replicationTransport: params.replicationTransport,
      status: 'provisioning',
    })
    .returning(MEMBER_RETURNING)
  if (!inserted) {
    throw new Error('Failed to insert managed replica member')
  }
  return inserted
}

export async function updateManagedMemberReadEligible(
  db: Db,
  memberId: string,
  readEligible: boolean,
): Promise<ManagedMemberRow | null> {
  const [updated] = await db
    .update(node)
    .set({
      isReadEligible: readEligible,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(node.id, memberId))
    .returning(MEMBER_RETURNING)
  return updated ?? null
}

export async function deleteManagedMember(
  db: Db,
  memberId: string,
): Promise<void> {
  await db.delete(node).where(eq(node.id, memberId))
}

export async function findManagedMember(
  db: Db,
  memberId: string,
): Promise<ManagedMemberRow | null> {
  const [row] = await db
    .select(MEMBER_RETURNING)
    .from(node)
    .where(eq(node.id, memberId))
    .limit(1)
  return row ?? null
}

/** Count replica members for a cluster (excludes primary). */
export function countReplicas(members: readonly ManagedMemberRow[]): number {
  return members.filter((m) => m.role === 'replica').length
}

/** Mark all members applying (best-effort status stamp before fan-out). */
export async function markMembersApplying(
  db: Db,
  managedId: string,
): Promise<void> {
  await db
    .update(node)
    .set({
      status: 'applying',
      updatedAt: sql`now()`,
    })
    .where(eq(node.managedId, managedId))
}

export async function updateMemberReplicationTransport(
  db: Db,
  memberId: string,
  transport: PrivateEndpointTransport | null,
): Promise<void> {
  await db
    .update(node)
    .set({
      replicationTransport: transport,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(node.id, memberId))
}

/**
 * Project daemon-observed per-member status + replication health onto
 * `node` (never reverse-inferred from the command action).
 */
export async function updateManagedMemberObservedReplication(
  db: Db,
  memberId: string,
  observed: {
    status: string
    replication?: ManagedReplicationHealth
  },
): Promise<void> {
  const [existing] = await db
    .select({ metadata: node.metadata })
    .from(node)
    .where(eq(node.id, memberId))
    .limit(1)
  if (!existing) return

  const prev = isRecord(existing.metadata) ? { ...existing.metadata } : {}
  if (observed.replication !== undefined) {
    prev.replication = observed.replication
  }

  await db
    .update(node)
    .set({
      status: observed.status,
      metadata: prev,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(node.id, memberId))
}

export function isManagedPrivatePortExhaustedError(
  value: unknown,
): value is ManagedPrivatePortExhaustedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: string }).kind === 'managed_private_port_exhausted'
  )
}
