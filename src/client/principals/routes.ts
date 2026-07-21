import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { organization, principal, server } from '../../lib/db/schema.ts'
import {
  assertCanManageOr403,
  getOrgId,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
} from '../shared.ts'
import { parseResourceLimits } from '../../lib/resource-limits.ts'
import { serializeProjectPrincipal } from './serialize.ts'

const SYSTEM_PRINCIPAL_UID_START = 10_001

async function allocatePrincipalUid(
  db: ReturnType<typeof getDb>,
  organizationId: string,
): Promise<{ uid: number; gid: number }> {
  if (!db) throw new Error('Database unavailable')

  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)

  const options = orgRow?.options && typeof orgRow.options === 'object'
    ? orgRow.options as Record<string, unknown>
    : {}
  const nextUid = typeof options.nextPrincipalUid === 'number'
    ? Math.floor(options.nextPrincipalUid)
    : SYSTEM_PRINCIPAL_UID_START

  await db.update(organization).set({
    options: { ...options, nextPrincipalUid: nextUid + 1 },
    updatedAt: new Date().toISOString(),
  }).where(eq(organization.id, organizationId))

  return { uid: nextUid, gid: nextUid }
}

export function registerProjectPrincipalRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/projects/:projectId/principals', createSessionMiddleware(opts.secrets))
  router.use('/projects/:projectId/principals/:id', createSessionMiddleware(opts.secrets))

  router.get('/projects/:projectId/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
    if (!projectOrgId || projectOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    const rows = await db
      .select({
        id: principal.id,
        kind: principal.kind,
        provider: principal.provider,
        username: principal.username,
        projectId: principal.projectId,
        metadata: principal.metadata,
        options: principal.options,
        createdAt: principal.createdAt,
        updatedAt: principal.updatedAt,
      })
      .from(principal)
      .where(eq(principal.projectId, projectId))

    return c.json({ principals: rows.map(serializeProjectPrincipal) })
  })

  router.post('/projects/:projectId/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
    if (!projectOrgId || projectOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const username = requireStringField(c, body, 'username')
    if (username instanceof Response) return username

    const { uid, gid } = await allocatePrincipalUid(db, orgResult)

    const [inserted] = await db.insert(principal).values({
      kind: 'system',
      provider: 'pam',
      username,
      projectId,
      metadata: { uid, gid, home: `/var/lib/turbopanel/principals/${username}` },
      options: parseJsonbObject(body.options) ?? null,
    }).returning({ id: principal.id })

    return c.json({ ok: true as const, id: inserted.id, uid, gid })
  })

  router.delete('/projects/:projectId/principals/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const id = c.req.param('id')

    const [row] = await db.select().from(principal).where(eq(principal.id, id)).limit(1)
    if (row?.projectId !== projectId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    await db.delete(principal).where(eq(principal.id, id))
    return c.json({ ok: true as const })
  })
}

export function registerOrganizationLimitsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/organizations/:id/resource-limits', createSessionMiddleware(opts.secrets))

  router.get('/organizations/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    if (id !== orgResult) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanOr403(c, 'organization:manage', 'organization', id)
    if (denied) return denied

    const [orgRow] = await db.select({ options: organization.options }).from(organization).where(
      eq(organization.id, id),
    ).limit(1)

    const options = orgRow?.options && typeof orgRow.options === 'object'
      ? orgRow.options as Record<string, unknown>
      : {}

    return c.json({
      resourceLimits: parseResourceLimits(options.resourceLimits) ?? {},
    })
  })

  router.put('/organizations/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    if (id !== orgResult) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanOr403(c, 'organization:own', 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const limits = parseResourceLimits(body.resourceLimits)
    if (limits === null) return c.json({ error: 'Invalid request' }, 400)

    const [orgRow] = await db.select({ options: organization.options }).from(organization).where(
      eq(organization.id, id),
    ).limit(1)

    const prevOptions = orgRow?.options && typeof orgRow.options === 'object'
      ? orgRow.options as Record<string, unknown>
      : {}

    await db.update(organization).set({
      options: { ...prevOptions, resourceLimits: limits },
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id))

    return c.json({ ok: true as const, resourceLimits: limits })
  })
}

export function registerServerLimitsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/servers/:id/resource-limits', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    const serverOrgId = await resolveEntityOrganizationId(db, 'server', id)
    if (!serverOrgId || serverOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'server', id)
    if (denied) return denied

    const [serverRow] = await db.select({ options: server.options }).from(server).where(
      eq(server.id, id),
    ).limit(1)

    const options = serverRow?.options && typeof serverRow.options === 'object'
      ? serverRow.options as Record<string, unknown>
      : {}

    return c.json({
      resourceLimits: parseResourceLimits(options.resourceLimits) ?? {},
    })
  })

  router.put('/servers/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    const serverOrgId = await resolveEntityOrganizationId(db, 'server', id)
    if (!serverOrgId || serverOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'server', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const limits = parseResourceLimits(body.resourceLimits)
    if (limits === null) return c.json({ error: 'Invalid request' }, 400)

    const [serverRow] = await db.select({ options: server.options }).from(server).where(
      eq(server.id, id),
    ).limit(1)

    const prevOptions = serverRow?.options && typeof serverRow.options === 'object'
      ? serverRow.options as Record<string, unknown>
      : {}

    await db.update(server).set({
      options: { ...prevOptions, resourceLimits: limits },
      updatedAt: new Date().toISOString(),
    }).where(eq(server.id, id))

    return c.json({ ok: true as const, resourceLimits: limits })
  })
}
