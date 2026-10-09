import { and, asc, count, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import {
  dropEnvironmentSubtreeInTx,
  isActiveContainerStatus,
} from '../../features/projects/project-delete.ts'
import {
  HIERARCHY_DELETE_HAS_CHILDREN_CODE,
  HIERARCHY_DELETE_HAS_CHILDREN_ERROR,
} from '../hierarchy-delete.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  container,
  deployment,
  environment,
  hosting,
  ip,
  managed,
  network,
  project,
  replica,
  server,
  service,
  slot,
  storage,
  storageCopy,
  variable,
  workspace,
} from '../../db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../db/workspace-kind.ts'
import { purgeServerFabricForeignKeys } from './server-fk.ts'

export const SERVER_DELETE_BLOCKER_KIND_VALUES = [
  'network',
  'container',
  'ip',
  'environment',
  'managed',
  'replica',
  'deployment',
  'slot',
  'copy',
] as const

export type ServerDeleteBlockerKind = (typeof SERVER_DELETE_BLOCKER_KIND_VALUES)[number]

/** Server-services removal kinds: every delete blocker, plus the co-located host. */
export const SERVER_SERVICES_REMOVAL_KIND_VALUES = [
  ...SERVER_DELETE_BLOCKER_KIND_VALUES,
  'colocated',
  'present_elsewhere',
] as const

export type ServerServicesRemovalKind = (typeof SERVER_SERVICES_REMOVAL_KIND_VALUES)[number]

/**
 * Leftover kinds `forgetResources` always drops (container / network / address
 * rows, plus app environments, forgettable members, leftover deployments,
 * slots, and copies). Blocked databases still 409.
 */
export const FORGETTABLE_SERVER_DELETE_BLOCKER_KINDS = new Set<ServerDeleteBlockerKind>([
  'network',
  'container',
  'ip',
  'environment',
  'deployment',
  'slot',
  'copy',
  'replica',
])

export const SERVER_DELETE_BLOCKER_LABELS: Record<ServerDeleteBlockerKind, string> = {
  network: 'a network',
  container: 'a container',
  ip: 'an address',
  environment: 'an app environment',
  managed: 'a managed database is still placed on this server',
  replica: 'a database member is still placed on this server',
  deployment: 'a deployment',
  slot: 'a replica slot',
  copy: 'a storage copy',
}

/** A named app environment behind an `environment` blocker. */
export type ServerBlockerEnvironmentItem = {
  id: string
  name: string
  projectId: string
  projectName: string
  hasDatabase: boolean
}

/** A named database behind a `managed` or `replica` blocker. */
export type ServerBlockerDatabaseItem = {
  id: string
  name: string
}

export type ServerDeleteBlockerItem = ServerBlockerEnvironmentItem | ServerBlockerDatabaseItem

/** `"Project / Environment"` for an environment item, the plain name otherwise. */
export function serverBlockerItemName(item: ServerDeleteBlockerItem): string {
  return 'projectName' in item ? `${item.projectName} / ${item.name}` : item.name
}

export type ServerDeleteBlocker = {
  kind: ServerDeleteBlockerKind
  count: number
  label: string
  /**
   * The rows behind `count`, by name, so the owner can go find them. Present
   * for `environment` (every placed environment, including the ones carrying a
   * database, which the Services tab app list does not show) and for
   * `managed` / `replica` (one entry per database). Capped at 50; `more` says
   * how many are not listed.
   */
  items?: ServerDeleteBlockerItem[]
  more?: number
}

export const SERVER_HAS_BLOCKERS_CODE = 'server_has_blockers'

export const SERVER_HAS_BLOCKERS_ERROR =
  'Cannot delete this server while dependent resources still exist'

export const SERVER_ONLINE_CODE = 'server_online'

export const SERVER_ONLINE_ERROR =
  'Cannot forget leftover resources while this server is still connected'

export const SERVER_SYSTEM_CONTAINERS_ACTIVE_CODE = 'server_system_containers_active'

export const SERVER_SYSTEM_CONTAINERS_ACTIVE_ERROR =
  'This server still has hosting containers marked as running. The host is offline, so use Host is gone → Forget these and delete server.'

export const SERVER_DELETE_PREVIEW_LIST_CAP = 50

export const COLOCATED_SERVER_DELETE_BLOCKED_REASON =
  'The co-located control plane server cannot be deleted'

export function colocatedServerDeleteBlockedReason(): string {
  return COLOCATED_SERVER_DELETE_BLOCKED_REASON
}

/** Revoking the co-located daemon's key would cut the control plane off from its own host. */
export const COLOCATED_SERVER_KEY_REVOKE_BLOCKED_REASON =
  "The co-located control plane server's daemon key cannot be revoked"

export type ForgottenServerResources = {
  containers: number
  networks: number
  ips: number
  environments: number
  members: number
  deployments: number
  slots: number
  copies: number
}

export const BLOCKED_DATABASE_REASON_VALUES = ['only_member', 'primary_here'] as const

export type BlockedDatabaseReason = (typeof BLOCKED_DATABASE_REASON_VALUES)[number]

export const BLOCKED_ENVIRONMENT_REASON_VALUES = ['present_elsewhere'] as const

export type BlockedEnvironmentReason = (typeof BLOCKED_ENVIRONMENT_REASON_VALUES)[number]

export type ServerForgetBlockedDatabase = {
  id: string
  name: string
  reason: BlockedDatabaseReason
}

export type ServerForgetBlockedEnvironment = {
  id: string
  name: string
  projectId: string
  projectName: string
  reason: BlockedEnvironmentReason
  serverNames: string[]
}

export type ServerForgetEnvironment = {
  id: string
  name: string
  projectName: string
}

