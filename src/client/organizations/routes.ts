import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listAccessibleOrganizations } from '../org-context.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { getDb } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import { isAllowedTimezone, listTimezones } from '../../lib/timezones.ts'

export function registerOrganizationRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/organizations', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/default-timezone', createSessionMiddleware(opts.secrets))
  router.use('/timezones', createSessionMiddleware(opts.secrets))

  router.get('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizations = await listAccessibleOrganizations(db, session.userId)
    return c.json({ organizations })
  })

  router.get('/organizations/:id/default-timezone', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const options = parseOrganizationOptions(orgRow.options)
    return c.json({
      defaultServerTimezone: options.defaultServerTimezone ?? null,
      enforceServerTimezone: options.enforceServerTimezone ?? false,
    })
  })

  router.put('/organizations/:id/default-timezone', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch: {
      defaultServerTimezone?: string | null
      enforceServerTimezone?: boolean
    } = {}

    if ('defaultServerTimezone' in body) {
      if (body.defaultServerTimezone === null) {
        patch.defaultServerTimezone = null
      } else if (
        typeof body.defaultServerTimezone === 'string' &&
        isAllowedTimezone(body.defaultServerTimezone)
      ) {
        patch.defaultServerTimezone = body.defaultServerTimezone
      } else {
        return c.json({ error: 'Invalid defaultServerTimezone' }, 400)
      }
    }

    if ('enforceServerTimezone' in body) {
      if (typeof body.enforceServerTimezone !== 'boolean') {
        return c.json({ error: 'Invalid enforceServerTimezone' }, 400)
      }
      patch.enforceServerTimezone = body.enforceServerTimezone
    }

    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id))

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    const options = parseOrganizationOptions(updated?.options)

    return c.json({
      ok: true as const,
      defaultServerTimezone: options.defaultServerTimezone ?? null,
      enforceServerTimezone: options.enforceServerTimezone ?? false,
    })
  })

  router.get('/timezones', async (c) => {
    return c.json({ timezones: listTimezones() })
  })
}
