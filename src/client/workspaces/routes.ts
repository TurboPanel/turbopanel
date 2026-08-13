import { asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { workspace } from '../../lib/db/schema.ts'
import { applyStorageRetentionOnParentDelete } from '../../lib/db/storage-records.ts'
import { WORKSPACE_KIND_USER } from '../../lib/db/workspace-kind.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
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
import {
  parseWorkspaceCreateNames,
  parseWorkspacePatchNames,
} from './routes-helpers.ts'

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
        displayName: workspace.name,
        description: workspace.description,
        kind: workspace.kind,
        organizationId: workspace.organizationId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(inArray(workspace.id, visibleIds))
      // Secondary `id` break ties when same-transaction inserts share `created_at`
      // (defaultNow() = transaction time) so System precedes Default Workspace.
      .orderBy(asc(workspace.createdAt), asc(workspace.id))

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
        displayName: workspace.name,
        description: workspace.description,
        kind: workspace.kind,
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

    const names = parseWorkspaceCreateNames(body)
    if (!names.ok) {
      return c.json({ error: names.error }, names.status)
    }
    const { displayName, description } = names

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    if (await isWorkspaceDisplayNameTaken(db, organizationId, displayName)) {
      return c.json({ error: WORKSPACE_NAME_IN_USE_ERROR }, 409)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(workspace)
        // Public create is always `user`. `kind='turbopanel'` is reachable only from
        // ensureSystemWorkspace in src/client/system/hierarchy.ts.
        .values({ name: displayName, description, organizationId, kind: WORKSPACE_KIND_USER })
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

    const immutable = await assertNotSystemOwnedOr403(c, 'workspace', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsedPatch = parseWorkspacePatchNames(body)
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status)
    }
    const patchFields = parsedPatch.patch

    if (
      patchFields.name !== undefined &&
      (await isWorkspaceDisplayNameTaken(
        db,
        organizationId,
        patchFields.name,
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

    const immutable = await assertNotSystemOwnedOr403(c, 'workspace', id)
    if (immutable) return immutable

    const result = await runHierarchyDelete(db, async (tx) => {
      await applyStorageRetentionOnParentDelete(tx, { workspaceIds: [id] })
      await tx.delete(workspace).where(eq(workspace.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