export type ServerForgetMember = {
  id: string
  databaseName: string
}

export type ServerForgetPlan = {
  blockers: ServerDeleteBlocker[]
  environmentIds: string[]
  memberIds: string[]
  environments: ServerForgetEnvironment[]
  members: ServerForgetMember[]
  blockedDatabases: ServerForgetBlockedDatabase[]
  blockedEnvironments: ServerForgetBlockedEnvironment[]
  blockingBlockers: ServerDeleteBlocker[]
}

export type ServerDeletePreviewContainer = {
  id: string
  name: string
  status: string
  serviceName?: string
}

export type ServerDeleteSystemContainerBlocker = ServerDeletePreviewContainer

export type ServerDeletePreviewNetwork = {
  id: string
  name: string
}

export type ServerDeletePreviewIp = {
  id: string
  address: string
}

export type CappedPreviewList<T> = {
  items: T[]
  more: number
}

export type ServerDeletePreview = {
  online: boolean
  canForget: boolean
  colocated: boolean
  blockers: ServerDeleteBlocker[]
  containers: CappedPreviewList<ServerDeletePreviewContainer>
  /** Hosting-ingress system containers on this server that forget will remove. */
  systemContainers: CappedPreviewList<ServerDeletePreviewContainer>
  networks: CappedPreviewList<ServerDeletePreviewNetwork>
  ips: CappedPreviewList<ServerDeletePreviewIp>
  environments: CappedPreviewList<ServerForgetEnvironment>
  members: CappedPreviewList<ServerForgetMember>
  blockedDatabases: CappedPreviewList<ServerForgetBlockedDatabase>
  blockedEnvironments: CappedPreviewList<ServerForgetBlockedEnvironment>
}

export class ServerOnlineDuringForgetError extends Error {
  readonly code = SERVER_ONLINE_CODE

  constructor() {
    super(SERVER_ONLINE_ERROR)
    this.name = 'ServerOnlineDuringForgetError'
  }
}

export function isServerOnlineDuringForgetError(error: unknown): boolean {
  return error instanceof ServerOnlineDuringForgetError
}

export class ServerHasBlockersDuringForgetError extends Error {
  readonly code = SERVER_HAS_BLOCKERS_CODE
  readonly blockers: ServerDeleteBlocker[]
  readonly blockedDatabases: ServerForgetBlockedDatabase[]
  readonly blockedEnvironments: ServerForgetBlockedEnvironment[]

  constructor(
    blockers: ServerDeleteBlocker[],
    blockedDatabases: ServerForgetBlockedDatabase[],
    blockedEnvironments: ServerForgetBlockedEnvironment[] = []
  ) {
    super(SERVER_HAS_BLOCKERS_ERROR)
    this.name = 'ServerHasBlockersDuringForgetError'
    this.blockers = blockers
    this.blockedDatabases = blockedDatabases
    this.blockedEnvironments = blockedEnvironments
  }
}

export function isServerHasBlockersDuringForgetError(
  error: unknown
): error is ServerHasBlockersDuringForgetError {
  return error instanceof ServerHasBlockersDuringForgetError
}

/**
 * System-workspace ingress rows are torn down by
 * `deleteSystemEnvironmentSubtree` during DELETE — exclude them from the
 * generic blocker scan so stopped system inventory does not 409 the delete.
 */
export function nonSystemContainerWhere(serverId: string) {
  return sql`
      FROM container c
      WHERE c.server_id = ${serverId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM service s
          JOIN environment e ON e.id = s.environment_id
          JOIN project p ON p.id = e.project_id
          JOIN workspace w ON w.id = p.workspace_id
          WHERE s.id = c.service_id
            AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
        )
    `
}

function systemContainerFromWhere(serverId: string) {
  return sql`
      FROM container c
      INNER JOIN service s ON s.id = c.service_id
      INNER JOIN environment e ON e.id = s.environment_id
      INNER JOIN project p ON p.id = e.project_id
      INNER JOIN workspace w ON w.id = p.workspace_id
      WHERE e.server_id = ${serverId}::uuid
        AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
    `
}

type SystemContainerRow = {
  id: string
  name: string
  status: string
  serviceName: string | null
  containerId: string | null
}

/** Whether a system ingress container still blocks server delete. */
export function systemContainerRowBlocksServerDelete(
  row: Pick<SystemContainerRow, 'status' | 'containerId'>,
  serverConnected: boolean
): boolean {
  return (
    isActiveContainerStatus(row.status) &&
    (serverConnected || !(row.status === 'pending' && row.containerId === null))
  )
}

async function listSystemContainersOnServer(
  db: Db,
  serverId: string,
  limit?: number
): Promise<SystemContainerRow[]> {
  const limitSql = limit === undefined ? sql`` : sql`LIMIT ${limit}`
  const rows = await db.execute<SystemContainerRow>(sql`
    SELECT
      c.id,
      c.container_name AS name,
      c.status,
      c.compose_service_name AS "serviceName",
      c.container_id AS "containerId"
    ${systemContainerFromWhere(serverId)}
    ORDER BY c.container_name ASC
    ${limitSql}
  `)
  return rows
}

async function countSystemContainersOnServer(db: Db, serverId: string): Promise<number> {
  const [row] = await db.execute<{ value: number | string }>(sql`
    SELECT count(*)::int AS value
    ${systemContainerFromWhere(serverId)}
  `)
  return Number(row?.value ?? 0)
}

/** System ingress containers that still block delete (unless forget on an offline host). */
export async function listSystemContainersBlockingServerDelete(
  db: Db,
  serverId: string,
  serverConnected: boolean
): Promise<ServerDeleteSystemContainerBlocker[]> {
  const rows = await listSystemContainersOnServer(db, serverId)
  return rows
    .filter((row) => systemContainerRowBlocksServerDelete(row, serverConnected))
    .map((row) => {
      const item: ServerDeleteSystemContainerBlocker = {
        id: row.id,
        name: row.name,
        status: row.status,
      }
      if (row.serviceName) item.serviceName = row.serviceName
      return item
    })
}

