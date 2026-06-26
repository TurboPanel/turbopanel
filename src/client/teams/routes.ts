import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { canManageOrganization } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { team } from '../../lib/db/schema.ts'
import { getOrgId } from '../shared.ts'

export function registerTeamRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/teams', createSessionMiddleware(opts.secrets))

  router.get('/teams', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const canManage = await canManageOrganization(
      db,
      session.userId,
      organizationId,
    )
    if (!canManage) {
      return c.json({ teams: [] })
    }

    const rows = await db
      .select({
        id: team.id,
        displayName: team.displayName,
        organizationId: team.organizationId,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
      })
      .from(team)
      .where(eq(team.organizationId, organizationId))
      .orderBy(team.createdAt)

    return c.json({ teams: rows })
  })
}
