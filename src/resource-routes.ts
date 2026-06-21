import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from './authn/http.ts'
import { createSessionMiddleware, type SessionData } from './authn/middleware.ts'
import {
  assertCanOr403,
  can,
  listVisible,
} from './authz/index.ts'
import type { PermissionKey } from './authz/index.ts'
import { getDb } from './db.ts'
import {
  environment,
  hosting,
  project,
  realm,
  service,
} from './db/schema.ts'
import { CLIENT_API_PREFIX } from './surfaces.ts'

const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]+$/

class BadRequestError extends Error {}

function getOrgId(c: Context, session: SessionData): string | Response {
  const { organizationId } = session
  if (!organizationId) {
    return c.json({ error: 'No organization' }, 400)
  }
  return organizationId
}

function parseDisplayName(body: Record<string, unknown>): string | null {
  if (body.displayName === undefined) {
    return null
  }
  if (typeof body.displayName !== 'string') {
    throw new BadRequestError('Invalid request')
  }
  const name = body.displayName
  if (name.length < 1 || name.length > 255 || !DISPLAY_NAME_RE.test(name)) {
    throw new BadRequestError('Invalid request')
  }
  return name
}

/** PATCH payload: omit `displayName` when absent so partial updates do not clear it. */
function buildPatchUpdateFields(
  body: Record<string, unknown>,
): { displayName?: string | null; updatedAt: string } {
  const updatedAt = new Date().toISOString()
  if (body.displayName === undefined) {
    return { updatedAt }
  }
  if (typeof body.displayName !== 'string') {
    throw new BadRequestError('Invalid request')
  }
  const name = body.displayName
  if (name.length < 1 || name.length > 255 || !DISPLAY_NAME_RE.test(name)) {
    throw new BadRequestError('Invalid request')
  }
  return { displayName: name, updatedAt }
}

