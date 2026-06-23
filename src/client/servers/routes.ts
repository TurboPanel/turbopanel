import { and, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { getDb, getDaemonCellRegistry } from '../../db.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import { server } from '../../lib/db/schema.ts'

export function registerServerRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/servers', createSessionMiddleware(opts.secrets))

  router.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ servers: [] })
    }

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
      .where(and(inArray(server.id, visibleIds), isNull(server.deletedAt)))
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
          status: live?.status ?? null,
          healthyCount: live?.healthyCount ?? null,
          degradedCount: live?.degradedCount ?? null,
          unhealthyCount: live?.unhealthyCount ?? null,
          licenseId: row.licenseId ?? null,
        }
      }),
    })
  })
}