function mapSystemContainerPreviewRow(row: SystemContainerRow): ServerDeletePreviewContainer {
  const item: ServerDeletePreviewContainer = {
    id: row.id,
    name: row.name,
    status: row.status,
  }
  if (row.serviceName) item.serviceName = row.serviceName
  return item
}

export function notSystemWorkspace() {
  return ne(workspace.kind, WORKSPACE_KIND_TURBOPANEL)
}

function pushBlocker(
  blockers: ServerDeleteBlocker[],
  kind: ServerDeleteBlockerKind,
  countValue: number
): void {
  if (countValue > 0) {
    blockers.push({
      kind,
      count: countValue,
      label: SERVER_DELETE_BLOCKER_LABELS[kind],
    })
  }
}

export function blockersThatPreventForget(
  blockers: readonly ServerDeleteBlocker[]
): ServerDeleteBlocker[] {
  return blockers.filter((row) => !FORGETTABLE_SERVER_DELETE_BLOCKER_KINDS.has(row.kind))
}

export function canForgetServerResources(
  opts: Readonly<{
    online: boolean
    colocated: boolean
    blockedDatabaseCount: number
    blockedEnvironmentCount: number
  }>
): boolean {
  return (
    !opts.online &&
    !opts.colocated &&
    opts.blockedDatabaseCount === 0 &&
    opts.blockedEnvironmentCount === 0
  )
}

export function blockedDatabaseForgetMessage(name: string, reason: BlockedDatabaseReason): string {
  if (reason === 'only_member') {
    return `Database "${name}" has its only copy on this server. Delete the database first.`
  }
  return `Database "${name}" has its primary copy on this server. Promote another member or delete the database first.`
}

function joinQuotedNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

export function blockedEnvironmentForgetMessage(
  projectName: string,
  environmentName: string,
  serverNames: readonly string[]
): string {
  const label = serverBlockerItemName({
    id: '',
    name: environmentName,
    projectId: '',
    projectName,
    hasDatabase: false,
  })
  const hosts = joinQuotedNames(serverNames.map((name) => `"${name}"`))
  return `App "${label}" also runs on ${hosts}. Move or delete it first.`
}

function managedDisplayName(name: string | null, engine: string): string {
  return name ?? engine
}

function comparePreviewName(a: string, b: string): number {
  return a.localeCompare(b)
}

export function blockedDatabaseReason(hasMemberOnAnotherServer: boolean): BlockedDatabaseReason {
  return hasMemberOnAnotherServer ? 'primary_here' : 'only_member'
}

type ReplicaTouch = {
  id: string
  managedId: string
  serverId: string
  role: string
  databaseName: string
}

type ManagedTouch = {
  id: string
  name: string
  managedServerId: string | null
  environmentServerId: string | null
}

/** One entry per database, deduped by id, named for the owner to find it. */
function databaseItems(
  rows: ReadonlyArray<{ managedId: string; databaseName: string }>
): ServerBlockerDatabaseItem[] {
  const byId = new Map<string, ServerBlockerDatabaseItem>()
  for (const row of rows) {
    if (!byId.has(row.managedId)) {
      byId.set(row.managedId, { id: row.managedId, name: row.databaseName })
    }
  }
  const items = [...byId.values()]
  items.sort((a, b) => comparePreviewName(a.name, b.name) || a.id.localeCompare(b.id))
  return items
}

/** Name the rows behind the counted kinds, capped like every preview list. */
function withBlockerItems(
  blockers: readonly ServerDeleteBlocker[],
  itemsByKind: Partial<Record<ServerDeleteBlockerKind, ServerDeleteBlockerItem[]>>
): ServerDeleteBlocker[] {
  return blockers.map((blocker) => {
    const items = itemsByKind[blocker.kind]
    if (!items || items.length === 0) return blocker
    const capped = capPreviewList(items)
    return { ...blocker, items: capped.items, more: capped.more }
  })
}

function emptyForgetPlan(): ServerForgetPlan {
  return {
    blockers: [],
    environmentIds: [],
    memberIds: [],
    environments: [],
    members: [],
    blockedDatabases: [],
    blockedEnvironments: [],
    blockingBlockers: [],
  }
}

function noteEnvironmentServer(
  byEnvironment: Map<string, Set<string>>,
  environmentId: string,
  otherServerId: string | null,
  forgetServerId: string
): void {
  if (!otherServerId || otherServerId === forgetServerId) return
  const set = byEnvironment.get(environmentId) ?? new Set()
  set.add(otherServerId)
  byEnvironment.set(environmentId, set)
}

/**
 * Servers other than `forgetServerId` that still carry rows under these
 * environments (containers, slots, deployments, storage copies, hosting addresses,
 * binding vars).
 */
