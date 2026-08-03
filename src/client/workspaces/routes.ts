import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { workspace } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseDescription,
  parseJsonBody,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  isWorkspaceDisplayNameTaken,
  WORKSPACE_NAME_IN_USE_ERROR,
} from '../display-name-uniqueness.ts'

export function registerWorkspaceRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/workspaces', createSessionMiddleware(opts.secrets))
  router.use('/workspaces/:id', createSessionMiddleware(opts.secrets))

  router.get('/workspaces', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
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
        id: workspace.id,
        displayName: workspace.displayName,
        description: workspace.description,
        organizationId: workspace.organizationId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(inArray(workspace.id, visibleIds))
      .orderBy(workspace.createdAt)

    return c.json({ workspaces: rows })
  })

  router.get('/workspaces/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({
        id: workspace.id,
        displayName: workspace.displayName,
        description: workspace.description,
        organizationId: workspace.organizationId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(eq(workspace.id, id))
      .limit(1)

    const row = rows[0]
    if (row?.organizationId !== organizationId) {
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

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let displayName: string | null
    let description: string | null
    try {
      displayName = parseDisplayName(body)
      description = parseDescription(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    if (await isWorkspaceDisplayNameTaken(db, organizationId, displayName)) {
      return c.json({ error: WORKSPACE_NAME_IN_USE_ERROR }, 409)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(workspace)
        .values({ displayName, description, organizationId })
        .returning({ id: workspace.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/workspaces/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: workspace.organizationId })
      .from(workspace)
      .where(eq(workspace.id, id))
      .limit(1)

    const row = rows[0]
    if (row?.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'workspace', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: { displayName?: string | null; description?: string | null; updatedAt: string }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    if (
      patchFields.displayName !== undefined &&
      (await isWorkspaceDisplayNameTaken(
        db,
        organizationId,
        patchFields.displayName,
        id,
      ))
    ) {
      return c.json({ error: WORKSPACE_NAME_IN_USE_ERROR }, 409)
    }

    await db
      .update(workspace)
      .set(patchFields)
      .where(eq(workspace.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/workspaces/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: workspace.organizationId })
      .from(workspace)
      .where(eq(workspace.id, id))
      .limit(1)

    const row = rows[0]
    if (row?.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'workspace', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(workspace).where(eq(workspace.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
