import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { server } from '../../lib/db/schema.ts'
import { requireStringField } from '../shared.ts'
import { USERNAME_RE } from '../principals/store.ts'
import { resolveHostingBindAddress } from '../environments/deploy-prepare.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedRowOptions } from './options.ts'

/**
 * Client connection endpoint for managed engines goes through the shared
 * ProxySQL listener (protocol port 5432/3306), not a per-service published port.
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
