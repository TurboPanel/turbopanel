import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { realm } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
} from '../shared.ts'

export function registerWorkspaceRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/workspaces', createSessionMiddleware(opts.secrets))
  router.use('/workspaces/:id', createSessionMiddleware(opts.secrets))

  router.get('/workspaces', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'workspace',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ workspaces: [] })
    }

    const rows = await db
      .select({
        id: realm.id,
        displayName: realm.displayName,
        organizationId: realm.organizationId,
        createdAt: realm.createdAt,
        updatedAt: realm.updatedAt,
      })
      .from(realm)
      .where(inArray(realm.id, visibleIds))
      .orderBy(realm.createdAt)

    return c.json({ workspaces: rows })
  })

  router.get('/workspaces/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({
        id: realm.id,
        displayName: realm.displayName,
        organizationId: realm.organizationId,
        createdAt: realm.createdAt,
        updatedAt: realm.updatedAt,
      })
      .from(realm)
      .where(eq(realm.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'workspace', id)
    if (denied) return denied

    return c.json({ workspace: row })
  })

  router.post('/workspaces', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const denied = await assertCanCreateOr403(c, 'organization', organizationId, [
      'organization:rw',
      'workspace:rw',
    ])
    if (denied) return denied

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(realm)
        .values({ displayName, organizationId })
        .returning({ id: realm.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/workspaces/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: realm.organizationId })
      .from(realm)
      .where(eq(realm.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'workspace:rw', 'workspace', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: { displayName?: string | null; updatedAt: string }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    await db
      .update(realm)
      .set(patchFields)
      .where(eq(realm.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/workspaces/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: realm.organizationId })
      .from(realm)
      .where(eq(realm.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'workspace:rw', 'workspace', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(realm).where(eq(realm.id, id))
    })

    return c.json({ ok: true as const })
  })
}
