import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId } from '../shared.ts'
import { getDb, getDaemonCellRegistry } from '../../db.ts'
import {
  fetchDaemonServerCell,
} from '../../daemon/cell/server-diagnostics.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { clearServerDaemonState } from '../../daemon/authn/server-identity-db.ts'
import { server } from '../../lib/db/schema.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import { resolveServerUpdateStatus } from './update-status.ts'

const UPDATE_TIMEOUT_MS = 120_000

export function registerServerRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/servers', createSessionMiddleware(opts.secrets))
  router.use('/servers/*', createSessionMiddleware(opts.secrets))

  router.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ servers: [] })
    }

    const rows = await db
      .select({
        id: server.id,
        displayName: server.displayName,
        organizationId: server.organizationId,
        licenseId: server.licenseId,
        options: server.options,
        createdAt: server.createdAt,
      })
      .from(server)
      .where(inArray(server.id, visibleIds))
      .orderBy(server.createdAt)

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(
      db,
      registry,
      rows.map((row) => row.id),
    )

    return c.json({
      servers: rows.map((row) => {
        const live = presence.get(row.id)
        return {
          ...row,
          connected: live?.connected ?? false,
          hostname: live?.hostname ?? null,
          remoteAddress: live?.remoteAddress ?? null,
          lastInboundAt: live?.lastInboundAt ?? live?.lastHeartbeatAt ?? null,
          lastHeartbeatAt: live?.lastInboundAt ?? live?.lastHeartbeatAt ?? null,
          connectedAt: live?.connectedAt ?? null,
          licenseId: row.licenseId ?? null,
        }
      }),
    })
  })

  router.get('/servers/:id/cell', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const result = await fetchDaemonServerCell(db, registry, id)
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json(result)
  })

  router.get('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, [id])
    const agent = presence.get(id)?.agent

    const current = agent?.commit
      ? {
        commit: agent.commit,
        buildId: agent.buildId ?? '',
        builtAt: agent.builtAt ?? '',
      }
      : null

    const resolved = await resolveServerUpdateStatus({
      serverId: id,
      current,
      listUpdateRequests: async () => {
        if (!registry) return []
        return registry.getCell(id).listRequests(10, { requestKind: 'update' })
      },
    })

    return c.json({
      ok: true,
      serverId: id,
      channel: 'trunk',
      current,
      ...resolved,
    })
  })

  router.post('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const presence = await resolveFleetPresence(db, registry, [id])
    if (!presence.get(id)?.connected) {
      return c.json({ error: 'Daemon not connected' }, 404)
    }

    const envelope: DaemonOutboundEnvelope = {
      kind: 'update',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      channel: 'trunk',
    }

    const record = await registry.getCell(id).createRequestAndWait(
      envelope,
      UPDATE_TIMEOUT_MS,
    )

    if (record.status === 'done') {
      return c.json({ ok: true, queued: true, status: 'updating' })
    }
    if (record.status === 'failed') {
      return c.json(
        { ok: false, error: record.error ?? 'daemon reported failure' },
        500,
      )
    }
    if (record.status === 'expired') {
      return c.json(
        { ok: false, error: 'timeout waiting for daemon acknowledgement' },
        504,
      )
    }

    return c.json({ ok: false, error: `unexpected update status: ${record.status}` }, 500)
  })

  router.delete('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [row] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(server).where(eq(server.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    await clearServerDaemonState(db, id)

    try {
      await registry.getCell(id).purge()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`Failed to purge daemon cell for server ${id}: ${message}`)
      return c.json({
        ok: false,
        serverId: id,
        deleted: true,
        error: `Server deleted but daemon cell purge failed: ${message}`,
      }, 500)
    }

    return c.json({ ok: true, serverId: id })
  })
}
