/**
 * Build + enqueue `managed.ingress.reconcile` for a server's ProxySQL frontend.
 *
 * Desired state is derived from all managed members on the server (and their
 * full cluster peer sets). Co-resident engines are addressed by Docker
 * container name on `turbopanel-managed`; remote backends dial the member's
 * **private listener** (published only on that member's private address at
 * `node.private_port`) — the same path engine→engine replication
 * uses for cross-host streaming.
 */

import { and, eq, inArray } from 'drizzle-orm'
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
  ManagedApplyOrgTlsMaterial,
  ManagedIngressReconcileBackend,
  ManagedIngressReconcileCluster,
  ManagedIngressReconcileCommandPayload,
  ManagedIngressReconcileUser,
} from '../../lib/commands/schemas.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import {
  binding,
  container,
  environment,
  managed,
  node,
  principal,
  project,
  server,
  service,
} from '../../lib/db/schema.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import type { ManagedEngineCode } from '../../lib/managed/types.ts'
import {
  isPrivateEndpointError,
  resolvePrivateEndpoint,
  type PrivateEndpointError,
} from '../../lib/net/private-endpoint.ts'
import type { HostingBindScope } from '../../lib/hosting-options.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../../lib/project-options.ts'
import { resolveHostingBindAddress } from '../environments/deploy-prepare.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import {
  buildManagedOrgTlsMaterial,
  ensureActiveOrganizationCa,
} from './apply-prepare.ts'
import {
  buildIngressUserRole,
  buildLocalOrMissingPortBackend,
  buildRemoteIngressBackend,
  collectProxySqlListenerSans,
  decideIngressBindScope,
  hostgroupsForClusterIndex,
  isAtRestSealedPassword,
  mergeHierarchyContainerSan,
  principalDefaultDatabase,
  protocolPortForEngine,
  shouldSkipIngressFrontendUser,
  sortManagedIds,
} from './ingress-desired-pure.ts'
import { parseManagedRowOptions } from './options.ts'
import { resolveManagedConnectionListener } from './routes-helpers.ts'


export const MANAGED_INGRESS_RECONCILE_TTL_MS = 300_000

export type ManagedIngressReconcilePrepareError =
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'managed_credential_not_sealed' }
  | { kind: 'datacenter_ip_required'; serverId: string }
  | PrivateEndpointError

export {
  collectProxySqlListenerSans,
  hostgroupsForClusterIndex,
  unionExposureBind,
} from './ingress-desired-pure.ts'

type MemberClusterRow = {
  memberId: string
  managedId: string
  serverId: string
  role: string
  readEligible: boolean
  ordinal: number
  privatePort: number | null
  engine: string | null
  options: unknown
  organizationId: string | null
  environmentId: string
  containerName: string | null
}

async function loadMembersOnServer(
  db: Db,
  serverId: string,
): Promise<MemberClusterRow[]> {
  const rows = await db
    .select({
      memberId: node.id,
      managedId: node.managedId,
      serverId: node.serverId,
      role: node.role,
      readEligible: node.readEligible,
      ordinal: node.ordinal,
      privatePort: node.privatePort,
      engine: managed.engine,
      options: managed.options,
      organizationId: server.organizationId,
      environmentId: managed.environmentId,
    })
    .from(node)
    .innerJoin(managed, eq(node.managedId, managed.id))
    .innerJoin(server, eq(node.serverId, server.id))
    .where(eq(node.serverId, serverId))

  if (rows.length === 0) return []

  const environmentIds = [...new Set(rows.map((row) => row.environmentId))]
  const containerRows = await db
    .select({
      environmentId: service.environmentId,
      serverId: container.serverId,
      ordinal: container.ordinal,
      containerName: container.containerName,
    })
    .from(container)
    .innerJoin(service, eq(container.serviceId, service.id))
    .where(
      and(
        inArray(service.environmentId, environmentIds),
        eq(container.role, 'service'),
      ),
    )

  const containerByKey = new Map<string, string>()
  for (const row of containerRows) {
    if (!row.containerName) continue
    containerByKey.set(
      `${row.environmentId}:${row.serverId}:${row.ordinal}`,
      row.containerName,
    )
  }

  return rows.map((row) => ({
    memberId: row.memberId,
    managedId: row.managedId,
    serverId: row.serverId,
    role: row.role,
    readEligible: row.readEligible,
    ordinal: row.ordinal,
    privatePort: row.privatePort,
    engine: row.engine,
    options: row.options,
    organizationId: row.organizationId,
    environmentId: row.environmentId,
    containerName:
      containerByKey.get(
        `${row.environmentId}:${row.serverId}:${row.ordinal}`,
      ) ?? null,
  }))
}

