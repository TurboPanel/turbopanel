/**
 * Backup copy targets for an organization: named S3-compatible destinations
 * finished backups are copied to, the organization default, and each
 * cluster's own choice. Owners and managers only (`organization:manage`, the
 * same check as the firewall). The secret access key is accepted on create and
 * update, sealed at once, and never returned by any response.
 *
 * After a change to where backups go, the affected hosts are sent their
 * complete backup policy set again (`server.backups.reconcile`); that push is
 * best-effort and its outcome is reported, never turned into an error.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { managed, server } from '../../db/schema.ts'
import { isUuid } from '../access/routes-helpers.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { enqueueBackupsReconcile } from '../../features/backups/reconcile.ts'
import {
  copyRecipientFor,
  deleteTarget,
  findTarget,
  insertTarget,
  listTargets,
  managedHostsOfOrganization,
  MAX_BACKUP_TARGETS_PER_ORG,
  parseTargetBody,
  readAssignments,
  sealSecretKey,
  setClusterChoice,
  setOrganizationDefault,
  targetUsage,
  toApiTarget,
  toWireTarget,
  updateTarget,
} from '../../features/backups/targets.ts'
import { isPostgresUniqueViolation } from '../../db/unique-violation.ts'
import { resolveManagedHomeOrganizationId } from '../../features/principals/store.ts'
import { enqueueTypedCommand } from '../../features/managed/apply-prepare.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { copyDepsOf } from '../backup-copy-deps.ts'

const TARGET_PATHS = [
  '/organizations/:id/backup-targets',
  '/organizations/:id/backup-targets/default',
  '/organizations/:id/backup-targets/clusters/:managedId',
  '/organizations/:id/backup-targets/:targetId',
  '/organizations/:id/backup-targets/:targetId/test',
] as const

const TEST_EXPIRES_MS = 120_000

type Scope = { db: Db; organizationId: string }

async function loadScope(c: Context<AppEnv>): Promise<Scope | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const organizationId = c.req.param('id') as string
  const denied = await assertCanManageOr403(c, 'organization', organizationId)
  if (denied) return denied
  if (!isUuid(organizationId)) return c.json({ error: 'Not found' }, 404)
  return { db, organizationId }
}

function invalid(c: Context<AppEnv>, field: string, detail: string): Response {
  return c.json({ error: 'backup_target_invalid', field, detail }, 400)
}

/** Hosts that hold managed databases of the organization, for a reconcile after a change. */
async function serversToPush(db: Db, managedIds: readonly string[]): Promise<(string | null)[]> {
  if (managedIds.length === 0) return []
  const rows = await db
    .select({ serverId: managed.serverId })
    .from(managed)
    .where(inArray(managed.id, [...managedIds]))
  return rows.map((r) => r.serverId)
}

async function pushAfterChange(
  c: Context<AppEnv>,
  scope: Scope,
  serverIds: readonly (string | null)[]
) {
  return await enqueueBackupsReconcile(
    scope.db,
    c.get('commandQueue'),
    { actorType: 'user', actorId: c.get('session')!.userId },
    serverIds,
    copyDepsOf(c)
  )
}

async function auditTarget(
  c: Context<AppEnv>,
  scope: Scope,
  action: 'backup_target.create' | 'backup_target.update' | 'backup_target.delete' | 'backup_target.assign',
  targetId: string | null,
  context: Record<string, unknown>
) {
  const session = c.get('session')
  await recordAudit(scope.db, {
    organizationId: scope.organizationId,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'organization',
    targetId: targetId ?? scope.organizationId,
    context,
  })
}

async function listResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const [targets, assignments] = await Promise.all([
    listTargets(scope.db, scope.organizationId),
    readAssignments(scope.db, scope.organizationId),
  ])
  return c.json({
    targets: targets.map(toApiTarget),
    defaultTargetId: assignments.defaultTargetId,
    clusters: assignments.clusters,
  })
}

