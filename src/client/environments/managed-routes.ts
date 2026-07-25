import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { generatePassword } from '../../generate-secret.ts'
import { getDb, type Db } from '../../db.ts'
import { environment, managed, principal, project } from '../../lib/db/schema.ts'
import {
  getCatalogEntry,
  readManagedEngineOptions,
  type ManagedEngineCode,
  type ManagedEngineOptions,
} from '../projects/catalog/index.ts'
import { setPrincipalPassword } from '../principals/store.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  BadRequestError,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
} from '../shared.ts'
import {
  readEnvironmentPlacementServerId,
  verifyServerInOrg,
} from './deploy-prepare.ts'

const MANAGED_ENGINES = new Set<string>([
  'postgres',
  'mysql',
  'mariadb',
  'redis',
  'clickhouse',
])

type ManagedEnvironmentMetadata = {
  engine: ManagedEngineCode
  status: 'provisioning' | 'ready' | 'failed'
  rootPrincipalId?: string
  host?: string
  port?: number
  error?: string
}

function parseManagedMetadata(value: unknown): ManagedEnvironmentMetadata | null {
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
    engine: engine as ManagedEngineCode,
    status,
    ...(typeof record.rootPrincipalId === 'string'
      ? { rootPrincipalId: record.rootPrincipalId }
      : {}),
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

function serializeManagedRow(
  row: {
    id: string
    environmentId: string | null
    displayName: string | null
    metadata: unknown
    options: unknown
    createdAt: string
    updatedAt: string
  },
  serverId: string | null,
) {
  const meta = parseManagedMetadata(row.metadata)
  return {
    id: row.id,
    environmentId: row.environmentId,
    displayName: row.displayName,
    engine: meta?.engine ?? null,
    status: meta?.status ?? 'provisioning',
    host: meta?.host ?? null,
    port: meta?.port ?? null,
    serverId,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function authorizeManagedRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  mode: 'read' | 'manage',
): Promise<{ userId: string; organizationId: string } | Response> {
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = mode === 'read'
    ? await assertCanReadOr403(c, 'environment', environmentId)
    : await assertCanManageOr403(c, 'environment', environmentId)
  if (denied) return denied

  return { userId: session.userId, organizationId: orgResult }
}

type ManagedProvisionContext = {
  envRow: {
    id: string
    projectId: string
    displayName: string | null
    options: unknown
    metadata: unknown
  }
  engineOptions: ManagedEngineOptions
  serverId: string
  entryDisplayName: string
}

function readProjectCatalogCode(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null
  }
  const code = (metadata as Record<string, unknown>).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

async function loadManagedProvisionContext(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  organizationId: string,
): Promise<ManagedProvisionContext | Response> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      displayName: environment.displayName,
      options: environment.options,
      metadata: environment.metadata,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!envRow) return c.json({ error: 'Not found' }, 404)

  const [projectRow] = await db
    .select({ metadata: project.metadata })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return c.json({ error: 'Not found' }, 404)

  const code = readProjectCatalogCode(projectRow.metadata)
  const entry = code ? getCatalogEntry(code) : undefined
  const engineOptions = entry ? readManagedEngineOptions(entry) : null
  if (!entry || !engineOptions) {
    return c.json({ error: 'not_managed_environment' }, 400)
  }

  const serverId = readEnvironmentPlacementServerId(envRow.options)
  if (!serverId) {
    return c.json({ error: 'server_placement_required' }, 409)
  }
  if (!(await verifyServerInOrg(db, serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }

  return {
    envRow,
    engineOptions,
    serverId,
    entryDisplayName: entry.displayName,
  }
}

async function findManagedForEnvironment(
  db: Db,
  environmentId: string,
) {
  const [row] = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      displayName: managed.displayName,
      metadata: managed.metadata,
      options: managed.options,
      createdAt: managed.createdAt,
      updatedAt: managed.updatedAt,
    })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  return row ?? null
}

/**
 * Register environment-scoped managed service routes:
 * `GET /environments/:id/managed` and `POST /environments/:id/managed/provision`.
 */
export function registerEnvironmentManagedRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment managed routes')
  }

  router.use('/environments/:id/managed', createSessionMiddleware(opts.secrets))
  router.use(
    '/environments/:id/managed/provision',
    createSessionMiddleware(opts.secrets),
  )

  router.get('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'read')
    if (auth instanceof Response) return auth

    const [envRow] = await db
      .select({ options: environment.options })
      .from(environment)
      .where(eq(environment.id, environmentId))
      .limit(1)
    if (!envRow) return c.json({ error: 'Not found' }, 404)

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) {
      return c.json({ managed: null })
    }

    const serverId = readEnvironmentPlacementServerId(envRow.options)
    return c.json({ managed: serializeManagedRow(row, serverId) })
  })

  router.post('/environments/:id/managed/provision', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedProvisionContext(
      c,
      db,
      environmentId,
      auth.organizationId,
    )
    if (ctx instanceof Response) return ctx

    const existing = await findManagedForEnvironment(db, environmentId)
    if (existing) {
      return c.json({
        ok: true as const,
        alreadyProvisioned: true as const,
        managed: serializeManagedRow(existing, ctx.serverId),
      })
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch (error) {
      if (error instanceof BadRequestError) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      throw error
    }

    const resolvedDisplayName = displayName
      ?? ctx.envRow.displayName
      ?? ctx.entryDisplayName

    const { engineOptions } = ctx
    const rootPassword = generatePassword()

    const inserted = await db.transaction(async (tx) => {
      const [rootPrincipal] = await tx
        .insert(principal)
        .values({
          kind: 'database',
          provider: engineOptions.provider,
          username: engineOptions.rootUsername,
          projectId: ctx.envRow.projectId,
          metadata: {
            managedRoot: true,
            engine: engineOptions.engine,
          },
        })
        .returning({ id: principal.id })

      const rootPrincipalId = rootPrincipal?.id
      if (!rootPrincipalId) {
        throw new TypeError('Failed to create root principal')
      }

      await setPrincipalPassword(tx, dataEncryptionSecrets, rootPrincipalId, {
        password: rootPassword,
      })

      // Future: host stays a loopback placeholder until the daemon
      // managed.provision command lands (Phase 3 roadmap).
      const metadata: ManagedEnvironmentMetadata = {
        engine: engineOptions.engine,
        status: 'ready',
        rootPrincipalId,
        host: '127.0.0.1',
        port: engineOptions.port,
      }

      const [row] = await tx
        .insert(managed)
        .values({
          environmentId,
          displayName: resolvedDisplayName,
          metadata,
          options: { engineVersion: 'latest' },
        })
        .returning({
          id: managed.id,
          environmentId: managed.environmentId,
          displayName: managed.displayName,
          metadata: managed.metadata,
          options: managed.options,
          createdAt: managed.createdAt,
          updatedAt: managed.updatedAt,
        })

      if (!row?.id) {
        throw new TypeError('Failed to create managed environment service')
      }
      return row
    })

    return c.json({
      ok: true as const,
      managed: serializeManagedRow(inserted, ctx.serverId),
    })
  })
}