async function loadClusterMembers(
  db: Db,
  managedId: string,
): Promise<MemberClusterRow[]> {
  const rows = await db
    .select({
      memberId: node.id,
      managedId: node.managedId,
      serverId: node.serverId,
      role: node.role,
      readEligible: node.readEligible,
      ordinal: node.ordinal,
      privatePort: node.privatePort,
      engine: managed.engine,
      options: managed.options,
      organizationId: server.organizationId,
      environmentId: managed.environmentId,
    })
    .from(node)
    .innerJoin(managed, eq(node.managedId, managed.id))
    .innerJoin(server, eq(node.serverId, server.id))
    .where(eq(node.managedId, managedId))

  if (rows.length === 0) return []

  const environmentIds = [...new Set(rows.map((row) => row.environmentId))]
  const containerRows = await db
    .select({
      environmentId: service.environmentId,
      serverId: container.serverId,
      ordinal: container.ordinal,
      containerName: container.containerName,
    })
    .from(container)
    .innerJoin(service, eq(container.serviceId, service.id))
    .where(
      and(
        inArray(service.environmentId, environmentIds),
        eq(container.role, 'service'),
      ),
    )

  const containerByKey = new Map<string, string>()
  for (const row of containerRows) {
    if (!row.containerName) continue
    containerByKey.set(
      `${row.environmentId}:${row.serverId}:${row.ordinal}`,
      row.containerName,
    )
  }

  return rows.map((row) => ({
    memberId: row.memberId,
    managedId: row.managedId,
    serverId: row.serverId,
    role: row.role,
    readEligible: row.readEligible,
    ordinal: row.ordinal,
    privatePort: row.privatePort,
    engine: row.engine,
    options: row.options,
    organizationId: row.organizationId,
    environmentId: row.environmentId,
    containerName:
      containerByKey.get(
        `${row.environmentId}:${row.serverId}:${row.ordinal}`,
      ) ?? null,
  }))
}

