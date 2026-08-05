import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { createOrganizationForUser } from '../authn/install-state.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { listAccessibleOrganizations } from '../org-context.ts'
import {
  assertCanManageOr403,
  BadRequestError,
  parseDisplayName,
  parseJsonBody,
} from '../shared.ts'
import { getDb } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import {
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
  parseOrganizationOptions,
} from '../../lib/organization-options.ts'
import { loadOrgServerCapacity } from '../../lib/server-capacity.ts'
import { isAllowedTimezone, listTimezones } from '../../lib/timezones.ts'

export function registerOrganizationRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/organizations', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/default-timezone', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/default-environment', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/server-capacity', createSessionMiddleware(opts.secrets))
  router.use('/timezones', createSessionMiddleware(opts.secrets))

  router.get('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizations = await listAccessibleOrganizations(db, session.userId)
    return c.json({ organizations })
  })

  router.post('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let displayName: string
    try {
      const parsed = parseDisplayName({
        displayName:
          typeof body.displayName === 'string'
            ? body.displayName
            : 'New Organization',
      })
      displayName = parsed ?? 'New Organization'
    } catch (error) {
      if (error instanceof BadRequestError) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      throw error
    }

    const { organizationId } = await createOrganizationForUser(
      db,
      session.userId,
      displayName,
    )

    return c.json({ ok: true as const, id: organizationId })
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

  router.get('/organizations/:id/default-environment', async (c) => {
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
      defaultEnvironmentName: options.defaultEnvironmentName ?? null,
    })
  })

  router.put('/organizations/:id/default-environment', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    if (!('defaultEnvironmentName' in body)) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const parsed = parseDefaultEnvironmentNameInput(body.defaultEnvironmentName)
    if (!parsed.ok) {
      return c.json(
        {
          error:
            'defaultEnvironmentName must be null or a non-empty name of at most 255 characters using letters, numbers, spaces, dots, underscores, or hyphens',
        },
        400,
      )
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ defaultEnvironmentName: parsed.value })
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
      defaultEnvironmentName: options.defaultEnvironmentName ?? null,
    })
  })

  router.get('/organizations/:id/server-capacity', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const capacity = await loadOrgServerCapacity(db, id)
    if (!capacity) return c.json({ error: 'Not found' }, 404)

    return c.json(capacity)
  })

  router.put('/organizations/:id/server-capacity', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertOrgOwnerOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    if (!('maxServers' in body)) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const parsed = parseMaxServersInput(body.maxServers)
    if (!parsed.ok) {
      return c.json(
        { error: 'maxServers must be a non-negative integer or null' },
        400,
      )
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ maxServers: parsed.value })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id))

    const capacity = await loadOrgServerCapacity(db, id)
    if (!capacity) return c.json({ error: 'Not found' }, 404)

    return c.json({ ok: true as const, ...capacity })
  })

  router.get('/timezones', async (c) => {
    return c.json({ timezones: listTimezones() })
  })
}
