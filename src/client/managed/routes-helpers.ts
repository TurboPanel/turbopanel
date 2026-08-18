import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { server } from '../../lib/db/schema.ts'
import { BadRequestError, parseDisplayName, requireStringField } from '../shared.ts'
import { USERNAME_RE } from '../principals/store.ts'
import { resolveHostingBindAddress } from '../environments/deploy-prepare.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedRowOptions } from './options.ts'

/**
 * Client connection endpoint for managed engines goes through the shared
 * ProxySQL listener (protocol port 15432/16306), not a per-service published port.
 */
export async function resolveManagedConnectionListener(
  db: Db,
  params: Readonly<{
    serverId: string
    protocolPort: number
    exposure: ManagedSettings['exposure']
  }>,
): Promise<{ host: string; port: number } | null> {
  const bindScope = params.exposure.enabled
    ? (params.exposure.bind ?? 'public')
    : 'local'

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId: params.serverId,
    options: { bind: bindScope },
    ipId: null,
  })
  if (
    typeof bindResolved === 'object' &&
    bindResolved?.kind === 'datacenter_ip_required'
  ) {
    return null
  }

  if (typeof bindResolved === 'string') {
    return { host: bindResolved, port: params.protocolPort }
  }

  // Public bind with no pin — prefer the server hostname as a stable operator dial.
  const [row] = await db
    .select({ hostname: server.hostname })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1)
  const hostname = row?.hostname?.trim()
  if (!hostname) return null
  return { host: hostname, port: params.protocolPort }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function managedSessionPaths(): string[] {
  return [
    '/environments/:id/managed',
    '/environments/:id/managed/apply',
    '/environments/:id/managed/lifecycle',
    '/environments/:id/managed/root-password',
    '/environments/:id/managed/users',
    '/environments/:id/managed/users/:principalId',
    '/environments/:id/managed/users/:principalId/password',
    '/environments/:id/managed/databases',
    '/environments/:id/managed/databases/:databaseName',
    '/environments/:id/managed/status',
    '/environments/:id/managed/logs',
    '/environments/:id/managed/backups',
    '/environments/:id/managed/backups/:backupId',
    '/environments/:id/managed/backups/:backupId/restore',
    '/environments/:id/managed/members',
    '/environments/:id/managed/members/:memberId',
    '/environments/:id/managed/members/:memberId/promote',
    '/organizations/:id/managed',
  ]
}

export function mergeCreateSettings(
  spec: {
    defaultSettings: ManagedSettings
    parseSettings: (v: unknown) => ManagedSettings | null
  },
  body: Record<string, unknown>,
): ManagedSettings | null {
  const base = spec.parseSettings(spec.defaultSettings)
  if (!base) return null

  const exposureRaw = body.exposure
  if (!isPlainObject(exposureRaw)) {
    return base
  }

  const merged = {
    ...base,
    exposure: {
      ...base.exposure,
      ...(typeof exposureRaw.enabled === 'boolean'
        ? { enabled: exposureRaw.enabled }
        : {}),
      ...(exposureRaw.bind === 'public' ||
          exposureRaw.bind === 'datacenter' ||
          exposureRaw.bind === 'local'
        ? { bind: exposureRaw.bind }
        : {}),
    },
  }
  return spec.parseSettings(merged)
}

export function readInitialDatabase(spec: {
  parseSettings: (v: unknown) => ManagedSettings | null
  defaultSettings: ManagedSettings
}): string {
  const parsed = spec.parseSettings(spec.defaultSettings)
  if (parsed && typeof parsed === 'object' && 'initialDatabase' in parsed) {
    const initial = (parsed as Record<string, unknown>).initialDatabase
    if (typeof initial === 'string' && initial.length > 0) {
      return initial
    }
  }
  return 'postgres'
}

/**
 * Display-only server id for serialization/read paths — returns `null` when
 * neither `managed.server_id` nor the environment's placement is known.
 */
export function resolveManagedServerId(
  managedRow: { serverId: string | null },
  fallbackServerId: string | null,
): string | null {
  return managedRow.serverId ?? fallbackServerId
}

export function principalMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>
  }
  return {}
}

export function isManagedRootPrincipal(metadata: unknown): boolean {
  return principalMetadata(metadata).managedRoot === true
}

