import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { can, listVisible } from '../authz/index.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId } from '../shared.ts'
import { getDb, getDaemonCellRegistry, type Db } from '../../db.ts'
import {
  fetchDaemonServerCell,
} from '../../daemon/cell/server-diagnostics.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { clearServerDaemonState } from '../../daemon/authn/server-identity-db.ts'
import { server } from '../../lib/db/schema.ts'
import { resolveTrunkManifest } from '../../lib/update/manifest.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  resolveServerUpdateStatus,
  type ServerUpdateCommit,
} from './update-status.ts'

const UPDATE_CHANNEL = 'trunk'
const UPDATE_REQUEST_TTL_SECONDS = 300

type QueuedUpdateResult = {
  ok: true
  queued: true
  status: 'updating'
  serverId: string
  requestId: string
  channel: typeof UPDATE_CHANNEL
}

type QueueUpdateFailure = {
  ok: false
  error: string
}

async function queueServerUpdate(
  registry: DaemonCellRegistry,
  db: Db,
  serverId: string,
): Promise<QueuedUpdateResult | QueueUpdateFailure> {
  const presence = await resolveFleetPresence(db, registry, [serverId])
  if (!presence.get(serverId)?.connected) {
    return { ok: false, error: 'Daemon not connected' }
  }

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    channel: UPDATE_CHANNEL,
  }

  await registry.getCell(serverId).enqueue(envelope, {
    ttlSeconds: UPDATE_REQUEST_TTL_SECONDS,
  })

  return {
    ok: true,
    queued: true,
    status: 'updating',
    serverId,
    requestId,
    channel: UPDATE_CHANNEL,
  }
}

function currentCommitFromAgent(
  agent: { commit?: string; buildId?: string; builtAt?: string } | undefined,
): ServerUpdateCommit | null {
  return agent?.commit
    ? {
      commit: agent.commit,
      buildId: agent.buildId ?? '',
      builtAt: agent.builtAt ?? '',
    }
    : null
}

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

  router.get('/servers/updates', async (c) => {
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
      return c.json({
        ok: true,
        channel: UPDATE_CHANNEL,
        target: null,
        targetStatus: 'unknown' as const,
        targetError: 'Could not resolve trunk channel manifest',
        servers: [],
      })
    }

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    const targetManifest = await resolveTrunkManifest()
    const target = targetManifest
      ? {
        commit: targetManifest.commit,
        buildId: targetManifest.buildId,
        builtAt: targetManifest.builtAt,
        manifestUrl: targetManifest.manifestUrl,
      }
      : null
    const targetStatus = target ? 'ok' as const : 'unknown' as const
    const targetError = target
      ? undefined
      : 'Could not resolve trunk channel manifest'

    const servers = await Promise.all(
      visibleIds.map(async (serverId) => {
        const current = currentCommitFromAgent(presence.get(serverId)?.agent)
        const resolved = await resolveServerUpdateStatus({
          serverId,
          current,
          targetManifest,
          listUpdateRequests: async () => {
            if (!registry) return []
            return registry.getCell(serverId).listRequests(10, { requestKind: 'update' })
          },
        })
        return {
          serverId,
          current,
          ...resolved,
        }
      }),
    )

    return c.json({
      ok: true,
      channel: UPDATE_CHANNEL,
      target,
      targetStatus,
      targetError,
      servers,
    })
  })

  router.post('/servers/updates', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    const targetManifest = await resolveTrunkManifest()
    const presence = await resolveFleetPresence(db, registry, visibleIds)

    const results = await Promise.all(
      visibleIds.map(async (serverId) => {
        const manageable = await can(
          db,
          session.userId,
          'organization:manage',
          'server',
          serverId,
        )
        if (!manageable) {
          return {
            serverId,
            ok: false,
            error: 'Forbidden',
          }
        }

        if (!presence.get(serverId)?.connected) {
          return {
            serverId,
            ok: false,
            error: 'Daemon not connected',
          }
        }

        const current = currentCommitFromAgent(presence.get(serverId)?.agent)
        const updateAvailable = targetManifest
          ? current?.commit !== targetManifest.commit
          : false
        if (!updateAvailable) {
          return {
            serverId,
            ok: false,
            error: targetManifest ? 'Up to date' : 'Target unavailable',
          }
        }

        const queued = await queueServerUpdate(registry, db, serverId)
        if (!queued.ok) {
          return { serverId, ok: false, error: queued.error }
        }

        return {
          serverId,
          ok: true,
          queued: true,
          status: queued.status,
          requestId: queued.requestId,
          channel: queued.channel,
        }
      }),
    )

    return c.json({
      ok: results.every((result) => result.ok),
      results,
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
    const current = currentCommitFromAgent(presence.get(id)?.agent)

    const updateRequests = registry
      ? await registry.getCell(id).listRequests(10, { requestKind: 'update' })
      : []

    const resolved = await resolveServerUpdateStatus({
      serverId: id,
      current,
      listUpdateRequests: async () => updateRequests,
    })

    // #region agent log
    const latest = updateRequests[0]
    fetch('http://localhost:7440/ingest/3e0179a5-fa63-49e5-b717-b62ee1a155c9', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5d6f57' }, body: JSON.stringify({ sessionId: '5d6f57', runId: 'louie-update', hypothesisId: 'H1,H2,H3,H4,H5', location: 'instance/src/client/servers/routes.ts:getUpdateStatus', message: 'server update status resolved', data: { serverId: id, connected: presence.get(id)?.connected ?? false, currentCommit: current?.commit ?? null, targetCommit: resolved.target?.commit ?? null, status: resolved.status, updateAvailable: resolved.updateAvailable, requestCount: updateRequests.length, latestRequestId: latest?.requestId ?? null, latestStatus: latest?.status ?? null, latestError: latest?.error ?? null, latestCreatedAt: latest?.createdAt ?? null, latestFinishedAt: latest?.finishedAt ?? null }, timestamp: Date.now() }) }).catch(() => {})
    // #endregion

    return c.json({
      ok: true,
      serverId: id,
      channel: UPDATE_CHANNEL,
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

    const queued = await queueServerUpdate(registry, db, id)
    if (!queued.ok) {
      return c.json({ ok: false, error: queued.error }, 404)
    }

    return c.json({ ok: true, ...queued })
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
