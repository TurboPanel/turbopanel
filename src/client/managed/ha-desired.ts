/**
 * Build + enqueue `managed.ha.reconcile` for a server's Orchestrator replica.
 *
 * One Raft group per organization, on servers that host a primary or
 * `failover` replica. Remote `read`/DR-only servers do not join.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  decryptSecret,
  ENVELOPE_PREFIX_SECRET,
  resealSecretForDaemon,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type {
  ManagedHaCluster,
  ManagedHaClusterMember,
  ManagedHaRaftConfig,
  ManagedHaRaftPeer,
  ManagedHaReconcileCommandPayload,
} from '../../lib/commands/schemas.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { ensureOrganizationManagedNetwork } from '../../lib/db/fabric-records.ts'
import { container, managed, replica, principal, server, service } from '../../lib/db/schema.ts'
import {
  MANAGED_HA_HTTP_PORT,
  MANAGED_HA_RAFT_PORT,
} from '../../lib/managed/ha-ports.ts'
import {
  orchestratorPromotionRule,
  pickHaAdvertiseAddress,
  serverHostsManagedHa,
} from '../../lib/managed/ha-policy.ts'
import { getManagedEngineSpec, type ManagedEngineSpec } from '../../lib/managed/index.ts'
import { loadDatacenterMembershipsForServers } from '../../lib/net/datacenter-membership.ts'
import {
  isPrivateEndpointError,
  resolvePrivateEndpoints,
  type PrivateEndpointError,
  type ResolvedPrivateEndpoint,
} from '../../lib/net/private-endpoint.ts'
import { compatLogWarn } from '../../log-compat.ts'
import { isManagedReplicationPrincipal } from './ingress-desired-pure.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import {
  buildManagedOrgTlsMaterial,
  ensureActiveOrganizationCa,
} from './apply-prepare.ts'
import {
  ensureManagedHaHierarchy,
  findManagedHaHierarchy,
  SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  type SystemHierarchyIds,
} from '../system/hierarchy.ts'

export const MANAGED_HA_RECONCILE_TTL_MS = 300_000

export type EnqueueManagedHaReconcileResult =
  | { ok: true; commandId: string; serverId: string }
  | { ok: false; reason: 'not_needed' | 'enqueue_failed' | 'prepare_failed' }

function haTeardownPayload(
  serverId: string,
  identity: ManagedHaReconcileCommandPayload['identity'],
  managedNetwork: string,
): ManagedHaReconcileCommandPayload {
  return {
    serverId,
    managedNetwork,
    desired: 'absent',
    raft: null,
    clusters: [],
    identity,
  }
}

async function loadHaMembersOnServer(
  db: Db,
  serverId: string,
): Promise<ManagedMemberRow[]> {
  const rows = await db
    .select()
    .from(replica)
    .where(eq(replica.serverId, serverId))
  return rows.map((row) => ({
    id: row.id,
    managedId: row.managedId,
    serverId: row.serverId,
    role: row.role,
    replicaClass: row.replicaClass,
    readEligible: row.isReadEligible,
    ordinal: row.ordinal,
    replicationTransport: row.replicationTransport,
    privatePort: row.privatePort,
    status: row.status,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

async function resealReplicationPassword(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  managedId: string,
  serverId: string,
): Promise<{ username: string; envelope: string } | null> {
  const principals = await db
    .select({
      id: principal.id,
      username: principal.appliedUsername,
      password: principal.password,
      metadata: principal.metadata,
    })
    .from(principal)
    .where(eq(principal.managedId, managedId))
  const repl = principals.find((row) => isManagedReplicationPrincipal(row.metadata))
  if (!repl || typeof repl.password !== 'string') return null
  if (!repl.password.startsWith(ENVELOPE_PREFIX_SECRET)) return null

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) return null
  const resealed = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    repl.password,
  )
  return { username: repl.username, envelope: resealed }
}

async function loadLocalEngineContainerNames(
  db: Db,
  managedId: string,
  serverId: string,
): Promise<Map<number, string>> {
  const rows = await db
    .select({
      ordinal: container.ordinal,
      containerName: container.containerName,
    })
    .from(container)
    .innerJoin(service, eq(service.id, container.serviceId))
    .innerJoin(managed, eq(managed.environmentId, service.environmentId))
    .where(
      and(
        eq(managed.id, managedId),
        eq(container.serverId, serverId),
        eq(container.role, 'service'),
      ),
    )
  const names = new Map<number, string>()
  for (const row of rows) {
    if (row.containerName) names.set(row.ordinal, row.containerName)
  }
  return names
}

export type HaEndpointMap = Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>

export type HaMemberDial = {
  host: string
  port: number
  containerName?: string
}

type HaSecretsParams = {
  serverId: string
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

export function haClusterMemberRole(role: string): ManagedHaClusterMember['role'] {
  return role === 'primary' ? 'primary' : 'replica'
}

export function haClusterReplicaClass(
  replicaClass: string | null,
): ManagedHaClusterMember['replicaClass'] {
  if (replicaClass === 'read' || replicaClass === 'failover') return replicaClass
  return null
}

function loadHaRemoteEndpoints(
  db: Db,
  thisServerId: string,
  members: readonly ManagedMemberRow[],
): Promise<HaEndpointMap> {
  const remoteIds = members
    .filter((member) => member.serverId !== thisServerId)
    .map((member) => member.serverId)
  if (remoteIds.length === 0) return Promise.resolve(new Map())
  return resolvePrivateEndpoints(db, {
    fromServerId: thisServerId,
    toServerIds: remoteIds,
    purpose: 'failover-replication',
  })
}

export function resolveLocalHaMemberDial(
  member: ManagedMemberRow,
  localNames: ReadonlyMap<number, string>,
  defaultPort: number,
): HaMemberDial {
  const name = localNames.get(member.ordinal)
  return {
    host: name ?? member.id,
    port: defaultPort,
    ...(name ? { containerName: name } : {}),
  }
}

export function resolveRemoteHaMemberDial(
  member: ManagedMemberRow,
  endpoints: HaEndpointMap,
): HaMemberDial | null {
  const resolved = endpoints.get(member.serverId)
  if (!resolved || isPrivateEndpointError(resolved)) return null
  if (member.privatePort === null) return null
  return { host: resolved.address, port: member.privatePort }
}

export function resolveHaMemberDial(
  member: ManagedMemberRow,
  thisServerId: string,
  localNames: ReadonlyMap<number, string>,
  defaultPort: number,
  endpoints: HaEndpointMap,
): HaMemberDial | null {
  if (member.serverId === thisServerId) {
    return resolveLocalHaMemberDial(member, localNames, defaultPort)
  }
  return resolveRemoteHaMemberDial(member, endpoints)
}

export function toHaClusterMember(
  member: ManagedMemberRow,
  dial: HaMemberDial,
): ManagedHaClusterMember {
  return {
    memberId: member.id,
    role: haClusterMemberRole(member.role),
    replicaClass: haClusterReplicaClass(member.replicaClass),
    promotionRule: orchestratorPromotionRule(member.replicaClass),
    host: dial.host,
    port: dial.port,
    ...(dial.containerName ? { containerName: dial.containerName } : {}),
  }
}

async function buildHaClusterMembers(
  db: Db,
  thisServerId: string,
  members: readonly ManagedMemberRow[],
  defaultPort: number,
): Promise<ManagedHaClusterMember[]> {
  const managedId = members[0]?.managedId
  const localNames = managedId
    ? await loadLocalEngineContainerNames(db, managedId, thisServerId)
    : new Map<number, string>()
  const endpoints = await loadHaRemoteEndpoints(db, thisServerId, members)

  const result: ManagedHaClusterMember[] = []
  for (const member of members) {
    const dial = resolveHaMemberDial(
      member,
      thisServerId,
      localNames,
      defaultPort,
      endpoints,
    )
    if (!dial) continue
    result.push(toHaClusterMember(member, dial))
  }
  return result
}

async function buildRaftConfig(
  db: Db,
  organizationId: string,
  thisServerId: string,
): Promise<ManagedHaRaftConfig | null> {
  const orgMembers = await db
    .select({
      serverId: replica.serverId,
      role: replica.role,
      replicaClass: replica.replicaClass,
    })
    .from(replica)
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .innerJoin(server, eq(server.id, replica.serverId))
    .where(eq(server.organizationId, organizationId))

  const byServer = new Map<string, Array<{ role: string; replicaClass: string | null }>>()
  for (const row of orgMembers) {
    const list = byServer.get(row.serverId) ?? []
    list.push({ role: row.role, replicaClass: row.replicaClass })
    byServer.set(row.serverId, list)
  }

  const raftServerIds = [...byServer.entries()]
    .filter(([, members]) => serverHostsManagedHa(members))
    .map(([serverId]) => serverId)
    .toSorted((a, b) => a.localeCompare(b))
  if (!raftServerIds.includes(thisServerId)) return null

  const pins = await loadDatacenterMembershipsForServers(db, raftServerIds)
  const thisPins = pins.get(thisServerId) ?? []
  const advertiseAddress = pickHaAdvertiseAddress(thisPins)
  if (!advertiseAddress) return null

  const peers: ManagedHaRaftPeer[] = []
  for (const serverId of raftServerIds) {
    const address = pickHaAdvertiseAddress(pins.get(serverId) ?? [])
    if (!address) continue
    peers.push({
      nodeId: serverId,
      address,
      raftPort: MANAGED_HA_RAFT_PORT,
      httpPort: MANAGED_HA_HTTP_PORT,
    })
  }
  if (peers.length === 0) return null

  return {
    nodeId: thisServerId,
    httpPort: MANAGED_HA_HTTP_PORT,
    raftPort: MANAGED_HA_RAFT_PORT,
    advertiseAddress,
    peers,
  }
}

async function loadManagedEngineSpecById(
  db: Db,
  managedId: string,
): Promise<ManagedEngineSpec | null> {
  const [managedRow] = await db
    .select({ engine: managed.engine })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return managedRow?.engine ? getManagedEngineSpec(managedRow.engine) : null
}

async function buildHaClusterIfReady(
  db: Db,
  params: HaSecretsParams,
  managedId: string,
): Promise<ManagedHaCluster | null> {
  const members = await listManagedMembers(db, managedId)
  if (members.length < 2) return null
  const spec = await loadManagedEngineSpecById(db, managedId)
  if (!spec) return null
  const repl = await resealReplicationPassword(
    db,
    params.secretsConfig,
    params.dataEncryptionSecrets,
    managedId,
    params.serverId,
  )
  if (!repl) return null
  const haMembers = await buildHaClusterMembers(
    db,
    params.serverId,
    members,
    spec.defaultPort,
  )
  if (haMembers.length < 2) return null
  return {
    managedId,
    engine: spec.engine,
    clusterAlias: managedId,
    members: haMembers,
    replicationUsername: repl.username,
    replicationPasswordEnvelope: repl.envelope,
  }
}

async function buildHaClustersForServer(
  db: Db,
  params: HaSecretsParams,
  localMembers: readonly ManagedMemberRow[],
): Promise<ManagedHaCluster[]> {
  const managedIds = [...new Set(localMembers.map((row) => row.managedId))]
    .toSorted((a, b) => a.localeCompare(b))
  const clusters: ManagedHaCluster[] = []
  for (const managedId of managedIds) {
    const cluster = await buildHaClusterIfReady(db, params, managedId)
    if (cluster) clusters.push(cluster)
  }
  return clusters
}

export function haIdentity(
  serviceId: string,
  containerName: string,
): ManagedHaReconcileCommandPayload['identity'] {
  return {
    serviceId,
    composeServiceName: SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
    containerName,
  }
}

export function haTeardownIfPresent(
  serverId: string,
  existing: SystemHierarchyIds | null,
  managedNetwork: string,
): ManagedHaReconcileCommandPayload | null {
  if (!existing) return null
  return haTeardownPayload(
    serverId,
    haIdentity(existing.serviceId, existing.containerName ?? existing.serviceId),
    managedNetwork,
  )
}

export async function buildManagedHaReconcilePayload(
  db: Db,
  params: HaSecretsParams,
): Promise<ManagedHaReconcileCommandPayload | null> {
  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1)
  if (!serverRow?.organizationId) return null
  const organizationId = serverRow.organizationId

  // Every `managed.ha.reconcile` payload carries the server-owner org's managed
  // network, teardown included — but the row is allocated lazily, only once a
  // payload is actually going to be emitted, so a reconcile that decides there
  // is nothing to do leaves no network behind.
  const resolveManagedNetworkName = async () =>
    (await ensureOrganizationManagedNetwork(db, { organizationId })).hostName

  const localMembers = await loadHaMembersOnServer(db, params.serverId)
  const hostsHa = serverHostsManagedHa(localMembers)
  const existing = await findManagedHaHierarchy(db, { serverId: params.serverId })

  if (!hostsHa) {
    if (!existing) return null
    return haTeardownIfPresent(
      params.serverId,
      existing,
      await resolveManagedNetworkName(),
    )
  }

  const hierarchy = await ensureManagedHaHierarchy(db, {
    organizationId,
    serverId: params.serverId,
  })
  const identity = haIdentity(hierarchy.serviceId, hierarchy.containerName)

  const raft = await buildRaftConfig(db, organizationId, params.serverId)
  if (!raft) {
    return {
      ...haTeardownPayload(
        params.serverId,
        identity,
        await resolveManagedNetworkName(),
      ),
      desired: 'absent',
    }
  }

  const clusters = await buildHaClustersForServer(db, params, localMembers)

  const daemonState = await getServerDaemonStateByServerId(db, params.serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) return null
  const ca = await ensureActiveOrganizationCa(
    db,
    params.dataEncryptionSecrets,
    organizationId,
  )
  if ('kind' in ca) return null
  const caPrivateKeyPem = await decryptSecret(
    params.dataEncryptionSecrets,
    ca.signer.privateKeyPemSealed,
  )
  const orgTlsMaterial = await buildManagedOrgTlsMaterial(
    params.secretsConfig,
    params.dataEncryptionSecrets,
    { serverId: params.serverId, keyId: daemonState.key.id },
    {
      certificatePem: ca.signer.certificatePem,
      privateKeyPem: caPrivateKeyPem,
      trustBundlePem: ca.trustBundlePem,
    },
    `ha-${params.serverId}`,
    [identity.containerName],
    [raft.advertiseAddress],
  )

  return {
    serverId: params.serverId,
    managedNetwork: await resolveManagedNetworkName(),
    desired: 'present',
    raft,
    clusters,
    identity,
    orgTlsMaterial,
  }
}

export async function enqueueManagedHaReconcile(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    serverId: string
    actorType: 'user' | 'system'
    actorId: string
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  }>,
): Promise<EnqueueManagedHaReconcileResult> {
  const built = await buildManagedHaReconcilePayload(db, {
    serverId: params.serverId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
  })
  if (built === null) return { ok: false, reason: 'not_needed' }

  const expiresAt = new Date(Date.now() + MANAGED_HA_RECONCILE_TTL_MS).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: params.actorType,
    actorId: params.actorId,
    type: 'managed.ha.reconcile',
    payload: built,
    expiresAt,
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: 'managed.ha.reconcile',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return { ok: false, reason: 'enqueue_failed' }
  }
  return { ok: true, commandId: record.id, serverId: params.serverId }
}

export async function fanOutManagedHaReconcile(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    managedId: string
    actorType: 'user' | 'system'
    actorId: string
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
    extraServerIds?: readonly string[]
  }>,
): Promise<void> {
  const memberIds = await db
    .select({
      serverId: replica.serverId,
      role: replica.role,
      replicaClass: replica.replicaClass,
    })
    .from(replica)
    .where(eq(replica.managedId, params.managedId))
  const serverIds = new Set<string>(params.extraServerIds ?? [])
  for (const row of memberIds) {
    if (serverHostsManagedHa([row])) serverIds.add(row.serverId)
  }
  for (const serverId of serverIds) {
    const result = await enqueueManagedHaReconcile(db, commandQueue, {
      serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    })
    if (!result.ok && result.reason === 'enqueue_failed') {
      compatLogWarn(
        'managed-ha',
        `ha reconcile enqueue failed managedId=${params.managedId} serverId=${serverId}`,
      )
    }
  }
}
