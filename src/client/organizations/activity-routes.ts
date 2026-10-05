/**
 * `GET /organizations/:id/activity` — the organization's running and recently
 * failed deploys, restarts and stops. The caller polls it; nothing is pushed.
 *
 * Same gate as the members list: an organization the session cannot reach is a
 * 404, a reachable one without owner/manager rights is a 403, and the rows are
 * limited to servers the caller can see. The path id alone drives both the
 * check and the query — never the active-organization header.
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import { queryOrgActivityFeed, parseActivityQuery } from '../../features/commands/activity-query.ts'
import { isUuid } from '../access/routes-helpers.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { canManageOrganization, listVisible } from '../authz/index.ts'
import { canAccessOrganization } from '../org-context.ts'

const PATH = '/organizations/:id/activity'

export function registerOrganizationActivityRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization activity routes')
  }
  router.use(PATH, createSessionMiddleware(opts.secrets))

  router.get(PATH, async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizationId = c.req.param('id')
    if (!isUuid(organizationId)) return c.json({ error: 'Not found' }, 404)
    if (!(await canAccessOrganization(db, session.userId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }
    if (!(await canManageOrganization(db, session.userId, organizationId))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const parsed = parseActivityQuery({
      filter: c.req.query('filter'),
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    })
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const visibleServerIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })
    const feed = await queryOrgActivityFeed(db, organizationId, visibleServerIds, parsed.query)
    return c.json({ ok: true, ...feed })
  })
}
