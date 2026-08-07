import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { requireStringField } from '../shared.ts'
import { USERNAME_RE } from '../principals/store.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedRowOptions } from './options.ts'

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
    '/environments/:id/managed/databases',
    '/environments/:id/managed/databases/:databaseName',
    '/environments/:id/managed/status',
    '/environments/:id/managed/logs',
    '/environments/:id/managed/backups',
    '/environments/:id/managed/backups/:backupId',
    '/environments/:id/managed/backups/:backupId/restore',
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
      ...(typeof exposureRaw.publishedPort === 'number'
        ? { publishedPort: exposureRaw.publishedPort }
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
): { username: string; databases: string[]; privileges: string[] } | Response {
  const username = requireStringField(c, body, 'username')
  if (username instanceof Response) return username

  const { pattern, maxLength } = ctx.spec.userOperations.identifier
  if (
    !USERNAME_RE.test(username) ||
    !pattern.test(username) ||
    username.length > maxLength ||
    username === ctx.spec.rootUsername
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