async function loadClusterUsers(
  db: Db,
  managedId: string,
  params: {
    serverId: string
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<ManagedIngressReconcileUser[] | ManagedIngressReconcilePrepareError> {
  const daemonState = await getServerDaemonStateByServerId(db, params.serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId: params.serverId }
  }

  const rows = await db
    .select({
      id: principal.id,
      username: principal.username,
      metadata: principal.metadata,
      password: principal.password,
    })
    .from(principal)
    .where(eq(principal.managedId, managedId))

  const users: ManagedIngressReconcileUser[] = []
  for (const row of rows) {
    if (shouldSkipIngressFrontendUser(row.username, row.metadata)) continue
    const sealed = row.password
    if (!isAtRestSealedPassword(sealed, ENVELOPE_PREFIX_SECRET)) {
      return { kind: 'managed_credential_not_sealed' }
    }
    const resealed = await resealSecretForDaemon(
      params.secretsConfig,
      params.dataEncryptionSecrets,
      { serverId: params.serverId, keyId: daemonState.key.id },
      sealed,
    )
    const user: ManagedIngressReconcileUser = {
      username: row.username,
      role: buildIngressUserRole(row.metadata),
      password: resealed,
    }
    const defaultDatabase = principalDefaultDatabase(row.metadata)
    if (defaultDatabase !== undefined) user.defaultDatabase = defaultDatabase
    users.push(user)
  }
  users.sort((a, b) => a.username.localeCompare(b.username))
  return users
}

async function resolveBackendAddress(
  db: Db,
  fromServerId: string,
  member: MemberClusterRow,
  enginePort: number,
): Promise<ManagedIngressReconcileBackend | ManagedIngressReconcilePrepareError> {
  const localOrMissing = buildLocalOrMissingPortBackend(
    fromServerId,
    member,
    enginePort,
  )
  if (localOrMissing.kind === 'ok') return localOrMissing.backend
  if (localOrMissing.kind === 'private_path_unavailable') {
    return {
      kind: 'private_path_unavailable',
      fromServerId: localOrMissing.fromServerId,
      toServerId: localOrMissing.toServerId,
    }
  }

  const resolved = await resolvePrivateEndpoint(db, {
    fromServerId,
    toServerId: member.serverId,
  })
  if (isPrivateEndpointError(resolved)) return resolved

  const privatePort = member.privatePort
  if (privatePort === null) {
    return {
      kind: 'private_path_unavailable',
      fromServerId,
      toServerId: member.serverId,
    }
  }

  return buildRemoteIngressBackend({
    memberId: member.memberId,
    role: localOrMissing.role,
    readEligible: member.readEligible,
    address: resolved.address,
    privatePort,
    transport: resolved.transport,
  })
}

async function buildOrgTlsForServer(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  organizationId: string,
  serverId: string,
  listenerSans: {
    dnsNames: string[]
    ipAddresses: string[]
  },
): Promise<ManagedApplyOrgTlsMaterial | ManagedIngressReconcilePrepareError> {
  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const ca = await ensureActiveOrganizationCa(
    db,
    dataEncryptionSecrets,
    organizationId,
  )
  if ('kind' in ca) {
    // ensureActiveOrganizationCa prepare errors are a subset of ingress prepare errors
    return ca as ManagedIngressReconcilePrepareError
  }

  const caPrivateKeyPem = await decryptSecret(
    dataEncryptionSecrets,
    ca.privateKeyPemSealed,
  )
  return buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    { certificatePem: ca.certificatePem, privateKeyPem: caPrivateKeyPem },
    `ingress-${serverId}`,
    listenerSans.dnsNames,
    listenerSans.ipAddresses,
  )
}

async function resolveClusterBackends(
  db: Db,
  serverId: string,
  members: MemberClusterRow[],
  port: number,
): Promise<ManagedIngressReconcileBackend[] | ManagedIngressReconcilePrepareError> {
  const backends: ManagedIngressReconcileBackend[] = []
  for (const member of members) {
    const backend = await resolveBackendAddress(db, serverId, member, port)
    if ('kind' in backend) return backend
    backends.push(backend)
  }
  backends.sort((a, b) => a.memberId.localeCompare(b.memberId))
  return backends
}

/**
 * Build one cluster entry for `managedId`, recording its exposure bind (if
 * enabled) onto `enabledBinds`. Returns `null` when the cluster has no
 * members or an unrecognized engine (nothing to reconcile for it).
 */