export async function listEnvironmentOtherServerIds(
  db: Db,
  environmentIds: readonly string[],
  forgetServerId: string
): Promise<Map<string, Set<string>>> {
  const byEnvironment = new Map<string, Set<string>>()
  if (environmentIds.length === 0) return byEnvironment
  const ids = [...environmentIds]

  const [containerRows, slotRows, deploymentRows, copyRows, ipRows, variableRows] =
    await Promise.all([
      db
        .select({
          environmentId: service.environmentId,
          serverId: container.serverId,
        })
        .from(container)
        .innerJoin(service, eq(service.id, container.serviceId))
        .where(and(inArray(service.environmentId, ids), ne(container.serverId, forgetServerId))),
      db
        .select({ environmentId: slot.environmentId, serverId: slot.serverId })
        .from(slot)
        .where(and(inArray(slot.environmentId, ids), ne(slot.serverId, forgetServerId))),
      db
        .select({
          environmentId: deployment.environmentId,
          serverId: deployment.serverId,
        })
        .from(deployment)
        .where(
          and(inArray(deployment.environmentId, ids), ne(deployment.serverId, forgetServerId))
        ),
      db
        .select({
          environmentId: storage.environmentId,
          serverId: storageCopy.serverId,
        })
        .from(storageCopy)
        .innerJoin(storage, eq(storage.id, storageCopy.storageId))
        .where(
          and(
            inArray(storage.environmentId, ids),
            isNotNull(storage.environmentId),
            ne(storageCopy.serverId, forgetServerId)
          )
        ),
      db
        .select({ environmentId: service.environmentId, serverId: ip.serverId })
        .from(hosting)
        .innerJoin(service, eq(service.id, hosting.serviceId))
        .innerJoin(ip, eq(ip.id, hosting.ipId))
        .where(
          and(
            inArray(service.environmentId, ids),
            isNotNull(ip.serverId),
            ne(ip.serverId, forgetServerId)
          )
        ),
      db
        .select({
          environmentId: service.environmentId,
          serverId: variable.serverId,
        })
        .from(variable)
        .innerJoin(service, eq(service.id, variable.serviceId))
        .where(
          and(
            inArray(service.environmentId, ids),
            isNotNull(variable.bindingId),
            isNotNull(variable.serverId),
            ne(variable.serverId, forgetServerId)
          )
        ),
    ])

  for (const row of containerRows) {
    noteEnvironmentServer(byEnvironment, row.environmentId, row.serverId, forgetServerId)
  }
  for (const row of slotRows) {
    noteEnvironmentServer(byEnvironment, row.environmentId, row.serverId, forgetServerId)
  }
  for (const row of deploymentRows) {
    noteEnvironmentServer(byEnvironment, row.environmentId, row.serverId, forgetServerId)
  }
  for (const row of copyRows) {
    if (row.environmentId) {
      noteEnvironmentServer(byEnvironment, row.environmentId, row.serverId, forgetServerId)
    }
  }
  for (const row of ipRows) {
    noteEnvironmentServer(byEnvironment, row.environmentId, row.serverId, forgetServerId)
  }
  for (const row of variableRows) {
    noteEnvironmentServer(byEnvironment, row.environmentId, row.serverId, forgetServerId)
  }
  return byEnvironment
}

function isDatabaseBlockedOnServer(
  cluster: ManagedTouch,
  replicas: readonly ReplicaTouch[],
  serverId: string
): boolean {
  if (cluster.managedServerId === serverId) return true
  if (cluster.environmentServerId === serverId) return true
  return replicas.some((row) => row.serverId === serverId && row.role === 'primary')
}

function buildForgetClusterMap(
  managedTouches: ReadonlyArray<{
    id: string
    name: string | null
    engine: string
    managedServerId: string | null
    environmentServerId: string | null
  }>,
  replicaTouches: readonly ReplicaTouch[]
): Map<string, ManagedTouch> {
  const clusters = new Map<string, ManagedTouch>()
  for (const row of managedTouches) {
    clusters.set(row.id, {
      id: row.id,
      name: managedDisplayName(row.name, row.engine),
      managedServerId: row.managedServerId,
      environmentServerId: row.environmentServerId,
    })
  }
  for (const row of replicaTouches) {
    if (!clusters.has(row.managedId)) {
      clusters.set(row.managedId, {
        id: row.managedId,
        name: row.databaseName,
        managedServerId: null,
        environmentServerId: null,
      })
    }
  }
  return clusters
}

async function loadReplicasByManagedForForget(
  db: Db,
  clusterIds: string[],
  serverId: string,
  replicaTouches: readonly ReplicaTouch[],
  clusters: ReadonlyMap<string, ManagedTouch>
): Promise<Map<string, ReplicaTouch[]>> {
  const otherReplicas =
    clusterIds.length === 0
      ? []
      : await db
          .select({
            id: replica.id,
            managedId: replica.managedId,
            serverId: replica.serverId,
            role: replica.role,
          })
          .from(replica)
          .where(and(inArray(replica.managedId, clusterIds), ne(replica.serverId, serverId)))

  const replicasByManaged = new Map<string, ReplicaTouch[]>()
  const addReplica = (row: ReplicaTouch) => {
    const list = replicasByManaged.get(row.managedId) ?? []
    list.push(row)
    replicasByManaged.set(row.managedId, list)
  }
  for (const row of replicaTouches) addReplica(row)
  for (const row of otherReplicas) {
    addReplica({
      id: row.id,
      managedId: row.managedId,
      serverId: row.serverId,
      role: row.role,
      databaseName: clusters.get(row.managedId)?.name ?? row.managedId,
    })
  }
  return replicasByManaged
}

function computeForgetBlockedDatabases(
  clusters: ReadonlyMap<string, ManagedTouch>,
  replicasByManaged: ReadonlyMap<string, ReplicaTouch[]>,
  serverId: string
): {
  blockedDatabases: ServerForgetBlockedDatabase[]
  blockedIds: Set<string>
} {
  const blockedDatabases: ServerForgetBlockedDatabase[] = []
  const blockedIds = new Set<string>()
  for (const cluster of clusters.values()) {
    const replicas = replicasByManaged.get(cluster.id) ?? []
    if (!isDatabaseBlockedOnServer(cluster, replicas, serverId)) continue
    const hasMemberOnAnotherServer = replicas.some((row) => row.serverId !== serverId)
    blockedIds.add(cluster.id)
    blockedDatabases.push({
      id: cluster.id,
      name: cluster.name,
      reason: blockedDatabaseReason(hasMemberOnAnotherServer),
    })
  }
  blockedDatabases.sort((a, b) => comparePreviewName(a.name, b.name) || a.id.localeCompare(b.id))
  return { blockedDatabases, blockedIds }
}