async function createResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseTargetBody(body, 'create')
  if (!parsed.ok) return invalid(c, parsed.field, parsed.detail)
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
  if ((await listTargets(scope.db, scope.organizationId)).length >= MAX_BACKUP_TARGETS_PER_ORG) {
    return c.json({ error: 'backup_target_limit', limit: MAX_BACKUP_TARGETS_PER_ORG }, 409)
  }
  const sealed = await sealSecretKey(secrets, parsed.value.secretAccessKey!)
  try {
    const row = await insertTarget(scope.db, {
      organizationId: scope.organizationId,
      userId: c.get('session')!.userId,
      fields: parsed.value,
      sealed,
    })
    await auditTarget(c, scope, 'backup_target.create', row.id, { name: row.name, bucket: row.bucket })
    return c.json({ target: toApiTarget(row) }, 201)
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return c.json({ error: 'backup_target_name_taken' }, 409)
    }
    throw err
  }
}

async function loadTargetParam(c: Context<AppEnv>, scope: Scope) {
  const targetId = c.req.param('targetId') as string
  if (!isUuid(targetId)) return c.json({ error: 'Not found' }, 404)
  const row = await findTarget(scope.db, scope.organizationId, targetId)
  return row ?? c.json({ error: 'Not found' }, 404)
}

async function updateResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadTargetParam(c, scope)
  if (current instanceof Response) return current
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseTargetBody(body, 'update', current)
  if (!parsed.ok) return invalid(c, parsed.field, parsed.detail)
  const secrets = c.get('dataEncryptionSecrets')
  if (parsed.value.secretAccessKey !== undefined && !secrets) {
    return c.json({ error: 'secrets_unavailable' }, 503)
  }
  const sealed =
    parsed.value.secretAccessKey === undefined
      ? null
      : await sealSecretKey(secrets!, parsed.value.secretAccessKey)
  try {
    const row = await updateTarget(scope.db, current, parsed.value, sealed)
    await auditTarget(c, scope, 'backup_target.update', row.id, {
      name: row.name,
      secretReplaced: sealed !== null,
    })
    // Hosts keep their own sealed copy of the target, so every host that uses it gets the set again.
    const usage = await targetUsage(scope.db, row.id)
    const hosts = usage.isDefault
      ? await managedHostsOfOrganization(scope.db, scope.organizationId)
      : await serversToPush(scope.db, usage.managedIds)
    const pushed = await pushAfterChange(c, scope, hosts)
    return c.json({ target: toApiTarget(row), pushedToServers: pushed.queuedServerIds.length })
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return c.json({ error: 'backup_target_name_taken' }, 409)
    }
    throw err
  }
}

async function deleteResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadTargetParam(c, scope)
  if (current instanceof Response) return current
  const usage = await targetUsage(scope.db, current.id)
  if (usage.isDefault || usage.managedIds.length > 0) {
    return c.json(
      {
        error: 'backup_target_in_use',
        message:
          'This target is still used. Take it off the organization default and the clusters that use it first.',
        isDefault: usage.isDefault,
        clusterCount: usage.managedIds.length,
      },
      409
    )
  }
  await deleteTarget(scope.db, current.id)
  await auditTarget(c, scope, 'backup_target.delete', current.id, { name: current.name })
  return c.json({ ok: true })
}

/** Pick the host that runs a connection test: the one asked for, else any connected host of the organization. */
async function pickTestServer(
  scope: Scope,
  requested: unknown
): Promise<{ serverId: string } | { error: string; status: 400 | 404 | 409 }> {
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !isUuid(requested)) {
      return { error: 'serverId must be a server id', status: 400 }
    }
    const [row] = await scope.db
      .select({ id: server.id, isConnected: server.isConnected })
      .from(server)
      .where(eq(server.id, requested))
      .limit(1)
    const own = row ? await ownsServer(scope, requested) : false
    if (!row || !own) return { error: 'Not found', status: 404 }
    return row.isConnected ? { serverId: row.id } : { error: 'server_offline', status: 409 }
  }
  const rows = await scope.db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.organizationId, scope.organizationId))
  for (const row of rows) {
    if (await copyRecipientFor(scope.db, row.id)) {
      const [online] = await scope.db
        .select({ isConnected: server.isConnected })
        .from(server)
        .where(eq(server.id, row.id))
        .limit(1)
      if (online?.isConnected) return { serverId: row.id }
    }
  }
  return { error: 'no_server_ready', status: 409 }
}

async function ownsServer(scope: Scope, serverId: string): Promise<boolean> {
  const [row] = await scope.db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.organizationId === scope.organizationId
}

