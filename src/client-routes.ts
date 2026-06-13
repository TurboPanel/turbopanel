import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { registerAuthRoutes, type AuthRouteOpts } from './auth/http.ts'
import { getUserOrganizationId } from './auth/install-state.ts'
import { createSessionMiddleware } from './auth/middleware.ts'
import { listDaemonConnections } from './daemon-hub.ts'
import { getDb } from './db.ts'
import { server } from './db/schema.ts'
import { CLIENT_API_PREFIX } from './surfaces.ts'

/**
 * Client (end-user UI) surface. Auth routes plus org-scoped resources for the
 * signed-in user (e.g. servers assigned to their organization).
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono, opts: AuthRouteOpts) {
  const client = new Hono()

  registerAuthRoutes(client, opts)

  client.get('/status', (c) => c.json({ ok: true, surface: 'client' }))

  client.all('/install', (c) =>
    c.json({ ok: false, error: 'Gone; use /api/install/v1' }, 410))
  client.all('/install/*', (c) =>
    c.json({ ok: false, error: 'Gone; use /api/install/v1' }, 410))

  client.use('/servers', createSessionMiddleware(opts.secrets))

  client.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizationId = await getUserOrganizationId(db, session.userId)
    if (!organizationId) {
      return c.json({ servers: [] })
    }

    const rows = await db
      .select({
        id: server.id,
        displayName: server.displayName,
        organizationId: server.organizationId,
        options: server.options,
        createdAt: server.createdAt,
      })
      .from(server)
      .where(and(eq(server.organizationId, organizationId), isNull(server.deletedAt)))
      .orderBy(server.createdAt)

    const connectionsByServerId = new Map(
      listDaemonConnections()
        .filter((conn) => conn.serverId)
        .map((conn) => [conn.serverId!, conn]),
    )

    return c.json({
      servers: rows.map((row) => {
        const conn = connectionsByServerId.get(row.id)
        return {
          ...row,
          connected: conn != null,
          hostname: conn?.hostname ?? null,
        }
      }),
    })
  })

  app.route(CLIENT_API_PREFIX, client)
  return app
}