/** Replication principal is platform-managed — never listed as a client login. */
export function isManagedReplicationPrincipal(metadata: unknown): boolean {
  return principalMetadata(metadata).managedReplication === true
}

/**
 * Lag gate for promote. Returns null when healthy enough to promote, or a
 * typed 409 error code when the operator should not promote without `force`.
 */
export function evaluateManagedPromoteLagGate(
  replication: unknown,
  nowMs: number = Date.now(),
  options?: {
    /** Max age of the observation (default 120s). */
    staleMs?: number
    /** Max replay lag in bytes (default 64 MiB). */
    maxLagBytes?: number
    /** Max replay lag in seconds (default 30). */
    maxLagSeconds?: number
  },
):
  | null
  | 'managed_replica_not_streaming'
  | 'managed_replica_lagging'
  | 'managed_replica_health_stale' {
  const staleMs = options?.staleMs ?? 120_000
  const maxLagBytes = options?.maxLagBytes ?? 64 * 1024 * 1024
  const maxLagSeconds = options?.maxLagSeconds ?? 30

  if (
    typeof replication !== 'object' ||
    replication === null ||
    Array.isArray(replication)
  ) {
    return 'managed_replica_not_streaming'
  }
  const r = replication as Record<string, unknown>
  if (typeof r.state !== 'string' || r.state.length === 0) {
    return 'managed_replica_not_streaming'
  }
  if (r.state !== 'streaming') {
    return 'managed_replica_not_streaming'
  }
  if (typeof r.observedAt !== 'string' || r.observedAt.length === 0) {
    return 'managed_replica_health_stale'
  }
  const observedMs = Date.parse(r.observedAt)
  if (!Number.isFinite(observedMs) || nowMs - observedMs > staleMs) {
    return 'managed_replica_health_stale'
  }
  if (
    typeof r.lagBytes === 'number' &&
    Number.isFinite(r.lagBytes) &&
    r.lagBytes > maxLagBytes
  ) {
    return 'managed_replica_lagging'
  }
  if (
    typeof r.lagSeconds === 'number' &&
    Number.isFinite(r.lagSeconds) &&
    r.lagSeconds > maxLagSeconds
  ) {
    return 'managed_replica_lagging'
  }
  return null
}

export function serializeManagedUser(
  row: {
    id: string
    username: string
    metadata: unknown
    createdAt: string
  },
) {
  const meta = principalMetadata(row.metadata)
  const databases = Array.isArray(meta.databases)
    ? meta.databases.filter((entry): entry is string => typeof entry === 'string')
    : []
  const privileges = Array.isArray(meta.privileges)
    ? meta.privileges.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    id: row.id,
    username: row.username,
    databases,
    privileges,
    createdAt: row.createdAt,
  }
}

