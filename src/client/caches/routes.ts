/**
 * Project caches of an environment.
 *
 * - `GET    /environments/:id/caches` lists them.
 * - `POST   /environments/:id/caches` adds one (a Valkey process run as a chosen Hosting Account).
 * - `PATCH  /environments/:id/caches/:cacheId` changes its access, memory limit or variable prefix.
 * - `DELETE /environments/:id/caches/:cacheId?deleteData=` removes it; the data goes unless `deleteData=false`.
 *
 * Writes queue `cache.apply` only for a daemon that lists `project-cache-v1`;
 * a server without it answers 409 `daemon_update_needed`. A cache on a server
 * that is offline is removed from the record without a command, so a dead host
 * is never a dead end.
 */

import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { deployment, environment, organization, server } from '../../db/schema.ts'
import { findCacheKeyConflicts } from '../../features/caches/conflicts.ts'
import { enqueueCacheApply } from '../../features/caches/apply-command.ts'
import { readRecordedHelperPorts } from '../../features/caches/reach.ts'
import {
  allocateCachePort,
  type CacheWithAccount,
  deleteCacheRow,
  getEnvironmentCache,
  insertCache,
  listEnvironmentCaches,
  updateCache,
} from '../../features/caches/store.ts'
import { cacheVariableNames } from '../../features/caches/variables.ts'
import {
  CACHE_DEFAULT_SERIES,
  MAX_CACHES_PER_ENVIRONMENT,
} from '../../features/caches/vocabulary.ts'
import {
  readRecordedListenPorts,
  listReservedListenPorts,
} from '../../features/deploy/deployment-records.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { isUuid } from '../../features/principals/store.ts'
import { generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import { PROJECT_CACHE_FEATURE } from '../../lib/version-wire.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { storedDaemonFeatures } from '../environments/destroy-data.ts'
import { effectiveAccountLimits } from '../environments/account-limits.ts'
import { loadTenancyPrincipalIdsForEnvironment } from '../principals/tenancies.ts'
import { assertCanReadOr403, getOrgId, parseJsonBody } from '../shared.ts'
import {
  type CacheRequestError,
  cacheView,
  memoryCeilingError,
  parseCacheCreateBody,
  parseCachePatchBody,
  parseDeleteData,
} from './routes-helpers.ts'

type EnvContext = {
  db: Db
  environmentId: string
  organizationId: string
  serverId: string | null
  orgOptions: unknown
}

const DAEMON_UPDATE_MESSAGE = 'Update the daemon on this server to use project caches'

function refusal(c: Context<AppEnv>, error: CacheRequestError): Response {
  return c.json({ error: error.error, message: error.message }, error.status)
}

/** Resolve the environment inside the caller's organization, or the response to send. */
async function resolveEnvironment(
  c: Context<AppEnv>,
  mode: 'read' | 'manage'
): Promise<EnvContext | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  const environmentId = c.req.param('id') ?? ''
  if (!isUuid(environmentId)) return c.json({ error: 'Not found' }, 404)
  const environmentOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
  if (!environmentOrgId || environmentOrgId !== orgResult)
    return c.json({ error: 'Not found' }, 404)
  const denied =
    mode === 'read'
      ? await assertCanReadOr403(c, 'environment', environmentId)
      : await assertCanOr403(c, 'organization:manage', 'environment', environmentId)
  if (denied) return denied
  const [env] = await db
    .select({ serverId: environment.serverId })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  const [org] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, orgResult))
    .limit(1)
  return {
    db,
    environmentId,
    organizationId: orgResult,
    serverId: env?.serverId ?? null,
    orgOptions: org?.options,
  }
}

async function serverOptions(
  db: Db,
  serverId: string
): Promise<{ options: unknown; connected: boolean }> {
  const [row] = await db
    .select({ options: server.options, connected: server.isConnected })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return { options: row?.options, connected: row?.connected === true }
}

/** Ports in use on the server by anything but another environment's sites (those are reserved separately). */
async function usedPorts(db: Db, environmentId: string, serverId: string): Promise<Set<number>> {
  const reserved = await listReservedListenPorts(db, { environmentId, serverIds: [serverId] })
  const used = new Set<number>(reserved.get(serverId))
  const [own] = await db
    .select({ options: deployment.options })
    .from(deployment)
    .where(and(eq(deployment.environmentId, environmentId), eq(deployment.serverId, serverId)))
    .limit(1)
  for (const port of readRecordedListenPorts(own?.options)) used.add(port)
  for (const port of Object.values(readRecordedHelperPorts(own?.options))) used.add(port)
  return used
}

async function daemonRefusal(
  c: Context<AppEnv>,
  db: Db,
  serverId: string
): Promise<Response | null> {
  const features = await storedDaemonFeatures(db, serverId)
  if (features.includes(PROJECT_CACHE_FEATURE)) return null
  return c.json({ error: 'daemon_update_needed', message: DAEMON_UPDATE_MESSAGE }, 409)
}

