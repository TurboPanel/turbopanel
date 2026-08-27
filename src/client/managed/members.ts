/**
 * Managed cluster membership helpers — primary + replica fan-out set.
 * Postgres-only; never cell/DO reads.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  type PrivateEndpointError,
  type PrivateEndpointPurpose,
  type PrivateEndpointTransport,
  type ResolvedPrivateEndpoint,
  resolvePrivateEndpoints,
} from '../../lib/net/private-endpoint.ts'
import { container, replica, server } from '../../lib/db/schema.ts'
import type { ManagedReplicationHealth } from '../../lib/commands/schemas.ts'
import {
  MANAGED_PRIVATE_PORT_MAX,
  MANAGED_PRIVATE_PORT_MIN,
} from '../../lib/managed/ingress-ports.ts'

/**
 * High contiguous host-port range for multi-member private listeners
 * (replication + remote ProxySQL backends). Owned by `ingress-ports.ts` so the
 * client-listener validator can reserve the same range.
 */
export { MANAGED_PRIVATE_PORT_MAX, MANAGED_PRIVATE_PORT_MIN }

export type ManagedMemberRole = 'primary' | 'replica'
export type ManagedReplicaClass = 'failover' | 'read'

export type ManagedMemberRow = {
  id: string
  managedId: string
  serverId: string
  role: string
  replicaClass: string | null
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
  replicaClass: ManagedReplicaClass | null
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
  id: replica.id,
  managedId: replica.managedId,
  serverId: replica.serverId,
  role: replica.role,
  replicaClass: replica.replicaClass,
  readEligible: replica.isReadEligible,
  ordinal: replica.ordinal,
  replicationTransport: replica.replicationTransport,
  privatePort: replica.privatePort,
  status: replica.status,
  metadata: replica.metadata,
  options: replica.options,
  createdAt: replica.createdAt,
  updatedAt: replica.updatedAt,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReplicationHealth(
  metadata: unknown,
): ManagedReplicationHealth | undefined {
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
        .update(replica)
        .set({
          serverId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(replica.id, primary.id))
        .returning(MEMBER_RETURNING)
      return updated ?? primary
    }
    return primary
  }

  const [inserted] = await db
    .insert(replica)
    .values({
      managedId,
      serverId,
      role: 'primary',
      isReadEligible: true,
      ordinal: 1,
      status: 'provisioning',
    })
    .onConflictDoNothing({
      target: [replica.managedId, replica.ordinal],
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
    .from(replica)
    .where(eq(replica.managedId, managedId))
    .orderBy(asc(replica.ordinal))
}

/** List members for many managed ids in one query (org list path). */
export async function listManagedMembersForManagedIds(
  db: Db,
  managedIds: readonly string[],
): Promise<ManagedMemberRow[]> {
  if (managedIds.length === 0) return []
  return await db
    .select(MEMBER_RETURNING)
    .from(replica)
    .where(inArray(replica.managedId, [...managedIds]))
    .orderBy(asc(replica.ordinal))
}

/** Smallest unused ordinal ≥ 2 (no replica-count ceiling). */
export function nextReplicaOrdinal(
  members: readonly ManagedMemberRow[],
): number {
  const used = new Set(members.map((m) => m.ordinal))
  let ordinal = 2
  while (used.has(ordinal)) {
    ordinal++
  }
  return ordinal
}

export function serializeManagedMember(
  row: ManagedMemberRow,
  serverDisplayName: string | null,
): SerializedManagedMember {
  const role: ManagedMemberRole = row.role === 'replica' ? 'replica' : 'primary'
  const replicaClass = role === 'replica' &&
      (row.replicaClass === 'failover' || row.replicaClass === 'read')
    ? row.replicaClass
    : null
  const transport = row.replicationTransport === 'local' ||
      row.replicationTransport === 'datacenter' ||
      row.replicationTransport === 'fabric' ||
      row.replicationTransport === 'public'
    ? row.replicationTransport
    : null
  const out: SerializedManagedMember = {
    id: row.id,
    serverId: row.serverId,
    serverDisplayName,
    role,
    replicaClass,
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
    .from(replica)
    .leftJoin(server, eq(replica.serverId, server.id))
    .where(eq(replica.managedId, managedId))
    .orderBy(asc(replica.ordinal))

  return rows.map((row) => serializeManagedMember(row, row.serverDisplayName ?? null))
}

/** A read replica is the only member allowed on the fabric/public ladder. */
function isReadMember(
  row: Readonly<Pick<ManagedMemberRow, 'role' | 'replicaClass'>>,
): boolean {
  return row.role === 'replica' && row.replicaClass === 'read'
}

/**
 * Replication ladder for the link between two cluster members.
 *
 * Failover-critical links (primary ↔ failover replica, and failover ↔ failover
 * so a promote keeps every remaining failover peer reachable) stay on the
 * strict `local → datacenter` ladder; any link touching a `read` replica may
 * ride the longer `datacenter → fabric → public` ladder. A legacy `null`
 * `replica_class` counts as failover — same precedence as the promote transport
 * recompute in `ingress-desired.ts`, and the fail-safe direction, since a typed
 * `private_path_unavailable` beats silently shipping a replication path a
 * promote cannot honor.
 */
export function replicationPurposeForMemberPair(
  a: Readonly<Pick<ManagedMemberRow, 'role' | 'replicaClass'>>,
  b: Readonly<Pick<ManagedMemberRow, 'role' | 'replicaClass'>>,
): PrivateEndpointPurpose {
  return isReadMember(a) || isReadMember(b) ? 'read-replication' : 'failover-replication'
}

/**
 * Batched private-endpoint resolution from the primary toward every replica.
 * Returns transport per member id, or a typed error.
 */
export async function resolveMemberTransports(
  db: Db,
  members: readonly ManagedMemberRow[],
  purpose: PrivateEndpointPurpose,
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
    purpose,
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
  for (
    let port = MANAGED_PRIVATE_PORT_MIN;
    port <= MANAGED_PRIVATE_PORT_MAX;
    port++
  ) {
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
          .update(replica)
          .set({ privatePort: null, updatedAt: new Date().toISOString() })
          .where(eq(replica.id, member.id))
      }
    }
    return listManagedMembers(db, members[0]!.managedId)
  }

  const managedId = members[0]!.managedId
  return await db.transaction(async (tx) => {
    const current = await tx
      .select(MEMBER_RETURNING)
      .from(replica)
      .where(eq(replica.managedId, managedId))
      .orderBy(asc(replica.ordinal))

    const serverIds = [...new Set(current.map((m) => m.serverId))]
    const occupied = await tx
      .select({
        serverId: replica.serverId,
        privatePort: replica.privatePort,
        id: replica.id,
      })
      .from(replica)
      .where(
        and(
          inArray(replica.serverId, serverIds),
          isNotNull(replica.privatePort),
        ),
      )

    const usedByServer = buildUsedPrivatePortsByServer(current, occupied)

    for (const member of current) {
      if (member.privatePort !== null) continue
      const used = usedByServer.get(member.serverId) ?? new Set()
      const assigned = findFreePrivatePort(used)
      if (assigned === null) {
        return {
          kind: 'managed_private_port_exhausted',
          serverId: member.serverId,
        }
      }
      used.add(assigned)
      await tx
        .update(replica)
        .set({
          privatePort: assigned,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(replica.id, member.id))
    }

    return await tx
      .select(MEMBER_RETURNING)
      .from(replica)
      .where(eq(replica.managedId, managedId))
      .orderBy(asc(replica.ordinal))
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
  endpoints: ReadonlyMap<
    string,
    ResolvedPrivateEndpoint | PrivateEndpointError
  >,
): ManagedMemberPeer | PrivateEndpointError {
  // Address is the peer's `tp0` relay address when transport is `fabric`,
  // matching the address the peer actually publishes.
  const resolved = endpoints.get(other.serverId)
  if (!resolved) return unavailablePeerError(fromMember, other)
  if ('kind' in resolved) return resolved
  if (other.privatePort === null) {
    return unavailablePeerError(fromMember, other)
  }
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
 * Batched private-endpoint resolution for one member's remote peers, grouped by
 * the class-aware purpose of each link (at most one round trip per purpose).
 */
async function resolvePeerEndpointsByPurpose(
  db: Db,
  fromMember: ManagedMemberRow,
  remotePeers: readonly ManagedMemberRow[],
): Promise<Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>> {
  const byPurpose = new Map<PrivateEndpointPurpose, string[]>()
  for (const peer of remotePeers) {
    const purpose = replicationPurposeForMemberPair(fromMember, peer)
    const group = byPurpose.get(purpose)
    if (group) group.push(peer.serverId)
    else byPurpose.set(purpose, [peer.serverId])
  }

  const endpoints = new Map<
    string,
    ResolvedPrivateEndpoint | PrivateEndpointError
  >()
  for (const [purpose, toServerIds] of byPurpose) {
    const resolved = await resolvePrivateEndpoints(db, {
      fromServerId: fromMember.serverId,
      toServerIds,
      purpose,
    })
    for (const serverId of toServerIds) {
      const entry = resolved.get(serverId)
      if (entry) endpoints.set(serverId, entry)
    }
  }
  return endpoints
}

/**
 * Resolve peer endpoints for one member (reachability of every other member
 * from this member's server). Used when building apply payloads.
 *
 * Co-resident peers are dialled by Docker container name on `turbopanel-managed`
 * (never host loopback). Remote peers use the private address + allocated
 * `private_port` private listener, resolved with the per-link ladder from
 * `replicationPurposeForMemberPair` — a failover peer never silently falls back
 * to fabric/public just because a read replica in the same cluster may.
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
  const endpoints = await resolvePeerEndpointsByPurpose(
    db,
    fromMember,
    others.filter((m) => m.serverId !== fromMember.serverId),
  )

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
    replicaClass: ManagedReplicaClass
    readEligible: boolean
    replicationTransport: PrivateEndpointTransport | null
  },
): Promise<ManagedMemberRow> {
  const [inserted] = await db
    .insert(replica)
    .values({
      managedId: params.managedId,
      serverId: params.serverId,
      role: 'replica',
      replicaClass: params.replicaClass,
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
    .update(replica)
    .set({
      isReadEligible: readEligible,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(replica.id, memberId))
    .returning(MEMBER_RETURNING)
  return updated ?? null
}

export async function updateManagedMemberReplicaClass(
  db: Db,
  memberId: string,
  replicaClass: ManagedReplicaClass,
): Promise<ManagedMemberRow | null> {
  const [updated] = await db
    .update(replica)
    .set({
      replicaClass,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(replica.id, memberId))
    .returning(MEMBER_RETURNING)
  return updated ?? null
}

export async function deleteManagedMember(
  db: Db,
  memberId: string,
): Promise<void> {
  await db.delete(replica).where(eq(replica.id, memberId))
}

export async function findManagedMember(
  db: Db,
  memberId: string,
): Promise<ManagedMemberRow | null> {
  const [row] = await db
    .select(MEMBER_RETURNING)
    .from(replica)
    .where(eq(replica.id, memberId))
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
    .update(replica)
    .set({
      status: 'applying',
      updatedAt: sql`now()`,
    })
    .where(eq(replica.managedId, managedId))
}

export async function updateMemberReplicationTransport(
  db: Db,
  memberId: string,
  transport: PrivateEndpointTransport | null,
): Promise<void> {
  await db
    .update(replica)
    .set({
      replicationTransport: transport,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(replica.id, memberId))
}

/**
 * Project daemon-observed per-member status + replication health onto
 * `replica` (never reverse-inferred from the command action).
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
    .select({ metadata: replica.metadata })
    .from(replica)
    .where(eq(replica.id, memberId))
    .limit(1)
  if (!existing) return

  const prev = isRecord(existing.metadata) ? { ...existing.metadata } : {}
  if (observed.replication !== undefined) {
    prev.replication = observed.replication
  }

  await db
    .update(replica)
    .set({
      status: observed.status,
      metadata: prev,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(replica.id, memberId))
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
