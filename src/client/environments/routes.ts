import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { environment, project } from '../../lib/db/schema.ts'
import { applyValidatedComposeOption } from '../../lib/compose/index.ts'
import { mergeProjectEnvironmentCompose } from './deploy-prepare.ts'
import { reconcileServicesFromCompose } from './reconcile-services.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseDescription,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

type EnvironmentPatchFields = {
  displayName?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

function buildEnvironmentPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): EnvironmentPatchFields | Response {
  let patchFields: EnvironmentPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) {
    patchFields.metadata = metadataResult
  }
  return patchFields
}

async function reconcileServicesAfterOptionsPatch(
  db: Db,
  environmentId: string,
  optionsResult: Record<string, unknown>,
): Promise<void> {
  const [envRow] = await db
    .select({ projectId: environment.projectId, options: environment.options })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!envRow) return

  const [projectRow] = await db
    .select({ options: project.options })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return

  const merged = mergeProjectEnvironmentCompose(projectRow.options, { ...optionsResult })
  if (merged instanceof Response) return
  await reconcileServicesFromCompose(db, environmentId, merged)
}

async function applyEnvironmentOptionsPatch(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  body: Record<string, unknown>,
  patchFields: EnvironmentPatchFields,
): Promise<Response | undefined> {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult === null) return

  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return c.json({ error: 'compose_invalid', issues: composeOption.issues }, 400)
  }
  patchFields.options = optionsResult
  await reconcileServicesAfterOptionsPatch(db, environmentId, optionsResult)
}

export function registerEnvironmentRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment routes')
  }
  const secrets = opts.secrets

  router.use('/environments', createSessionMiddleware(secrets))
  router.use('/environments/:id', createSessionMiddleware(secrets))

  router.get('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const projectId = c.req.query('projectId')

    const visibleIds = await listVisible(db, {
      kind: 'environment',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ environments: [] })
    }

    const conditions = [inArray(environment.id, visibleIds)]
    if (projectId) {
      conditions.push(eq(environment.projectId, projectId))
    }

    const rows = await db
      .select({
        id: environment.id,
        displayName: environment.displayName,
        description: environment.description,
        projectId: environment.projectId,
        metadata: environment.metadata,
        options: environment.options,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      })
      .from(environment)
      .where(and(...conditions))
      .orderBy(environment.createdAt)

    return c.json({ environments: rows })
  })

  router.get('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select({
        id: environment.id,
        displayName: environment.displayName,
        description: environment.description,
        projectId: environment.projectId,
        metadata: environment.metadata,
        options: environment.options,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'environment', id)
    if (denied) return denied

    return c.json({ environment: row })
  })

  router.post('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const projectId = requireStringField(c, body, 'projectId')
    if (projectId instanceof Response) return projectId

    const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
    if (!projectOrgId || projectOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'project', projectId)
    if (denied) return denied

    let displayName: string | null
    let description: string | null
    try {
      displayName = parseDisplayName(body)
      description = parseDescription(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult
    const composeOption = applyValidatedComposeOption(optionsResult)
    if (!composeOption.ok) {
      return c.json({ error: 'compose_invalid', issues: composeOption.issues }, 400)
    }

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(environment)
        .values({
          displayName,
          description,
          projectId,
          ...(metadataResult !== null ? { metadata: metadataResult } : {}),
          ...(optionsResult !== null ? { options: optionsResult } : {}),
        })
        .returning({ id: environment.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'environment', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patchFields = buildEnvironmentPatchFields(c, body)
    if (patchFields instanceof Response) return patchFields

    const optionsError = await applyEnvironmentOptionsPatch(c, db, id, body, patchFields)
    if (optionsError) return optionsError

    await db
      .update(environment)
      .set(patchFields)
      .where(eq(environment.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/environments/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'environment', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(environment).where(eq(environment.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
