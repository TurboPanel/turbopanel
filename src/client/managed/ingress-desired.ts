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
  ENVELOPE_MAGIC,
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
import { parseManagedRowOptions } from './options.ts'
import { resolveManagedConnectionListener } from './routes-helpers.ts'

const AT_REST_ENVELOPE_PREFIX = `${ENVELOPE_MAGIC}.`

export const MANAGED_INGRESS_RECONCILE_TTL_MS = 300_000

export type ManagedIngressReconcilePrepareError =
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'managed_credential_not_sealed' }
  | { kind: 'datacenter_ip_required'; serverId: string }
  | PrivateEndpointError

const BIND_RANK: Record<HostingBindScope, number> = {
  local: 1,
  datacenter: 2,
  public: 3,
}

/** Hostgroup pair for cluster index `i` (stable writer = 2i, reader = 2i+1). */
export function hostgroupsForClusterIndex(index: number): {
  writerHostgroup: number
  readerHostgroup: number
} {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`Invalid cluster index: ${index}`)
  }
  return {
    writerHostgroup: index * 2,
    readerHostgroup: index * 2 + 1,
  }
}

/**
 * Union of enabled exposure binds to the most permissive scope
 * (public > datacenter > local). Returns `undefined` when every cluster has
 * exposure disabled.
 */
export function unionExposureBind(
  binds: readonly (HostingBindScope | undefined)[],
): HostingBindScope | undefined {
  let best: HostingBindScope | undefined
  let bestRank = 0
  for (const bind of binds) {
    if (bind === undefined) continue
    const rank = BIND_RANK[bind] ?? 0
    if (rank > bestRank) {
      best = bind
      bestRank = rank
    }
  }
  return best
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolPortForEngine(engine: string, defaultPort: number): 5432 | 3306 {
  if (defaultPort === 3306) return 3306
  if (defaultPort === 5432) return 5432
  // Postgres-first — treat unknown defaults as the shared Postgres listener.
  if (engine === 'mysql' || engine === 'mariadb') return 3306
  return 5432
}

function isManagedRootPrincipal(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.managedRoot === true
}

function isManagedReplicationPrincipal(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.managedReplication === true
}

function principalDefaultDatabase(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined
  if (!Array.isArray(metadata.databases)) return undefined
  const first = metadata.databases.find(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  return first
}

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
  organizationId: string
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
    if (typeof row.username !== 'string' || row.username.length === 0) continue
    // Replication principal is not a client login — never a ProxySQL frontend user.
    if (isManagedReplicationPrincipal(row.metadata)) continue
    const sealed = row.password
    if (typeof sealed !== 'string' || !sealed.startsWith(AT_REST_ENVELOPE_PREFIX)) {
      return { kind: 'managed_credential_not_sealed' }
    }
    const resealed = await resealSecretForDaemon(
      params.secretsConfig,
      params.dataEncryptionSecrets,
      { serverId: params.serverId, keyId: daemonState.key.id },
      sealed,
    )
    const role = isManagedRootPrincipal(row.metadata) ? 'root' : 'user'
    const user: ManagedIngressReconcileUser = {
      username: row.username,
      role,
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
  const role: 'primary' | 'replica' =
    member.role === 'replica' ? 'replica' : 'primary'

  if (member.serverId === fromServerId) {
    const address = member.containerName
    if (!address) {
      return {
        kind: 'private_path_unavailable',
        fromServerId,
        toServerId: member.serverId,
      }
    }
    return {
      memberId: member.memberId,
      role,
      readEligible: member.readEligible,
      address,
      port: enginePort,
      transport: 'local',
    }
  }

  if (member.privatePort === null) {
    return {
      kind: 'private_path_unavailable',
      fromServerId,
      toServerId: member.serverId,
    }
  }

  const resolved = await resolvePrivateEndpoint(db, {
    fromServerId,
    toServerId: member.serverId,
  })
  if (isPrivateEndpointError(resolved)) return resolved

  return {
    memberId: member.memberId,
    role,
    readEligible: member.readEligible,
    address: resolved.address,
    port: member.privatePort,
    transport: resolved.transport,
  }
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
  if ('kind' in ca) return ca

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

// Wildcard "any interface" bind markers — listen-address sentinels, never
// real endpoints to advertise as a SAN.
const WILDCARD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '::0']) // NOSONAR typescript:S1313 — wildcard bind sentinel, not a routable address

function addSanValue(
  value: string,
  dnsNames: Set<string>,
  ipAddresses: Set<string>,
): void {
  if (looksLikeIpLiteral(value)) ipAddresses.add(value)
  else dnsNames.add(value)
}

function addBindAddressSan(
  bindAddress: string | undefined,
  dnsNames: Set<string>,
  ipAddresses: Set<string>,
): void {
  if (!bindAddress) return
  if (!looksLikeIpLiteral(bindAddress)) {
    dnsNames.add(bindAddress)
    return
  }
  if (WILDCARD_BIND_ADDRESSES.has(bindAddress)) return
  ipAddresses.add(bindAddress)
}

function addBackendAddressSan(
  address: string,
  dnsNames: Set<string>,
  ipAddresses: Set<string>,
): void {
  if (!address || address.length === 0) return
  // Co-resident container names are not client dial targets.
  if (!looksLikeIpLiteral(address) && !address.includes('.')) return
  addSanValue(address, dnsNames, ipAddresses)
}

/**
 * Collect DNS + IP SANs that clients are told to dial for this server's
 * ProxySQL — hostname, bind address, and remote peer endpoints used by backends.
 * Synthetic names (leaf CN) stay additional SANs only via the builder.
 */
export function collectProxySqlListenerSans(params: {
  hostname: string | null | undefined
  bindAddress: string | undefined
  backendAddresses: readonly string[]
}): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames = new Set<string>()
  const ipAddresses = new Set<string>()
  const hostname = params.hostname?.trim()
  if (hostname) addSanValue(hostname, dnsNames, ipAddresses)
  addBindAddressSan(params.bindAddress, dnsNames, ipAddresses)
  for (const address of params.backendAddresses) {
    addBackendAddressSan(address, dnsNames, ipAddresses)
  }
  return {
    dnsNames: [...dnsNames].sort((a, b) => a.localeCompare(b)),
    ipAddresses: [...ipAddresses].sort((a, b) => a.localeCompare(b)),
  }
}