function buildPlacedEnvironmentBlockerItems(
  placedEnvironments: ReadonlyArray<{
    id: string
    name: string | null
    projectId: string
    projectName: string | null
    managedId: string | null
  }>
): ServerBlockerEnvironmentItem[] {
  const environmentItems: ServerBlockerEnvironmentItem[] = placedEnvironments.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    projectId: row.projectId,
    projectName: row.projectName ?? '',
    hasDatabase: row.managedId !== null,
  }))
  environmentItems.sort(
    (a, b) =>
      comparePreviewName(a.projectName, b.projectName) ||
      comparePreviewName(a.name, b.name) ||
      a.id.localeCompare(b.id)
  )
  return environmentItems
}

async function resolveForgetBlockedEnvironments(
  db: Db,
  serverId: string,
  forgetCandidateItems: ReadonlyArray<
    Pick<ServerBlockerEnvironmentItem, 'id' | 'name' | 'projectId' | 'projectName'>
  >
): Promise<{
  blockedEnvironments: ServerForgetBlockedEnvironment[]
  blockedEnvironmentIds: Set<string>
}> {
  const otherServersByEnvironment = await listEnvironmentOtherServerIds(
    db,
    forgetCandidateItems.map((row) => row.id),
    serverId
  )

  const blockedEnvironmentIds = new Set<string>()
  const otherServerIds = new Set<string>()
  for (const row of forgetCandidateItems) {
    const serverIdSet = otherServersByEnvironment.get(row.id)
    if (!serverIdSet || serverIdSet.size === 0) continue
    blockedEnvironmentIds.add(row.id)
    for (const id of serverIdSet) otherServerIds.add(id)
  }

  const serverNameById = new Map<string, string>()
  if (otherServerIds.size > 0) {
    const nameRows = await db
      .select({ id: server.id, name: server.name })
      .from(server)
      .where(inArray(server.id, [...otherServerIds]))
    for (const row of nameRows) {
      serverNameById.set(row.id, row.name ?? row.id)
    }
  }

  const blockedEnvironments: ServerForgetBlockedEnvironment[] = []
  for (const row of forgetCandidateItems) {
    const serverIdSet = otherServersByEnvironment.get(row.id)
    if (!serverIdSet || serverIdSet.size === 0) continue
    const serverNames = [...serverIdSet]
      .map((id) => serverNameById.get(id) ?? id)
      .sort((a, b) => comparePreviewName(a, b))
    blockedEnvironments.push({
      id: row.id,
      name: row.name,
      projectId: row.projectId,
      projectName: row.projectName,
      reason: 'present_elsewhere',
      serverNames,
    })
  }
  blockedEnvironments.sort(
    (a, b) =>
      comparePreviewName(a.projectName, b.projectName) ||
      comparePreviewName(a.name, b.name) ||
      a.id.localeCompare(b.id)
  )
  return { blockedEnvironments, blockedEnvironmentIds }
}

function buildForgetDatabaseBlockingBlockers(
  blockedDatabases: readonly ServerForgetBlockedDatabase[],
  blockedIds: ReadonlySet<string>,
  clusters: ReadonlyMap<string, ManagedTouch>,
  serverId: string,
  replicaTouches: readonly ReplicaTouch[]
): ServerDeleteBlocker[] {
  const blockedHere = blockedDatabases.filter((row) => {
    const cluster = clusters.get(row.id)
    return cluster?.managedServerId === serverId || cluster?.environmentServerId === serverId
  })
  const blockedMembers = replicaTouches.filter((row) => blockedIds.has(row.managedId))
  const blockingBlockers: ServerDeleteBlocker[] = []
  if (blockedDatabases.length > 0) {
    pushBlocker(blockingBlockers, 'managed', blockedHere.length)
    pushBlocker(blockingBlockers, 'replica', blockedMembers.length)
  }
  return withBlockerItems(blockingBlockers, {
    managed: blockedHere.map((row) => ({ id: row.id, name: row.name })),
    replica: databaseItems(blockedMembers),
  })
}

/**
 * Decide which app environments and database members a gone host may drop, and
 * which databases still block forget. Callers re-run this inside the delete
 * transaction after locking the server row.
 */