export function serializeContainerRow(row: {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serverId: row.serverId,
    containerId: row.containerId,
    containerName: row.containerName,
    status: row.status,
    role: row.role,
    composeServiceName: row.composeServiceName,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function parseManagedUserCreateFields(
  c: Context<AppEnv>,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions,
  /** Persisted cluster root username when known; falls back to spec preference. */
  rootUsername?: string,
): { username: string; databases: string[]; privileges: string[] } | Response {
  const username = requireStringField(c, body, 'username')
  if (username instanceof Response) return username

  const effectiveRoot = rootUsername ?? ctx.spec.rootUsername
  const { pattern, maxLength } = ctx.spec.userOperations.identifier
  if (
    !USERNAME_RE.test(username) ||
    !pattern.test(username) ||
    username.length > maxLength ||
    username === effectiveRoot
  ) {
    return c.json({ error: 'Invalid username' }, 400)
  }

  if (!Array.isArray(body.databases) || body.databases.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const databases = body.databases.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  if (
    databases.length === 0 ||
    databases.length !== body.databases.length ||
    !databases.every((name) => options.databases.includes(name))
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const privileges = Array.isArray(body.privileges)
    ? body.privileges.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (
    Array.isArray(body.privileges) &&
    privileges.length !== body.privileges.length
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const allowedPrivileges = new Set<string>(ctx.spec.userOperations.privileges)
  if (!privileges.every((entry) => allowedPrivileges.has(entry))) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { username, databases, privileges }
}

export type ManagedRouteValidationError = {
  ok: false
  error: string
  status: 400 | 409 | 422
}

export type ManagedLifecycleAction = 'start' | 'stop' | 'restart'

export function parseManagedLifecycleAction(
  body: Record<string, unknown>,
):
  | { ok: true; action: ManagedLifecycleAction }
  | ManagedRouteValidationError {
  const action = body.action
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, action }
}

/**
 * Display-name parse for managed create — mirrors {@link parseDisplayName}
 * but returns a typed validation error instead of throwing.
 */
export function parseManagedCreateDisplayName(
  body: Record<string, unknown>,
):
  | { ok: true; displayName: string | null }
  | ManagedRouteValidationError {
  try {
    return { ok: true, displayName: parseDisplayName(body) }
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    throw error
  }
}

/**
 * Merge PATCH `settings` onto current managed settings and re-validate via
 * the engine spec. Returns `null` when the merged shape is invalid.
 */
export function mergeManagedPatchSettings(
  spec: {
    parseSettings: (v: unknown) => ManagedSettings | null
  },
  currentSettings: ManagedSettings,
  body: Record<string, unknown>,
): ManagedSettings | null {
  return spec.parseSettings({
    ...currentSettings,
    ...(isPlainObject(body.settings) ? body.settings : {}),
  })
}

export function validateManagedDatabaseCreateName(
  name: string,
  databases: readonly string[],
  identifier: { pattern: RegExp; maxLength: number },
): ManagedRouteValidationError | null {
  if (!identifier.pattern.test(name) || name.length > identifier.maxLength) {
    return { ok: false, error: 'Invalid database name', status: 400 }
  }
  if (databases.includes(name)) {
    return { ok: false, error: 'database_exists', status: 409 }
  }
  return null
}

/** Narrow the false status union — delete-not-found uses HTTP 404. */
export type ManagedDatabaseDeleteError =
  | { ok: false; error: 'Not found'; status: 404 }
  | { ok: false; error: 'cannot_drop_initial_database'; status: 409 }

export function evaluateManagedDatabaseDelete(
  databaseName: string,
  databases: readonly string[],
  initialDatabase: string,
): ManagedDatabaseDeleteError | null {
  if (!databases.includes(databaseName)) {
    return { ok: false, error: 'Not found', status: 404 }
  }
  if (databaseName === initialDatabase) {
    return { ok: false, error: 'cannot_drop_initial_database', status: 409 }
  }
  return null
}

export function nextDatabasesAfterCreate(
  databases: readonly string[],
  name: string,
): string[] {
  return [...databases, name].sort((a, b) => a.localeCompare(b))
}

export function nextDatabasesAfterDelete(
  databases: readonly string[],
  databaseName: string,
): string[] {
  return databases.filter((entry) => entry !== databaseName)
}

export function parsePromoteForce(body: Record<string, unknown>): boolean {
  return body.force === true
}

export function parseMemberReadEligibleCreate(
  body: Record<string, unknown>,
): boolean {
  return body.readEligible === true
}

export function parseReplicaClassCreate(
  body: Record<string, unknown>,
): { ok: true; replicaClass: 'failover' | 'read' } | ManagedRouteValidationError {
  if (body.replicaClass === undefined) {
    return { ok: true, replicaClass: 'failover' }
  }
  if (body.replicaClass === 'failover' || body.replicaClass === 'read') {
    return { ok: true, replicaClass: body.replicaClass }
  }
  return { ok: false, error: 'Invalid request', status: 400 }
}

export function parseMemberReadEligiblePatch(
  body: Record<string, unknown>,
): { ok: true; readEligible: boolean } | ManagedRouteValidationError {
  if (typeof body.readEligible !== 'boolean') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, readEligible: body.readEligible }
}

export type MemberPatchFields = {
  readEligible?: boolean
  replicaClass?: 'failover' | 'read'
}

export function parseMemberPatch(
  body: Record<string, unknown>,
): ({ ok: true } & MemberPatchFields) | ManagedRouteValidationError {
  const hasReadEligible = Object.hasOwn(body, 'readEligible')
  const hasReplicaClass = Object.hasOwn(body, 'replicaClass')
  if (!hasReadEligible && !hasReplicaClass) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const patch: { ok: true } & MemberPatchFields = { ok: true }
  if (hasReadEligible) {
    if (typeof body.readEligible !== 'boolean') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.readEligible = body.readEligible
  }
  if (hasReplicaClass) {
    if (body.replicaClass !== 'failover' && body.replicaClass !== 'read') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.replicaClass = body.replicaClass
  }
  return patch
}

/**
 * Hard-delete is safe when the cluster never reached a destroyable live
 * state (or has no placement pin).
 */
export function canHardDeleteManaged(
  status: string | null | undefined,
  serverId: string | null | undefined,
): boolean {
  return status === 'stopped' ||
    status === 'failed' ||
    status === 'provisioning' ||
    !serverId
}

export type ReplicaPlacementPrecheckError =
  | { ok: false; error: 'managed_member_exists'; status: 409 }

/**
 * Pure prechecks before datacenter / private-endpoint / online probes.
 */
export function evaluateReplicaPlacementPrechecks(
  members: ReadonlyArray<{ serverId: string; role: string }>,
  serverId: string,
): ReplicaPlacementPrecheckError | null {
  if (members.some((m) => m.serverId === serverId)) {
    return { ok: false, error: 'managed_member_exists', status: 409 }
  }
  return null
}

export function replicaEndpointPurpose(
  replicaClass: 'failover' | 'read',
): 'failover-replication' | 'read-replication' {
  return replicaClass === 'read' ? 'read-replication' : 'failover-replication'
}

export type FailoverReplicaTransportError = {
  kind: 'failover_replica_requires_datacenter_transport'
}

/** Failover replicas may only use local or datacenter transport — never fabric/public. */
export function assertFailoverReplicaTransportAllowed(
  transport: 'local' | 'datacenter' | 'fabric' | 'public',
): FailoverReplicaTransportError | null {
  if (transport === 'fabric' || transport === 'public') {
    return { kind: 'failover_replica_requires_datacenter_transport' }
  }
  return null
}

/**
 * Whether placement still needs a ready datacenter CIDR after transport resolve.
 * Failover always needs a datacenter (fabric/public are rejected earlier).
 * Read replicas skip the CIDR check on fabric/public (already overlay/TLS).
 */
export function replicaPlacementNeedsDatacenter(
  transport: 'local' | 'datacenter' | 'fabric' | 'public',
  replicaClass: 'failover' | 'read',
): boolean {
  if (replicaClass === 'failover') {
    return true
  }
  return transport !== 'fabric' && transport !== 'public'
}

export function evaluatePromoteMemberRole(
  role: string,
): ManagedRouteValidationError | null {
  if (role !== 'replica') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return null
}

export function evaluatePromoteReplicaClass(
  replicaClass: string | null,
  force: boolean,
): { ok: false; error: 'managed_replica_not_promotable'; status: 422 } | null {
  if (force) return null
  if (replicaClass !== 'failover') {
    return { ok: false, error: 'managed_replica_not_promotable', status: 422 }
  }
  return null
}

export type ReplicaClassConversionError =
  | { ok: false; error: 'Invalid request'; status: 400 }
  | { ok: false; error: 'failover_replica_requires_datacenter_transport'; status: 422 }

/**
 * Class conversion: failover → read always allowed; read → failover requires
 * shared-datacenter placement to already have succeeded.
 */
export function evaluateReplicaClassConversion(
  member: Readonly<{ role: string; replicaClass: string | null }>,
  targetClass: 'failover' | 'read',
  placementOk: boolean,
): ReplicaClassConversionError | null {
  if (member.role !== 'replica') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (targetClass === 'read') return null
  if (!placementOk) {
    return {
      ok: false,
      error: 'failover_replica_requires_datacenter_transport',
      status: 422,
    }
  }
  return null
}

export type ManagedUserRotateGuardError =
  | { ok: false; error: 'use_root_password_route'; status: 400 }
  | { ok: false; error: 'cannot_rotate_replication_user'; status: 400 }

export function evaluateManagedUserRotateGuard(
  metadata: unknown,
): ManagedUserRotateGuardError | null {
  if (isManagedRootPrincipal(metadata)) {
    return { ok: false, error: 'use_root_password_route', status: 400 }
  }
  if (isManagedReplicationPrincipal(metadata)) {
    return { ok: false, error: 'cannot_rotate_replication_user', status: 400 }
  }
  return null
}

export function evaluateManagedUserDropGuard(
  metadata: unknown,
): { ok: false; error: 'cannot_drop_root_user'; status: 400 } | null {
  if (isManagedRootPrincipal(metadata)) {
    return { ok: false, error: 'cannot_drop_root_user', status: 400 }
  }
  return null
}

/**
 * Promote lag gate for HTTP — `force` bypasses. Returns the 409 error code
 * when blocked, else `null`.
 */
export function evaluatePromoteLagHttpGate(
  replication: unknown,
  force: boolean,
  nowMs?: number,
):
  | null
  | 'managed_replica_not_streaming'
  | 'managed_replica_lagging'
  | 'managed_replica_health_stale' {
  if (force) return null
  return evaluateManagedPromoteLagGate(replication, nowMs)
}

export type QueuedCommandFanoutRow = {
  commandId?: string
  serverId?: string
}

/**
 * Prefer the first fan-out row that already has a command id (primary), else
 * the first row — matches every managed enqueue response.
 */
export function pickPrimaryCommandResult<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
): T | undefined {
  return enqueued.find((r) => r.commandId) ?? enqueued[0]
}

export function buildQueuedFanoutResponse<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
  fallbackServerId: string,
): {
  ok: true
  results: readonly T[]
  commandId: string | undefined
  serverId: string
  status: 'queued'
} {
  const primary = pickPrimaryCommandResult(enqueued)
  return {
    ok: true as const,
    results: enqueued,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? fallbackServerId,
    status: 'queued' as const,
  }
}

export function buildEmptyManagedDetailResponse(rootUsername: string) {
  return {
    managed: null,
    connection: null,
    settings: null,
    server: null,
    rootUsername,
    members: [] as const,
  }
}

export function sortManagedBackupsDesc<T extends { createdAt: string }>(
  backups: readonly T[],
): T[] {
  return [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function findManagedBackupById<T extends { id: string }>(
  backups: readonly T[],
  backupId: string,
): T | undefined {
  return backups.find((entry) => entry.id === backupId)
}

/**
 * Status endpoint member row — same identity field as detail (`id`), not
 * `memberId`. The UI merges status onto detail by id; a different key
 * produced a ghost second "primary" with no React key.
 */
export function buildStatusMemberView(serialized: {
  id: string
  serverId: string
  role: string
  replicaClass?: string | null
  status: string | null
  replicationTransport: string | null
  privatePort: number | null
  replication?: unknown
}) {
  return {
    id: serialized.id,
    serverId: serialized.serverId,
    role: serialized.role,
    replicaClass: serialized.replicaClass ?? null,
    status: serialized.status,
    replicationTransport: serialized.replicationTransport,
    privatePort: serialized.privatePort,
    ...(serialized.replication !== undefined
      ? { replication: serialized.replication }
      : {}),
  }
}

export function buildManagedDestroyQueuedResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    destroyCommandId: params.commandId,
    commandId: params.commandId,
    serverId: params.serverId,
    status: 'queued' as const,
  }
}

export function buildManagedDeleteHardResponse() {
  return { ok: true as const, deleted: true as const }
}

export function buildManagedDeleteQueuedResponse<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
  fallbackServerId: string,
) {
  const primary = pickPrimaryCommandResult(enqueued)
  return {
    ok: true as const,
    deleted: false as const,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? fallbackServerId,
    results: enqueued,
  }
}

export function buildFencePromotePendingResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    serverId: params.serverId,
    status: 'queued' as const,
    fenceCommandId: params.commandId,
    promotePending: true as const,
  }
}

export function buildPromoteQueuedResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    status: 'queued' as const,
    serverId: params.serverId,
  }
}

type OrgManagedListEntryExtras = {
  engineDisplayName: string | null
  environmentDisplayName: string | null
  projectId: string
  projectDisplayName: string | null
  workspaceId: string
  workspaceDisplayName: string | null
  serverDisplayName: string | null
  members: unknown[]
}

export function buildOrgManagedListEntry<T extends Record<string, unknown>>(
  params: OrgManagedListEntryExtras & { serializedRow: T },
): T & OrgManagedListEntryExtras {
  return {
    ...params.serializedRow,
    engineDisplayName: params.engineDisplayName,
    environmentDisplayName: params.environmentDisplayName,
    projectId: params.projectId,
    projectDisplayName: params.projectDisplayName,
    workspaceId: params.workspaceId,
    workspaceDisplayName: params.workspaceDisplayName,
    serverDisplayName: params.serverDisplayName,
    members: params.members,
  }
}