function looksLikeIpLiteral(value: string): boolean {
  if (value.includes(':')) return true // IPv6 or bracketed form
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false
    const n = Number(p)
    return n >= 0 && n <= 255
  })
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
 * - No cluster on this server has exposure enabled → `undefined`, which the
 *   daemon (`managed-ingress-reconcile.ts`) treats as "omit `bindAddress`" →
 *   `null` → publish nothing to the host. Bound-only consumers still reach
 *   ProxySQL over {@link MANAGED_INGRESS_NETWORK} regardless of this value.
 * - `bind: 'public'` has **no IP-pin concept** for managed exposure (unlike
 *   hosting's `ipId`) — it always means "all interfaces". Resolve it to
 *   `'0.0.0.0'` directly instead of delegating to
 *   {@link resolveHostingBindAddress}: that helper's `undefined` for
 *   "public, no pin" means "Caddy already wildcards with no bind directive",
 *   which here would be misread by the daemon as "exposure disabled" and
 *   silently drop the publish the operator explicitly asked for.
 * - `local` / `datacenter` resolve through the shared hosting-bind helper,
 *   which already returns a concrete address for both.
 */
async function resolveIngressBindAddress(
  db: Db,
  serverId: string,
  enabledBinds: Array<HostingBindScope | undefined>,
): Promise<string | undefined | ManagedIngressReconcilePrepareError> {
  const bindScope = unionExposureBind(enabledBinds)
  if (bindScope === undefined) return undefined
  if (bindScope === 'public') return '0.0.0.0' // NOSONAR typescript:S1313 — explicit all-interfaces publish, not a routable address

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: { bind: bindScope },
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

  const hierarchy = await ensureManagedIngressHierarchy(db, {
    organizationId,
    serverId: params.serverId,
  })

  const managedIds = [...managedIdSet].sort((a, b) => a.localeCompare(b))

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
  listenerSans.dnsNames = [
    ...new Set([...listenerSans.dnsNames, hierarchy.containerName]),
  ].sort((a, b) => a.localeCompare(b))

  const orgTlsMaterial = await buildOrgTlsForServer(
    db,
    params.secretsConfig,
    params.dataEncryptionSecrets,
    organizationId,
    params.serverId,
    listenerSans,
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