function apply(
  c: Context<AppEnv>,
  ctx: EnvContext & { serverId: string },
  actorId: string,
  removed: Array<{ id: string; username: string; deleteData: boolean }>,
  limits: ReturnType<typeof effectiveAccountLimits>
) {
  return enqueueCacheApply(
    ctx.db,
    { actorType: 'user', actorId },
    { environmentId: ctx.environmentId, serverId: ctx.serverId, removed },
    { queue: getCommandQueue(c), secrets: c.get('dataEncryptionSecrets'), accountLimits: limits }
  )
}

async function keyConflictResponse(
  c: Context<AppEnv>,
  ctx: EnvContext,
  prefix: string,
  access: 'socket' | 'port'
): Promise<Response | null> {
  const clash = await findCacheKeyConflicts(
    ctx.db,
    ctx.environmentId,
    cacheVariableNames(prefix, access)
  )
  if (clash.length === 0) return null
  return c.json(
    {
      error: 'cache_key_conflict',
      message: `A service or hostname variable already sets ${clash.join(', ')}. Rename it or choose another prefix.`,
    },
    409
  )
}

const CLASH_MESSAGES = {
  name_taken: ['cache_name_taken', 'This environment already has a cache with that name'],
  prefix_taken: [
    'cache_prefix_taken',
    'Another cache of this Hosting Account already uses that variable prefix',
  ],
  port_taken: ['cache_port_taken', 'That port was just taken; try again'],
} as const

function clashResponse(c: Context<AppEnv>, reason: keyof typeof CLASH_MESSAGES): Response {
  const [error, message] = CLASH_MESSAGES[reason]
  return c.json({ error, message }, 409)
}

async function createCache(c: Context<AppEnv>): Promise<Response> {
  const ctx = await resolveEnvironment(c, 'manage')
  if (ctx instanceof Response) return ctx
  const session = c.get('session')
  const secrets = c.get('dataEncryptionSecrets')
  if (!session || !secrets) return c.json({ error: 'Encryption unavailable' }, 503)
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const input = parseCacheCreateBody(body)
  if ('error' in input) return refusal(c, input)
  if (ctx.serverId === null) {
    return c.json(
      {
        error: 'environment_not_placed',
        message: 'Place this environment on a server before adding a cache',
      },
      409
    )
  }
  const placed = { ...ctx, serverId: ctx.serverId }
  const gate = await daemonRefusal(c, ctx.db, placed.serverId)
  if (gate) return gate
  const accounts = await loadTenancyPrincipalIdsForEnvironment(ctx.db, ctx.environmentId)
  if (!accounts.includes(input.principalId)) {
    return c.json(
      {
        error: 'principal_not_in_environment',
        message: 'Choose a Hosting Account of a site or app in this environment',
      },
      422
    )
  }
  const existing = await listEnvironmentCaches(ctx.db, ctx.environmentId)
  if (existing.length >= MAX_CACHES_PER_ENVIRONMENT) {
    return c.json(
      {
        error: 'too_many_caches',
        message: `At most ${MAX_CACHES_PER_ENVIRONMENT} caches per environment`,
      },
      409
    )
  }
  const srv = await serverOptions(ctx.db, placed.serverId)
  const limits = effectiveAccountLimits(ctx.orgOptions, srv.options)
  const tooBig = memoryCeilingError(input.maxMemoryMb, limits)
  if (tooBig) return refusal(c, tooBig)
  const conflict = await keyConflictResponse(c, ctx, input.keyPrefix, input.access)
  if (conflict) return conflict

  const sealed = await generateSealedSecret(secrets)
  const inserted = await insertWithPort(ctx.db, placed, input, sealed.sealed)
  if (!inserted.ok) return clashResponse(c, inserted.reason)
  const rows = await listEnvironmentCaches(ctx.db, ctx.environmentId)
  const created = rows.find((row) => row.id === inserted.id)
  const applied = await apply(c, placed, session.userId, [], limits)
  return c.json(
    { ok: true as const, cache: created ? cacheView(created) : null, applied: applied.queued },
    201
  )
}

/** Insert the row; a port clash is retried once with a fresh allocation. */
async function insertWithPort(
  db: Db,
  ctx: EnvContext & { serverId: string },
  input: {
    name: string
    principalId: string
    access: 'socket' | 'port'
    maxMemoryMb: number
    keyPrefix: string
  },
  password: string
): Promise<
  { ok: true; id: string } | { ok: false; reason: 'name_taken' | 'prefix_taken' | 'port_taken' }
> {
  let lastReason: 'name_taken' | 'prefix_taken' | 'port_taken' = 'port_taken'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const port =
      input.access === 'port'
        ? allocateCachePort(
            input.name,
            await usedPorts(db, ctx.environmentId, ctx.serverId),
            ctx.environmentId
          )
        : null
    const result = await insertCache(db, {
      environmentId: ctx.environmentId,
      serverId: ctx.serverId,
      principalId: input.principalId,
      name: input.name,
      version: CACHE_DEFAULT_SERIES,
      access: input.access,
      port,
      maxMemoryMb: input.maxMemoryMb,
      keyPrefix: input.keyPrefix,
      password,
    })
    if (result.ok) return { ok: true, id: result.row.id }
    lastReason = result.reason
    if (result.reason !== 'port_taken') break
  }
  return { ok: false, reason: lastReason }
}

