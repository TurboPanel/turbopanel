import { and, eq, isNotNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { generatePassword } from '../../generate-secret.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { setPrincipalPassword } from '../principals/store.ts'
import { managed, principal, server } from '../../lib/db/schema.ts'
import { assertCanManageOr403, getOrgId, parseJsonBody } from '../shared.ts'

const MANAGED_ENGINES = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'clickhouse'])
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9 ._-]+$/

type ManagedEngine = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'clickhouse'

type ManagedMetadata = {
  engine: ManagedEngine
  status: 'provisioning' | 'ready' | 'failed'
  rootPrincipalId?: string
  host?: string
  port?: number
  error?: string
}

function parseManagedMetadata(value: unknown): ManagedMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const engine = record.engine
  const status = record.status
  if (
    typeof engine !== 'string' ||
    !MANAGED_ENGINES.has(engine) ||
    typeof status !== 'string' ||
    (status !== 'provisioning' && status !== 'ready' && status !== 'failed')
  ) {
    return null
  }
  return {
    engine: engine as ManagedEngine,
    status,
    ...(typeof record.rootPrincipalId === 'string'
      ? { rootPrincipalId: record.rootPrincipalId }
      : {}),
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

function defaultRootUsername(engine: ManagedEngine): string {
  if (engine === 'postgres') return 'postgres'
  if (engine === 'mysql' || engine === 'mariadb') return 'root'
  if (engine === 'redis') return 'default'
  return 'default'
}

function defaultProvider(engine: ManagedEngine): string {
  if (engine === 'postgres') return 'postgres'
  if (engine === 'mysql' || engine === 'mariadb') return 'mysql'
  if (engine === 'redis') return 'redis'
  return 'postgres'
}

function defaultPort(engine: ManagedEngine): number {
  switch (engine) {
    case 'postgres':
      return 5432
    case 'mysql':
    case 'mariadb':
      return 3306
    case 'redis':
      return 6379
    case 'clickhouse':
      return 8123
  }
}

function serializeManagedRow(row: {
  id: string
  serverId: string | null
  displayName: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
  serverDisplayName: string | null
}) {
  const meta = parseManagedMetadata(row.metadata)
  return {
    id: row.id,
    serverId: row.serverId,
    serverDisplayName: row.serverDisplayName,
    displayName: row.displayName,
    engine: meta?.engine ?? null,
    status: meta?.status ?? 'provisioning',
    host: meta?.host ?? null,
    port: meta?.port ?? null,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function registerManagedServiceRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/managed-services', createSessionMiddleware(opts.secrets))
  router.use('/managed-services/:id', createSessionMiddleware(opts.secrets))

  router.get('/managed-services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanOr403(
      c,
      'organization:manage',
      'organization',
      organizationId,
    )
    if (denied) return denied

    const serverIdFilter = c.req.query('serverId')?.trim()

    const conditions = [
      isNotNull(managed.serverId),
      eq(server.organizationId, organizationId),
    ]
    if (serverIdFilter) {
      conditions.push(eq(managed.serverId, serverIdFilter))
    }

    const rows = await db
      .select({
        id: managed.id,
        serverId: managed.serverId,
        displayName: managed.displayName,
        metadata: managed.metadata,
        options: managed.options,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
        serverDisplayName: server.displayName,
      })
      .from(managed)
      .innerJoin(server, eq(server.id, managed.serverId))
      .where(and(...conditions))
      .orderBy(managed.createdAt)

    return c.json({
      managedServices: rows.map(serializeManagedRow),
    })
  })

  router.get('/managed-services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')

    const denied = await assertCanManageOr403(c, 'managed', id)
    if (denied) return denied

    const rows = await db
      .select({
        id: managed.id,
        serverId: managed.serverId,
        displayName: managed.displayName,
        metadata: managed.metadata,
        options: managed.options,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
        serverDisplayName: server.displayName,
      })
      .from(managed)
      .leftJoin(server, eq(server.id, managed.serverId))
      .where(and(eq(managed.id, id), isNotNull(managed.serverId)))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ managedService: serializeManagedRow(row) })
  })

  router.post('/managed-services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const engineRaw = body.engine
    const serverIdRaw = body.serverId
    const displayNameRaw = body.displayName

    if (typeof engineRaw !== 'string' || !MANAGED_ENGINES.has(engineRaw)) {
      return c.json({ error: 'Invalid engine' }, 400)
    }
    if (typeof serverIdRaw !== 'string' || serverIdRaw.trim().length === 0) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const engine = engineRaw as ManagedEngine
    const serverId = serverIdRaw.trim()
    const displayName =
      typeof displayNameRaw === 'string' && displayNameRaw.trim().length > 0
        ? displayNameRaw.trim()
        : 'Production DB'

    if (!DISPLAY_NAME_PATTERN.test(displayName)) {
      return c.json({ error: 'Invalid display name' }, 400)
    }

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serverRows = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
      .limit(1)

    if (!serverRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(
      c,
      'organization:manage',
      'organization',
      organizationId,
    )
    if (denied) return denied

    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const rootPassword = generatePassword()
    const rootUsername = defaultRootUsername(engine)
    const provider = defaultProvider(engine)

    const result = await db.transaction(async (tx) => {
      const [rootPrincipal] = await tx
        .insert(principal)
        .values({
          kind: 'database',
          provider,
          username: rootUsername,
          metadata: { managedRoot: true },
        })
        .returning({ id: principal.id })

      const rootPrincipalId = rootPrincipal?.id
      if (!rootPrincipalId) {
        throw new TypeError('Failed to create root principal')
      }

      await setPrincipalPassword(tx, secrets, rootPrincipalId, {
        password: rootPassword,
      })

      const port = defaultPort(engine)
      const metadata: ManagedMetadata = {
        engine,
        status: 'ready',
        rootPrincipalId,
        host: '127.0.0.1',
        port,
      }

      const [inserted] = await tx
        .insert(managed)
        .values({
          serverId,
          displayName,
          metadata,
          options: { engineVersion: 'latest' },
        })
        .returning({
          id: managed.id,
          serverId: managed.serverId,
          displayName: managed.displayName,
          metadata: managed.metadata,
          options: managed.options,
          createdAt: managed.createdAt,
          updatedAt: managed.updatedAt,
        })

      if (!inserted?.id) {
        throw new TypeError('Failed to create managed service')
      }

      return inserted
    })

    const [serverRow] = await db
      .select({ displayName: server.displayName })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)

    return c.json({
      ok: true as const,
      managedService: serializeManagedRow({
        ...result,
        serverDisplayName: serverRow?.displayName ?? null,
      }),
    })
  })

  router.delete('/managed-services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')

    const denied = await assertCanManageOr403(c, 'managed', id)
    if (denied) return denied

    const rows = await db
      .select({ id: managed.id, serverId: managed.serverId })
      .from(managed)
      .where(and(eq(managed.id, id), isNotNull(managed.serverId)))
      .limit(1)

    if (!rows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    await db.delete(managed).where(eq(managed.id, id))

    return c.json({ ok: true as const })
  })
}
