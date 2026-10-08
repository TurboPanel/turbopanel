import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanReadOr403 } from '../shared.ts'
import { getDaemonCellRegistry } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { loadServerServices } from './server-services.ts'

export function registerServerServicesRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server services routes')
  }
  router.use('/servers/:id/services', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/services', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, organizationId } = scope
    const serverId = c.req.param('id')

    const [row] = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'server', serverId)
    if (denied) return denied

    return c.json(
      await loadServerServices(db, getDaemonCellRegistry(c), serverId, organizationId, row.metadata)
    )
  })
}