export async function planServerForget(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<ServerForgetPlan> {
  const [serverRow] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!serverRow) return emptyForgetPlan()

  const [placedEnvironments, managedTouches, replicasHere, blockers] = await Promise.all([
    db
      .select({
        id: environment.id,
        name: environment.name,
        projectId: project.id,
        projectName: project.name,
        managedId: managed.id,
      })
      .from(environment)
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .leftJoin(managed, eq(managed.environmentId, environment.id))
      .where(and(eq(environment.serverId, serverId), notSystemWorkspace())),
    db
      .select({
        id: managed.id,
        name: managed.name,
        engine: managed.engine,
        managedServerId: managed.serverId,
        environmentServerId: environment.serverId,
      })
      .from(managed)
      .innerJoin(environment, eq(environment.id, managed.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(
        and(
          notSystemWorkspace(),
          or(eq(managed.serverId, serverId), eq(environment.serverId, serverId))
        )
      ),
    db
      .select({
        id: replica.id,
        managedId: replica.managedId,
        serverId: replica.serverId,
        role: replica.role,
        databaseName: managed.name,
        engine: managed.engine,
      })
      .from(replica)
      .innerJoin(managed, eq(managed.id, replica.managedId))
      .innerJoin(environment, eq(environment.id, managed.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(eq(replica.serverId, serverId), notSystemWorkspace())),
    listServerDeleteBlockers(db, serverId, organizationId),
  ])

  const replicaTouches: ReplicaTouch[] = replicasHere.map((row) => ({
    id: row.id,
    managedId: row.managedId,
    serverId: row.serverId,
    role: row.role,
    databaseName: managedDisplayName(row.databaseName, row.engine),
  }))

  const clusters = buildForgetClusterMap(managedTouches, replicaTouches)
  const replicasByManaged = await loadReplicasByManagedForForget(
    db,
    [...clusters.keys()],
    serverId,
    replicaTouches,
    clusters
  )
  const { blockedDatabases, blockedIds } = computeForgetBlockedDatabases(
    clusters,
    replicasByManaged,
    serverId
  )

  const environmentItems = buildPlacedEnvironmentBlockerItems(placedEnvironments)
  const forgetCandidateItems = environmentItems.filter((row) => !row.hasDatabase)
  const { blockedEnvironments, blockedEnvironmentIds } = await resolveForgetBlockedEnvironments(
    db,
    serverId,
    forgetCandidateItems
  )

  const environments: ServerForgetEnvironment[] = forgetCandidateItems
    .filter((row) => !blockedEnvironmentIds.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      projectName: row.projectName,
    }))

  const members = replicaTouches
    .filter((row) => !blockedIds.has(row.managedId))
    .map((row) => ({ id: row.id, databaseName: row.databaseName }))
  members.sort(
    (a, b) => comparePreviewName(a.databaseName, b.databaseName) || a.id.localeCompare(b.id)
  )

  const placedDatabases = managedTouches
    .filter((row) => row.managedServerId === serverId)
    .map((row) => ({
      managedId: row.id,
      databaseName: managedDisplayName(row.name, row.engine),
    }))

  return {
    blockers: withBlockerItems(blockers, {
      environment: environmentItems,
      managed: databaseItems(placedDatabases),
      replica: databaseItems(replicaTouches),
    }),
    environmentIds: environments.map((row) => row.id),
    memberIds: members.map((row) => row.id),
    environments,
    members,
    blockedDatabases,
    blockedEnvironments,
    blockingBlockers: buildForgetDatabaseBlockingBlockers(
      blockedDatabases,
      blockedIds,
      clusters,
      serverId,
      replicaTouches
    ),
  }
}

function countValue(row: { value: number | string } | undefined): number {
  return Number(row?.value ?? 0)
}

/**
 * Placement and dependency blockers for server delete.
 * Counts leftover rows on `server.id`, excluding system-workspace rows
 * the system-env delete already removes. Forget drops app environments,
 * forgettable members, leftover deployments/slots/copies, then containers,
 * addresses, and networks; blocked databases still 409.
 */
export async function listServerDeleteBlockers(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<ServerDeleteBlocker[]> {
  const [serverRow] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!serverRow) return []

  const [
    [networkCountRow],
    containerCountRows,
    [ipCountRow],
    [environmentCountRow],
    [managedCountRow],
    [replicaCountRow],
    [deploymentCountRow],
    [slotCountRow],
    [copyCountRow],
  ] = await Promise.all([
    db.select({ value: count() }).from(network).where(eq(network.serverId, serverId)),
    db.execute<{ value: number | string }>(sql`
      SELECT count(*)::int AS value
      ${nonSystemContainerWhere(serverId)}
    `),
    db.select({ value: count() }).from(ip).where(eq(ip.serverId, serverId)),
    db
      .select({ value: count() })
      .from(environment)
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(eq(environment.serverId, serverId), notSystemWorkspace())),
    db
      .select({ value: count() })
      .from(managed)
      .innerJoin(environment, eq(environment.id, managed.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(eq(managed.serverId, serverId), notSystemWorkspace())),
    db
      .select({ value: count() })
      .from(replica)
      .innerJoin(managed, eq(managed.id, replica.managedId))
      .innerJoin(environment, eq(environment.id, managed.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(eq(replica.serverId, serverId), notSystemWorkspace())),
    db
      .select({ value: count() })
      .from(deployment)
      .innerJoin(environment, eq(environment.id, deployment.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(eq(deployment.serverId, serverId), notSystemWorkspace())),
    db
      .select({ value: count() })
      .from(slot)
      .innerJoin(environment, eq(environment.id, slot.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(eq(slot.serverId, serverId), notSystemWorkspace())),
    db.select({ value: count() }).from(storageCopy).where(eq(storageCopy.serverId, serverId)),
  ])
  const containerCountRow = containerCountRows[0]

  const blockers: ServerDeleteBlocker[] = []
  pushBlocker(blockers, 'network', countValue(networkCountRow))
  pushBlocker(blockers, 'container', countValue(containerCountRow))
  pushBlocker(blockers, 'ip', countValue(ipCountRow))
  pushBlocker(blockers, 'environment', countValue(environmentCountRow))
  pushBlocker(blockers, 'managed', countValue(managedCountRow))
  pushBlocker(blockers, 'replica', countValue(replicaCountRow))
  pushBlocker(blockers, 'deployment', countValue(deploymentCountRow))
  pushBlocker(blockers, 'slot', countValue(slotCountRow))
  pushBlocker(blockers, 'copy', countValue(copyCountRow))
  return blockers
}

export function capPreviewList<T>(items: T[], total = items.length): CappedPreviewList<T> {
  const capped = items.slice(0, SERVER_DELETE_PREVIEW_LIST_CAP)
  return {
    items: capped,
    more: Math.max(0, total - capped.length),
  }
}

export async function loadServerDeletePreview(
  db: Db,
  serverId: string,
  organizationId: string,
  opts: Readonly<{ online: boolean; colocated: boolean }>
): Promise<ServerDeletePreview> {
  const plan = await planServerForget(db, serverId, organizationId)
  const blockers = plan.blockers
  const containerTotal = blockers.find((row) => row.kind === 'container')?.count ?? 0
  const networkTotal = blockers.find((row) => row.kind === 'network')?.count ?? 0
  const ipTotal = blockers.find((row) => row.kind === 'ip')?.count ?? 0

  const [containerRows, networkRows, ipRows] = await Promise.all([
    containerTotal === 0
      ? Promise.resolve(
          [] as Array<{
            id: string
            name: string
            status: string
            serviceName: string | null
          }>
        )
      : db.execute<{
          id: string
          name: string
          status: string
          serviceName: string | null
        }>(sql`
          SELECT c.id, c.container_name AS name, c.status, c.compose_service_name AS "serviceName"
          ${nonSystemContainerWhere(serverId)}
          ORDER BY c.container_name ASC
          LIMIT ${SERVER_DELETE_PREVIEW_LIST_CAP}
        `),
    db
      .select({ id: network.id, name: network.name })
      .from(network)
      .where(eq(network.serverId, serverId))
      .orderBy(network.name)
      .limit(SERVER_DELETE_PREVIEW_LIST_CAP),
    db
      .select({ id: ip.id, address: ip.address })
      .from(ip)
      .where(eq(ip.serverId, serverId))
      .orderBy(ip.address)
      .limit(SERVER_DELETE_PREVIEW_LIST_CAP),
  ])

  const containers = capPreviewList(
    containerRows.map((row) => {
      const item: ServerDeletePreviewContainer = {
        id: row.id,
        name: row.name,
        status: row.status,
      }
      if (row.serviceName) item.serviceName = row.serviceName
      return item
    }),
    containerTotal
  )

  const systemContainerTotal = await countSystemContainersOnServer(db, serverId)
  const systemContainerRows =
    systemContainerTotal === 0
      ? []
      : await listSystemContainersOnServer(db, serverId, SERVER_DELETE_PREVIEW_LIST_CAP)
  const systemContainers = capPreviewList(
    systemContainerRows.map(mapSystemContainerPreviewRow),
    systemContainerTotal
  )

  const networks = capPreviewList(
    networkRows.map((row) => ({ id: row.id, name: row.name ?? '' })),
    networkTotal
  )
  const ips = capPreviewList(
    ipRows.map((row) => ({ id: row.id, address: String(row.address) })),
    ipTotal
  )

  return {
    online: opts.online,
    canForget: canForgetServerResources({
      online: opts.online,
      colocated: opts.colocated,
      blockedDatabaseCount: plan.blockedDatabases.length,
      blockedEnvironmentCount: plan.blockedEnvironments.length,
    }),
    colocated: opts.colocated,
    blockers,
    containers,
    systemContainers,
    networks,
    ips,
    environments: capPreviewList(plan.environments),
    members: capPreviewList(plan.members),
    blockedDatabases: capPreviewList(plan.blockedDatabases),
    blockedEnvironments: capPreviewList(plan.blockedEnvironments),
  }
}

/**
 * Query `forgetResources=true` (same style as managed `detach=true`) or an
 * explicit JSON body `{ forgetResources: true }`. Anything else is off.
 */
export function parseForgetResourcesFlag(
  queryValue: string | undefined,
  body: Record<string, unknown>
): boolean {
  return queryValue === 'true' || body.forgetResources === true
}

export function serverOnlineForgetBlockedResponse(c: Context): Response {
  return c.json(
    {
      error: SERVER_ONLINE_ERROR,
      code: SERVER_ONLINE_CODE,
    },
    409
  )
}

export function serverSystemContainersDeleteBlockedResponse(
  c: Context,
  opts: Readonly<{
    serverConnected: boolean
    containers: readonly ServerDeleteSystemContainerBlocker[]
  }>
): Response {
  const blockers = [...opts.containers]
  if (blockers.length === 0) {
    throw new Error('serverSystemContainersDeleteBlockedResponse requires blockers')
  }
  if (opts.serverConnected) {
    return c.json(
      {
        error: HIERARCHY_DELETE_HAS_CHILDREN_ERROR,
        code: HIERARCHY_DELETE_HAS_CHILDREN_CODE,
        blockers,
      },
      409
    )
  }
  return c.json(
    {
      error: SERVER_SYSTEM_CONTAINERS_ACTIVE_ERROR,
      code: SERVER_SYSTEM_CONTAINERS_ACTIVE_CODE,
      blockers,
    },
    409
  )
}

export function serverDeleteBlockersResponse(
  c: Context,
  blockers: ServerDeleteBlocker[],
  blockedDatabases?: readonly ServerForgetBlockedDatabase[],
  blockedEnvironments?: readonly ServerForgetBlockedEnvironment[]
): Response {
  const cappedDatabases =
    blockedDatabases === undefined
      ? undefined
      : blockedDatabases.slice(0, SERVER_DELETE_PREVIEW_LIST_CAP)
  const cappedEnvironments =
    blockedEnvironments === undefined
      ? undefined
      : blockedEnvironments.slice(0, SERVER_DELETE_PREVIEW_LIST_CAP)
  return c.json(
    {
      error: SERVER_HAS_BLOCKERS_ERROR,
      code: SERVER_HAS_BLOCKERS_CODE,
      blockers,
      ...(cappedDatabases && cappedDatabases.length > 0
        ? { blockedDatabases: cappedDatabases }
        : {}),
      ...(cappedEnvironments && cappedEnvironments.length > 0
        ? { blockedEnvironments: cappedEnvironments }
        : {}),
    },
    409
  )
}

/**
 * Re-read `is_connected` under a row lock immediately before forgetting so a
 * reconnect that won the race after the live-snapshot preflight still 409s.
 */
export async function assertServerOfflineForForget(tx: Db, serverId: string): Promise<void> {
  const [locked] = await tx
    .select({ isConnected: server.isConnected })
    .from(server)
    .where(eq(server.id, serverId))
    .for('update')
    .limit(1)
  if (locked?.isConnected) {
    throw new ServerOnlineDuringForgetError()
  }
}

async function lockForgetCandidateEnvironmentsForUpdate(
  tx: Db,
  environmentIds: readonly string[]
): Promise<void> {
  if (environmentIds.length === 0) return
  const ordered = [...environmentIds].sort((a, b) => a.localeCompare(b))
  await tx
    .select({ id: environment.id })
    .from(environment)
    .where(inArray(environment.id, ordered))
    .orderBy(asc(environment.id))
    .for('update')
}

async function loadForgetEnvironmentRecheckCandidates(
  tx: Db,
  environmentIds: readonly string[]
): Promise<Array<Pick<ServerBlockerEnvironmentItem, 'id' | 'name' | 'projectId' | 'projectName'>>> {
  if (environmentIds.length === 0) return []
  const rows = await tx
    .select({
      id: environment.id,
      name: environment.name,
      projectId: project.id,
      projectName: project.name,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(inArray(environment.id, [...environmentIds]))
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    projectId: row.projectId,
    projectName: row.projectName ?? '',
  }))
}

async function purgeRemainingPlacedEnvironmentsInTx(
  tx: Db,
  serverId: string,
  organizationId: string
): Promise<void> {
  const rows = await tx
    .select({ id: environment.id })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(
      and(
        eq(environment.serverId, serverId),
        eq(project.organizationId, organizationId),
        notSystemWorkspace()
      )
    )
  const ordered = rows.map((row) => row.id).sort((a, b) => a.localeCompare(b))
  await forEachSequential(ordered, async (environmentId) => {
    await dropEnvironmentSubtreeInTx(tx, [environmentId], { serverId })
  })
}

async function dropForgetEnvironmentsInTx(
  tx: Db,
  serverId: string,
  environments: readonly ServerForgetEnvironment[],
  blockingBlockers: ServerDeleteBlocker[],
  blockedDatabases: readonly ServerForgetBlockedDatabase[]
): Promise<{ containers: number; environmentCount: number }> {
  const orderedEnvironmentIds = [...environments.map((row) => row.id)].sort((a, b) =>
    a.localeCompare(b)
  )
  await lockForgetCandidateEnvironmentsForUpdate(tx, orderedEnvironmentIds)

  let droppedContainers = 0
  await forEachSequential(orderedEnvironmentIds, async (environmentId) => {
    const candidates = await loadForgetEnvironmentRecheckCandidates(tx, [environmentId])
    const { blockedEnvironments } = await resolveForgetBlockedEnvironments(tx, serverId, candidates)
    if (blockedEnvironments.length > 0) {
      throw new ServerHasBlockersDuringForgetError(
        blockingBlockers,
        capPreviewList([...blockedDatabases]).items,
        capPreviewList(blockedEnvironments).items
      )
    }
    const dropped = await dropEnvironmentSubtreeInTx(tx, [environmentId], { serverId })
    droppedContainers += dropped.containers
  })
  return {
    containers: droppedContainers,
    environmentCount: orderedEnvironmentIds.length,
  }
}

export async function forgetServerOwnedResources(
  tx: Db,
  serverId: string,
  organizationId: string
): Promise<ForgottenServerResources> {
  const plan = await planServerForget(tx, serverId, organizationId)
  if (plan.blockedDatabases.length > 0 || plan.blockedEnvironments.length > 0) {
    throw new ServerHasBlockersDuringForgetError(
      plan.blockingBlockers,
      capPreviewList(plan.blockedDatabases).items,
      capPreviewList(plan.blockedEnvironments).items
    )
  }

  const dropped = await dropForgetEnvironmentsInTx(
    tx,
    serverId,
    plan.environments,
    plan.blockingBlockers,
    plan.blockedDatabases
  )

  await purgeRemainingPlacedEnvironmentsInTx(tx, serverId, organizationId)

  const memberIds = plan.members.map((row) => row.id)
  if (memberIds.length > 0) {
    await tx.delete(replica).where(inArray(replica.id, memberIds))
  }
  const deploymentRows = await tx
    .delete(deployment)
    .where(eq(deployment.serverId, serverId))
    .returning({ id: deployment.id })
  const slotRows = await tx
    .delete(slot)
    .where(eq(slot.serverId, serverId))
    .returning({ id: slot.id })
  const copyRows = await tx
    .delete(storageCopy)
    .where(eq(storageCopy.serverId, serverId))
    .returning({ id: storageCopy.id })

  const containerRows = await tx.execute<{ id: string }>(sql`
    SELECT c.id
    ${nonSystemContainerWhere(serverId)}
  `)
  const containerIds = containerRows.map((row) => row.id)
  if (containerIds.length > 0) {
    await tx.delete(container).where(inArray(container.id, containerIds))
  }
  const ipRows = await tx.delete(ip).where(eq(ip.serverId, serverId)).returning({ id: ip.id })
  const networkRows = await tx
    .delete(network)
    .where(eq(network.serverId, serverId))
    .returning({ id: network.id })
  await purgeServerFabricForeignKeys(tx, serverId)
  return {
    containers: dropped.containers + containerIds.length,
    networks: networkRows.length,
    ips: ipRows.length,
    environments: dropped.environmentCount,
    members: memberIds.length,
    deployments: deploymentRows.length,
    slots: slotRows.length,
    copies: copyRows.length,
  }
}