async function patchCache(c: Context<AppEnv>): Promise<Response> {
  const ctx = await resolveEnvironment(c, 'manage')
  if (ctx instanceof Response) return ctx
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const cacheId = c.req.param('cacheId') ?? ''
  if (!isUuid(cacheId)) return c.json({ error: 'Not found' }, 404)
  const row = await getEnvironmentCache(ctx.db, ctx.environmentId, cacheId)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const patch = parseCachePatchBody(body)
  if ('error' in patch) return refusal(c, patch)
  const gate = await daemonRefusal(c, ctx.db, row.serverId)
  if (gate) return gate
  const placed = { ...ctx, serverId: row.serverId }
  const srv = await serverOptions(ctx.db, row.serverId)
  const limits = effectiveAccountLimits(ctx.orgOptions, srv.options)
  const tooBig = memoryCeilingError(patch.maxMemoryMb ?? row.maxMemoryMb, limits)
  if (tooBig) return refusal(c, tooBig)
  const nextAccess = patch.access ?? (row.access === 'port' ? 'port' : 'socket')
  const nextPrefix = patch.keyPrefix ?? row.keyPrefix
  if (patch.keyPrefix !== undefined || patch.access !== undefined) {
    const conflict = await keyConflictResponse(c, ctx, nextPrefix, nextAccess)
    if (conflict) return conflict
  }
  const outcome = await updateWithPort(ctx.db, placed, row, { ...patch, access: nextAccess })
  if (!outcome.ok) return clashResponse(c, outcome.reason)
  const applied = await apply(c, placed, session.userId, [], limits)
  const rows = await listEnvironmentCaches(ctx.db, ctx.environmentId)
  const updated = rows.find((entry) => entry.id === cacheId)
  return c.json({
    ok: true as const,
    cache: updated ? cacheView(updated) : null,
    applied: applied.queued,
  })
}

async function updateWithPort(
  db: Db,
  ctx: EnvContext & { serverId: string },
  row: CacheWithAccount,
  patch: { access: 'socket' | 'port'; maxMemoryMb?: number; keyPrefix?: string }
): Promise<{ ok: true } | { ok: false; reason: 'name_taken' | 'prefix_taken' | 'port_taken' }> {
  const fields: Parameters<typeof updateCache>[2] = {
    access: patch.access,
    ...(patch.maxMemoryMb === undefined ? {} : { maxMemoryMb: patch.maxMemoryMb }),
    ...(patch.keyPrefix === undefined ? {} : { keyPrefix: patch.keyPrefix }),
  }
  if (patch.access === 'socket') fields.port = null
  else if (row.port === null) {
    fields.port = allocateCachePort(
      row.name,
      await usedPorts(db, ctx.environmentId, ctx.serverId),
      ctx.environmentId
    )
  }
  // A changed memory limit or access restarts the cache, so it is applied again.
  return await updateCache(db, row.id, { ...fields, status: 'pending' })
}

async function removeCache(c: Context<AppEnv>): Promise<Response> {
  const ctx = await resolveEnvironment(c, 'manage')
  if (ctx instanceof Response) return ctx
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const cacheId = c.req.param('cacheId') ?? ''
  if (!isUuid(cacheId)) return c.json({ error: 'Not found' }, 404)
  const row = await getEnvironmentCache(ctx.db, ctx.environmentId, cacheId)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const deleteData = parseDeleteData(c.req.query('deleteData'))
  const srv = await serverOptions(ctx.db, row.serverId)
  if (!srv.connected) {
    // Record only: a host that is gone cannot be asked, and its row must still be removable.
    await deleteCacheRow(ctx.db, row.id)
    return c.json({ ok: true as const, removed: 'record_only' as const })
  }
  const gate = await daemonRefusal(c, ctx.db, row.serverId)
  if (gate) return gate
  await deleteCacheRow(ctx.db, row.id)
  const limits = effectiveAccountLimits(ctx.orgOptions, srv.options)
  const applied = await apply(
    c,
    { ...ctx, serverId: row.serverId },
    session.userId,
    [{ id: row.id, username: row.username, deleteData }],
    limits
  )
  return c.json({ ok: true as const, removed: 'host' as const, applied: applied.queued })
}

export function registerCacheRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) throw new TypeError('session secrets are required for cache routes')
  router.use('/environments/:id/caches', createSessionMiddleware(opts.secrets))
  router.use('/environments/:id/caches/:cacheId', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/caches', async (c) => {
    const ctx = await resolveEnvironment(c, 'read')
    if (ctx instanceof Response) return ctx
    const rows = await listEnvironmentCaches(ctx.db, ctx.environmentId)
    return c.json({ ok: true as const, caches: rows.map(cacheView) })
  })
  router.post('/environments/:id/caches', createCache)
  router.patch('/environments/:id/caches/:cacheId', patchCache)
  router.delete('/environments/:id/caches/:cacheId', removeCache)
}
