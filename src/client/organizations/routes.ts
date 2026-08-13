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
  parseJsonBody,
} from '../shared.ts'
import { getDb } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import { loadOrgServerCapacity } from '../../lib/server-capacity.ts'
import { listTimezones } from '../../lib/timezones.ts'
import {
  defaultEnvironmentGetResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseOrganizationCreateDisplayName,
  parseServerCapacityPutBody,
} from './routes-helpers.ts'
import { registerOrganizationFabricRoutes } from './fabric-routes.ts'

export function registerOrganizationRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/organizations', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/default-timezone', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/default-environment', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/server-capacity', createSessionMiddleware(opts.secrets))
  router.use('/timezones', createSessionMiddleware(opts.secrets))
  registerOrganizationFabricRoutes(router, opts)

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

    const parsedDisplayName = parseOrganizationCreateDisplayName(body)
    if (!parsedDisplayName.ok) {
      return c.json({ error: parsedDisplayName.error }, parsedDisplayName.status)
    }

    const { organizationId } = await createOrganizationForUser(
      db,
      session.userId,
      parsedDisplayName.displayName,
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
    return c.json(defaultTimezoneGetResponse(options))
  })

  router.put('/organizations/:id/default-timezone', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsedPatch = parseDefaultTimezonePatch(body)
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status)
    }
    const patch = parsedPatch.patch

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

    return c.json(defaultTimezonePutResponse(options))
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
    return c.json(defaultEnvironmentGetResponse(options))
  })

  router.put('/organizations/:id/default-environment', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseDefaultEnvironmentPutBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ defaultEnvironmentName: parsed.defaultEnvironmentName })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id))

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    const options = parseOrganizationOptions(updated?.options)

    return c.json(defaultEnvironmentPutResponse(options))
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

    const parsed = parseServerCapacityPutBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ maxServers: parsed.maxServers })
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