async function buildIngressCluster(
  db: Db,
  serverId: string,
  managedId: string,
  index: number,
  enabledBinds: Array<HostingBindScope | undefined>,
  reseal: {
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<
  ManagedIngressReconcileCluster | ManagedIngressReconcilePrepareError | null
> {
  const members = await loadClusterMembers(db, managedId)
  if (members.length === 0) return null

  const sample = members[0]!
  const engineCode = (sample.engine ?? 'postgres') as ManagedEngineCode
  const spec = getManagedEngineSpec(engineCode)
  if (!spec) return null

  const parsed = parseManagedRowOptions(spec, sample.options)
  const settings: ManagedSettings = parsed?.settings ?? { ...spec.defaultSettings }
  if (settings.exposure.enabled) {
    enabledBinds.push(settings.exposure.bind)
  }

  const port = spec.defaultPort
  const backends = await resolveClusterBackends(db, serverId, members, port)
  if ('kind' in backends) return backends

  const users = await loadClusterUsers(db, managedId, {
    serverId,
    secretsConfig: reseal.secretsConfig,
    dataEncryptionSecrets: reseal.dataEncryptionSecrets,
  })
  if ('kind' in users) return users

  const hostgroups = hostgroupsForClusterIndex(index)

  return {
    managedId,
    engine: engineCode,
    protocolPort: protocolPortForEngine(engineCode, port),
    writerHostgroup: hostgroups.writerHostgroup,
    readerHostgroup: hostgroups.readerHostgroup,
    backends,
    users,
  }
}

/**
 * Explicit bind decision for the shared ProxySQL frontend — never let an
 * ambiguous `undefined` mean two different things.
 *
 * Pure scope decision lives in {@link decideIngressBindScope}; `local` /
 * `datacenter` still resolve through the shared hosting-bind helper.
 */
async function resolveIngressBindAddress(
  db: Db,
  serverId: string,
  enabledBinds: Array<HostingBindScope | undefined>,
): Promise<string | undefined | ManagedIngressReconcilePrepareError> {
  const decision = decideIngressBindScope(enabledBinds)
  if (decision.kind === 'omit') return undefined
  if (decision.kind === 'public_all_interfaces') return decision.address

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: { bind: decision.bind },
    ipId: null,
  })
  if (
    typeof bindResolved === 'object' &&
    bindResolved?.kind === 'datacenter_ip_required'
  ) {
    return bindResolved
  }
  return typeof bindResolved === 'string' ? bindResolved : undefined
}