async function testResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadTargetParam(c, scope)
  if (current instanceof Response) return current
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const picked = await pickTestServer(scope, body.serverId)
  if ('error' in picked) {
    const message =
      picked.error === 'no_server_ready'
        ? 'No connected server of this organization can take a backup target yet. Update the server software and try again.'
        : undefined
    return c.json({ error: picked.error, ...(message ? { message } : {}) }, picked.status)
  }
  const deps = copyDepsOf(c)
  const recipient = await copyRecipientFor(scope.db, picked.serverId)
  if (!deps || !recipient) {
    return c.json(
      {
        error: 'server_cannot_test',
        message: 'That server cannot test a backup target yet. Update the server software first.',
      },
      409
    )
  }
  const queue = assertDispatchInfrastructure(c)
  if (queue instanceof Response) return queue
  const target = await toWireTarget(current, recipient, deps)
  const enqueued = await enqueueTypedCommand(c, scope.db, queue, {
    userId: c.get('session')!.userId,
    serverId: picked.serverId,
    type: 'server.backups.test-target',
    payload: { target },
    expiresAtMs: TEST_EXPIRES_MS,
  })
  if (enqueued instanceof Response) return enqueued
  return c.json({ ok: true, commandId: enqueued.commandId, serverId: enqueued.serverId })
}

async function putDefaultResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const targetId = body.targetId
  if (targetId !== null && (typeof targetId !== 'string' || !isUuid(targetId))) {
    return invalid(c, 'targetId', 'Send a target id, or null for no default')
  }
  if (targetId !== null && !(await findTarget(scope.db, scope.organizationId, targetId))) {
    return c.json({ error: 'Not found' }, 404)
  }
  const before = await managedHostsOfOrganization(scope.db, scope.organizationId)
  await setOrganizationDefault(scope.db, scope.organizationId, targetId)
  await auditTarget(c, scope, 'backup_target.assign', targetId, { scope: 'organization' })
  const pushed = await pushAfterChange(c, scope, before)
  return c.json({ ok: true, defaultTargetId: targetId, pushedToServers: pushed.queuedServerIds.length })
}

async function putClusterResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const managedId = c.req.param('managedId') as string
  if (!isUuid(managedId)) return c.json({ error: 'Not found' }, 404)
  const home = await resolveManagedHomeOrganizationId(scope.db, managedId).catch(() => null)
  if (home !== scope.organizationId) return c.json({ error: 'Not found' }, 404)
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const choice = clusterChoiceOf(body)
  if (choice === null) {
    return invalid(c, 'choice', 'Send "inherit", "none", or a target id')
  }
  if (isUuid(choice) && !(await findTarget(scope.db, scope.organizationId, choice))) {
    return c.json({ error: 'Not found' }, 404)
  }
  await setClusterChoice(scope.db, { organizationId: scope.organizationId, managedId, choice })
  await auditTarget(c, scope, 'backup_target.assign', isUuid(choice) ? choice : null, {
    scope: 'cluster',
    managedId,
    choice: isUuid(choice) ? 'target' : choice,
  })
  const [row] = await scope.db
    .select({ serverId: managed.serverId })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  const pushed = await pushAfterChange(c, scope, [row?.serverId])
  return c.json({ ok: true, choice, pushedToServers: pushed.queuedServerIds.length })
}

function clusterChoiceOf(body: Record<string, unknown>): string | null {
  const choice = body.choice
  if (choice === 'inherit' || choice === 'none') return choice
  return typeof choice === 'string' && isUuid(choice) ? choice : null
}

export function registerOrganizationBackupTargetRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for backup target routes')
  }
  for (const path of TARGET_PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }

  const guarded =
    (handler: (c: Context<AppEnv>, scope: Scope) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const scope = await loadScope(c)
      return scope instanceof Response ? scope : await handler(c, scope)
    }

  router.get('/organizations/:id/backup-targets', guarded(listResponse))
  router.post('/organizations/:id/backup-targets', guarded(createResponse))
  router.put('/organizations/:id/backup-targets/default', guarded(putDefaultResponse))
  router.put('/organizations/:id/backup-targets/clusters/:managedId', guarded(putClusterResponse))
  router.patch('/organizations/:id/backup-targets/:targetId', guarded(updateResponse))
  router.delete('/organizations/:id/backup-targets/:targetId', guarded(deleteResponse))
  router.post('/organizations/:id/backup-targets/:targetId/test', guarded(testResponse))
}
