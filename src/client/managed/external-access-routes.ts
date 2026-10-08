/**
 * "Allow external access to the databases on this server" (manager-gated):
 *
 * - `GET /servers/:id/managed-external-access` — the server's setting.
 * - `PUT /servers/:id/managed-external-access` — change it and tell the server.
 *
 * The setting belongs to the server because one ProxySQL fronts every managed
 * cluster on it (see `features/managed/external-access.ts`). A PUT saves the
 * setting, then queues the ingress reconcile that publishes (or stops
 * publishing) the listener. A push that could not be queued answers 502: the
 * setting is saved, the host is not told yet, and it is retried automatically.
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { server } from '../../db/schema.ts'
import {
  preflightManagedApplyInfrastructure,
  prepareErrorResponse,
} from '../../features/managed/apply-prepare.ts'
import {
  clearManagedExternalAccessPending,
  describeFailedExternalAccessPush,
  enqueueManagedExternalAccessReconcile,
  loadFrontedManagedIds,
  readManagedExternalAccess,
  saveManagedExternalAccess,
} from '../../features/managed/external-access.ts'

/** The server, scoped to the caller's organization: another org's server is 404. */
async function loadServer(c: Context<AppEnv>) {
  const scope = await resolveOrgRequest(c)
  if (scope instanceof Response) return scope
  const id = c.req.param('id') ?? ''
  const [row] = await scope.db
    .select({ options: server.options, name: server.name, hostname: server.hostname })
    .from(server)
    .where(and(eq(server.id, id), eq(server.organizationId, scope.organizationId)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const denied = await assertCanManageOr403(c, 'server', id)
  if (denied) return denied
  return { ...scope, id, row }
}

export function registerManagedExternalAccessRoutes(router: Hono<AppEnv>) {
  router.get('/servers/:id/managed-external-access', async (c) => {
    const loaded = await loadServer(c)
    if (loaded instanceof Response) return loaded
    const setting = readManagedExternalAccess(loaded.row.options)
    return c.json({
      enabled: setting.enabled,
      pending: setting.pendingSince !== undefined,
      clusterCount: (await loadFrontedManagedIds(loaded.db, loaded.id)).length,
    })
  })

  router.put('/servers/:id/managed-external-access', async (c) => {
    const loaded = await loadServer(c)
    if (loaded instanceof Response) return loaded
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'invalid_external_access' }, 400)
    }

    // Refuse before saving when the server cannot be told.
    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue
    const refusal = await preflightManagedApplyInfrastructure(c, loaded.db, { serverId: loaded.id })
    if (refusal) return prepareErrorResponse(c, refusal)

    await saveManagedExternalAccess(loaded.db, loaded.id, body.enabled)
    const outcome = await enqueueManagedExternalAccessReconcile(c, loaded.db, commandQueue, {
      serverId: loaded.id,
      userId: loaded.session.userId,
    })
    if (outcome === 'not_needed') await clearManagedExternalAccessPending(loaded.db, loaded.id)
    const clusterCount = (await loadFrontedManagedIds(loaded.db, loaded.id)).length
    if (outcome === 'failed') {
      return c.json(
        {
          error: 'ingress_reconcile_failed',
          message: describeFailedExternalAccessPush(
            loaded.row.name || loaded.row.hostname || loaded.id
          ),
          enabled: body.enabled,
          pending: true,
          clusterCount,
        },
        502
      )
    }
    return c.json({ ok: true, enabled: body.enabled, pending: outcome === 'queued', clusterCount })
  })
}
