import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listAccessibleOrganizations } from '../org-context.ts'
import { getDb } from '../../db.ts'

export function registerOrganizationRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/organizations', createSessionMiddleware(opts.secrets))

  router.get('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizations = await listAccessibleOrganizations(db, session.userId)
    return c.json({ organizations })
  })
}