/** Read access: allow when either `<kind>:ro` or `<kind>:rw` is granted (matches listVisible). */
async function assertCanReadOr403(
  c: Context,
  kind: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const roKey = `${kind}:ro` as PermissionKey
  const rwKey = `${kind}:rw` as PermissionKey
  const allowed =
    (await can(db, session.userId, roKey, kind, entityId)) ||
    (await can(db, session.userId, rwKey, kind, entityId))

  if (!allowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return null
}

/** Create access: allow when any listed permission is granted on the parent scope. */
async function assertCanCreateOr403(
  c: Context,
  parentKind: string,
  parentId: string,
  permissionKeys: PermissionKey[],
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  for (const key of permissionKeys) {
    if (await can(db, session.userId, key, parentKind, parentId)) {
      return null
    }
  }
  return c.json({ error: 'Forbidden' }, 403)
}

async function parseJsonBody(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  const rawBody = await c.req.text().catch(() => '')
  if (!rawBody.trim()) {
    return {}
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return body as Record<string, unknown>
}

function requireStringField(
  c: Context,
  body: Record<string, unknown>,
  field: string,
): string | Response {
  const value = body[field]
  if (typeof value !== 'string' || !value) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

/**
 * Resource tree CRUD for realms, environments, projects, services, and hostings.
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerResourceRoutes(app: Hono, opts: AuthRouteOpts) {
  const resourceRouter = new Hono()

  resourceRouter.use('/realms', createSessionMiddleware(opts.secrets))
  resourceRouter.use('/realms/:id', createSessionMiddleware(opts.secrets))

  resourceRouter.get('/realms', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'realm',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ realms: [] })
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

    return c.json({ realms: rows })
  })

  resourceRouter.get('/realms/:id', async (c) => {
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

    const denied = await assertCanReadOr403(c, 'realm', id)
    if (denied) return denied

    return c.json({ realm: row })
  })

  resourceRouter.post('/realms', async (c) => {
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
      'realm:rw',
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

  resourceRouter.patch('/realms/:id', async (c) => {
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

    const denied = await assertCanOr403(c, 'realm:rw', 'realm', id)
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

  resourceRouter.delete('/realms/:id', async (c) => {
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

    const denied = await assertCanOr403(c, 'realm:rw', 'realm', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(realm).where(eq(realm.id, id))
    })

    return c.json({ ok: true as const })
  })

  resourceRouter.use('/environments', createSessionMiddleware(opts.secrets))
  resourceRouter.use('/environments/:id', createSessionMiddleware(opts.secrets))

  resourceRouter.get('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const realmId = c.req.query('realmId')

    const visibleIds = await listVisible(db, {
      kind: 'environment',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ environments: [] })
    }

    const conditions = [inArray(environment.id, visibleIds)]
    if (realmId) {
      conditions.push(eq(environment.realmId, realmId))
    }

    const rows = await db
      .select({
        id: environment.id,
        displayName: environment.displayName,
        organizationId: environment.organizationId,
        realmId: environment.realmId,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      })
      .from(environment)
      .where(and(...conditions))
      .orderBy(environment.createdAt)

    return c.json({ environments: rows })
  })

  resourceRouter.get('/environments/:id', async (c) => {
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
        id: environment.id,
        displayName: environment.displayName,
        organizationId: environment.organizationId,
        realmId: environment.realmId,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'environment', id)
    if (denied) return denied

    return c.json({ environment: row })
  })

  resourceRouter.post('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const realmId = requireStringField(c, body, 'realmId')
    if (realmId instanceof Response) return realmId

    const realmRows = await db
      .select({ id: realm.id })
      .from(realm)
      .where(and(eq(realm.id, realmId), eq(realm.organizationId, organizationId)))
      .limit(1)

    if (!realmRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'realm', realmId, [
      'realm:rw',
      'environment:rw',
    ])
    if (denied) return denied

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(environment)
        .values({ displayName, organizationId, realmId })
        .returning({ id: environment.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  resourceRouter.patch('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: environment.organizationId })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'environment:rw', 'environment', id)
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
      .update(environment)
      .set(patchFields)
      .where(eq(environment.id, id))

    return c.json({ ok: true as const })
  })

  resourceRouter.delete('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: environment.organizationId })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'environment:rw', 'environment', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(environment).where(eq(environment.id, id))
    })

    return c.json({ ok: true as const })
  })

  resourceRouter.use('/projects', createSessionMiddleware(opts.secrets))
  resourceRouter.use('/projects/:id', createSessionMiddleware(opts.secrets))

  resourceRouter.get('/projects', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const environmentId = c.req.query('environmentId')

    const visibleIds = await listVisible(db, {
      kind: 'project',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ projects: [] })
    }

    const conditions = [inArray(project.id, visibleIds)]
    if (environmentId) {
      conditions.push(eq(project.environmentId, environmentId))
    }

    const rows = await db
      .select({
        id: project.id,
        displayName: project.displayName,
        organizationId: project.organizationId,
        environmentId: project.environmentId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })
      .from(project)
      .where(and(...conditions))
      .orderBy(project.createdAt)

    return c.json({ projects: rows })
  })

  resourceRouter.get('/projects/:id', async (c) => {
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
        id: project.id,
        displayName: project.displayName,
        organizationId: project.organizationId,
        environmentId: project.environmentId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'project', id)
    if (denied) return denied

    return c.json({ project: row })
  })

  resourceRouter.post('/projects', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const environmentId = requireStringField(c, body, 'environmentId')
    if (environmentId instanceof Response) return environmentId

    const envRows = await db
      .select({ id: environment.id })
      .from(environment)
      .where(
        and(
          eq(environment.id, environmentId),
          eq(environment.organizationId, organizationId),
        ),
      )
      .limit(1)

    if (!envRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'environment', environmentId, [
      'environment:rw',
      'project:rw',
    ])
    if (denied) return denied

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(project)
        .values({ displayName, organizationId, environmentId })
        .returning({ id: project.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  resourceRouter.patch('/projects/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: project.organizationId })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'project:rw', 'project', id)
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
      .update(project)
      .set(patchFields)
      .where(eq(project.id, id))

    return c.json({ ok: true as const })
  })

  resourceRouter.delete('/projects/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: project.organizationId })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'project:rw', 'project', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(project).where(eq(project.id, id))
    })

    return c.json({ ok: true as const })
  })

  resourceRouter.use('/services', createSessionMiddleware(opts.secrets))
  resourceRouter.use('/services/:id', createSessionMiddleware(opts.secrets))

  resourceRouter.get('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const projectId = c.req.query('projectId')

    const visibleIds = await listVisible(db, {
      kind: 'service',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ services: [] })
    }

    const conditions = [inArray(service.id, visibleIds)]
    if (projectId) {
      conditions.push(eq(service.projectId, projectId))
    }

    const rows = await db
      .select({
        id: service.id,
        displayName: service.displayName,
        organizationId: service.organizationId,
        projectId: service.projectId,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
      })
      .from(service)
      .where(and(...conditions))
      .orderBy(service.createdAt)

    return c.json({ services: rows })
  })

  resourceRouter.get('/services/:id', async (c) => {
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
        id: service.id,
        displayName: service.displayName,
        organizationId: service.organizationId,
        projectId: service.projectId,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
      })
      .from(service)
      .where(eq(service.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'service', id)
    if (denied) return denied

    return c.json({ service: row })
  })

  resourceRouter.post('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const projectId = requireStringField(c, body, 'projectId')
    if (projectId instanceof Response) return projectId

    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(
        and(eq(project.id, projectId), eq(project.organizationId, organizationId)),
      )
      .limit(1)

    if (!projectRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'project', projectId, [
      'project:rw',
      'service:rw',
    ])
    if (denied) return denied

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(service)
        .values({ displayName, organizationId, projectId })
        .returning({ id: service.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  resourceRouter.patch('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: service.organizationId })
      .from(service)
      .where(eq(service.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'service:rw', 'service', id)
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
      .update(service)
      .set(patchFields)
      .where(eq(service.id, id))

    return c.json({ ok: true as const })
  })

  resourceRouter.delete('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: service.organizationId })
      .from(service)
      .where(eq(service.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'service:rw', 'service', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(service).where(eq(service.id, id))
    })

    return c.json({ ok: true as const })
  })

  resourceRouter.use('/hostings', createSessionMiddleware(opts.secrets))
  resourceRouter.use('/hostings/:id', createSessionMiddleware(opts.secrets))

  resourceRouter.get('/hostings', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const projectId = c.req.query('projectId')

    const visibleIds = await listVisible(db, {
      kind: 'hosting',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ hostings: [] })
    }

    const conditions = [inArray(hosting.id, visibleIds)]
    if (projectId) {
      conditions.push(eq(hosting.projectId, projectId))
    }

    const rows = await db
      .select({
        id: hosting.id,
        displayName: hosting.displayName,
        organizationId: hosting.organizationId,
        projectId: hosting.projectId,
        createdAt: hosting.createdAt,
        updatedAt: hosting.updatedAt,
      })
      .from(hosting)
      .where(and(...conditions))
      .orderBy(hosting.createdAt)

    return c.json({ hostings: rows })
  })

  resourceRouter.get('/hostings/:id', async (c) => {
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
        id: hosting.id,
        displayName: hosting.displayName,
        organizationId: hosting.organizationId,
        projectId: hosting.projectId,
        createdAt: hosting.createdAt,
        updatedAt: hosting.updatedAt,
      })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'hosting', id)
    if (denied) return denied

    return c.json({ hosting: row })
  })

  resourceRouter.post('/hostings', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const projectId = requireStringField(c, body, 'projectId')
    if (projectId instanceof Response) return projectId

    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(
        and(eq(project.id, projectId), eq(project.organizationId, organizationId)),
      )
      .limit(1)

    if (!projectRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'project', projectId, [
      'project:rw',
      'hosting:rw',
    ])
    if (denied) return denied

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(hosting)
        .values({ displayName, organizationId, projectId })
        .returning({ id: hosting.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  resourceRouter.patch('/hostings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: hosting.organizationId })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'hosting:rw', 'hosting', id)
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
      .update(hosting)
      .set(patchFields)
      .where(eq(hosting.id, id))

    return c.json({ ok: true as const })
  })

  resourceRouter.delete('/hostings/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = getOrgId(c, session)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const rows = await db
      .select({ organizationId: hosting.organizationId })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)

    const row = rows[0]
    if (!row || row.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'hosting:rw', 'hosting', id)
    if (denied) return denied

    await db.transaction(async (tx) => {
      await tx.delete(hosting).where(eq(hosting.id, id))
    })

    return c.json({ ok: true as const })
  })

  app.route(CLIENT_API_PREFIX, resourceRouter)
}