/** Build every cluster entry for `managedIds`, short-circuiting on the first error. */
async function buildIngressClusters(
  db: Db,
  serverId: string,
  managedIds: readonly string[],
  enabledBinds: Array<HostingBindScope | undefined>,
  reseal: {
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<ManagedIngressReconcileCluster[] | ManagedIngressReconcilePrepareError> {
  const clusters: ManagedIngressReconcileCluster[] = []
  for (let index = 0; index < managedIds.length; index++) {
    const cluster = await buildIngressCluster(
      db,
      serverId,
      managedIds[index]!,
      index,
      enabledBinds,
      reseal,
    )
    if (cluster === null) continue
    if ('kind' in cluster) return cluster
    clusters.push(cluster)
  }
  return clusters
}

/**
 * Prefer the same host clients see (connection panel / binding resolver):
 * the first cluster whose exposure listener resolves a host wins.
 */
async function resolveAdvertisedHost(
  db: Db,
  serverId: string,
  fallbackHost: string | null,
  clusters: readonly ManagedIngressReconcileCluster[],
): Promise<string | null> {
  for (const cluster of clusters) {
    const [sample] = await db
      .select({ options: managed.options, engine: managed.engine })
      .from(managed)
      .where(eq(managed.id, cluster.managedId))
      .limit(1)
    if (!sample) continue
    const engineCode = (sample.engine ?? 'postgres') as ManagedEngineCode
    const spec = getManagedEngineSpec(engineCode)
    if (!spec) continue
    const parsed = parseManagedRowOptions(spec, sample.options)
    const settings = parsed?.settings ?? { ...spec.defaultSettings }
    const listener = await resolveManagedConnectionListener(db, {
      serverId,
      protocolPort: cluster.protocolPort,
      exposure: settings.exposure,
    })
    if (listener?.host) return listener.host
  }
  return fallbackHost
}

/**
 * Build the full `managed.ingress.reconcile` payload for a server.
 *
 * Returns `null` when the server neither hosts managed members nor hosts
 * compose services bound to a managed cluster (nothing to reconcile).
 */
export async function buildManagedIngressReconcilePayload(
  db: Db,
  params: {
    serverId: string
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<
  | ManagedIngressReconcileCommandPayload
  | null
  | ManagedIngressReconcilePrepareError
> {
  const localMembers = await loadMembersOnServer(db, params.serverId)
  const boundManagedIds = await loadBoundManagedIdsForServer(db, params.serverId)

  const managedIdSet = new Set<string>([
    ...localMembers.map((row) => row.managedId),
    ...boundManagedIds,
  ])
  if (managedIdSet.size === 0) return null

  const [serverRow] = await db
    .select({
      organizationId: server.organizationId,
      hostname: server.hostname,
    })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1)
  if (!serverRow) return null

  const organizationId =
    localMembers[0]?.organizationId ?? serverRow.organizationId
  if (!organizationId) return null

  const hierarchy = await ensureManagedIngressHierarchy(db, {
    organizationId,
    serverId: params.serverId,
  })

  const managedIds = sortManagedIds(managedIdSet)

  const enabledBinds: Array<HostingBindScope | undefined> = []
  const clusters = await buildIngressClusters(
    db,
    params.serverId,
    managedIds,
    enabledBinds,
    {
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    },
  )
  if ('kind' in clusters) return clusters
  if (clusters.length === 0) return null

  const bindAddress = await resolveIngressBindAddress(
    db,
    params.serverId,
    enabledBinds,
  )
  if (typeof bindAddress === 'object' && bindAddress !== undefined) {
    return bindAddress
  }

  const advertisedHost = await resolveAdvertisedHost(
    db,
    params.serverId,
    serverRow.hostname,
    clusters,
  )

  const backendAddresses = clusters.flatMap((c) =>
    c.backends.map((b) => b.address)
  )
  const listenerSans = collectProxySqlListenerSans({
    hostname: advertisedHost,
    bindAddress: typeof bindAddress === 'string' ? bindAddress : undefined,
    backendAddresses,
  })
  // Bindings (`resolveBindingEndpoint`) always dial ProxySQL by this
  // container's own Docker name over `turbopanel-managed`, regardless of the
  // public `bindAddress` — the leaf cert must carry it as a SAN or
  // `sslmode=verify-full` binding connections fail hostname verification
  // even though the TCP path is reachable.
  const listenerSansWithHierarchy = mergeHierarchyContainerSan(
    listenerSans,
    hierarchy.containerName,
  )

  const orgTlsMaterial = await buildOrgTlsForServer(
    db,
    params.secretsConfig,
    params.dataEncryptionSecrets,
    organizationId,
    params.serverId,
    listenerSansWithHierarchy,
  )
  if ('kind' in orgTlsMaterial) return orgTlsMaterial

  const payload: ManagedIngressReconcileCommandPayload = {
    serverId: params.serverId,
    orgTlsMaterial,
    clusters,
  }

  if (typeof bindAddress === 'string') {
    payload.bindAddress = bindAddress
  }

  return payload
}

/**
 * Managed clusters whose consumers (compose services) place on `serverId`.
 * Those servers need ProxySQL routes even when they host no engine members.
 */
async function loadBoundManagedIdsForServer(
  db: Db,
  serverId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      managedId: principal.managedId,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(binding)
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(principal, eq(binding.principalId, principal.id))

  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.managedId) continue
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    )
    if (placement === serverId) ids.add(row.managedId)
  }
  return [...ids]
}

export type EnqueueManagedIngressReconcileResult =
  | { ok: true; commandId: string; serverId: string }
  | { ok: false; reason: 'not_needed' | 'enqueue_failed' | 'prepare_failed' }

/**
 * Create + enqueue one `managed.ingress.reconcile` for the server.
 * Compensates the command row to `failed` when the queue rejects.
 * Callers own per-request server-id dedup (`Set`).
 */
export async function enqueueManagedIngressReconcile(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    serverId: string
    actorType: 'user' | 'system'
    actorId: string
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  }>,
): Promise<EnqueueManagedIngressReconcileResult> {
  const built = await buildManagedIngressReconcilePayload(db, {
    serverId: params.serverId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
  })
  if (built === null) return { ok: false, reason: 'not_needed' }
  if ('kind' in built) return { ok: false, reason: 'prepare_failed' }

  const expiresAt = new Date(
    Date.now() + MANAGED_INGRESS_RECONCILE_TTL_MS,
  ).toISOString()

  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: params.actorType,
    actorId: params.actorId,
    type: 'managed.ingress.reconcile',
    payload: built,
    expiresAt,
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: 'managed.ingress.reconcile',
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
