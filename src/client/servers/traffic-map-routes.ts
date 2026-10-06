import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { assertCanReadOr403 } from '../shared.ts'
import { getDb } from '../../db/connection.ts'
import { eq, inArray } from 'drizzle-orm'
import { server } from '../../db/schema.ts'
import { loadServerTrafficMap } from '../../features/net/server-traffic-map-load.ts'

/**
 * `GET /servers/:id/traffic-map`: which network carries each kind of
 * server-to-server traffic for one server, per peer. Read-only: it reads
 * stored routing inputs and what the daemons reported; it probes nothing.
 * Peers are limited to the servers the viewer may read.
 */
export function registerServerTrafficMapRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for the server traffic map route')
  }
  router.use('/servers/:id/traffic-map', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/traffic-map', async (c) => {
    const serverId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', serverId)
    if (denied) return denied
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const [row] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    if (!row?.organizationId) return c.json({ error: 'Not found' }, 404)

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId: row.organizationId,
    })
    const names = visibleIds.length
      ? await db
          .select({ id: server.id, name: server.name })
          .from(server)
          .where(inArray(server.id, visibleIds))
      : []

    const map = await loadServerTrafficMap(db, {
      serverId,
      organizationId: row.organizationId,
      candidates: names.map((peer) => ({ serverId: peer.id, name: peer.name })),
    })
    return c.json({ ok: true, generatedAt: new Date().toISOString(), ...map })
  })
}
