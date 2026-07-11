import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecretForDaemon } from '../authn/data-encryption.ts'
import type { SecretsConfig } from '../authn/secrets.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { environment, managed, project, variable, workspace } from '../../lib/db/schema.ts'
import {
  getCatalogEntry,
  isCreateProjectType,
  listCatalog,
  type CatalogEntry,
} from './catalog/index.ts'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
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
import { resolveEnvironmentDaemonRecipient } from '../variables/resolve-environment-daemon.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

async function scaffoldCatalogEnvironments(
  tx: DbTx,
  db: Db,
  projectId: string,
  organizationId: string,
  entry: CatalogEntry,
  secretsConfig: SecretsConfig,
) {
  for (let envIdx = 0; envIdx < entry.environments.length; envIdx++) {
    const env = entry.environments[envIdx]
    const [insertedEnv] = await tx
      .insert(environment)
      .values({
        projectId,
        displayName: env.displayName,
        description: env.description ?? null,
        options: env.compose ? { compose: env.compose } : null,
      })
      .returning({ id: environment.id })

    if (!env.variables) continue

    const recipient = await resolveEnvironmentDaemonRecipient(
      db,
      insertedEnv.id,
      organizationId,
    )
    if (!recipient) {
      throw new Error('no encryption-capable daemon for catalog environment')
    }

    for (const v of env.variables) {
      let storedValue: string | null = v.value
      if (v.isSecret) {
        storedValue = await encryptSecretForDaemon(secretsConfig, recipient, v.value)
      }
      await tx.insert(variable).values({
        environmentId: insertedEnv.id,
        key: v.key,
        value: storedValue,
        isSecret: v.isSecret,
      })
    }
  }
}

export function registerProjectRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/projects', createSessionMiddleware(opts.secrets))
  router.use('/projects/:id', createSessionMiddleware(opts.secrets))
  router.use('/project-catalog', createSessionMiddleware(opts.secrets))

  router.get('/project-catalog', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    return c.json({ catalog: listCatalog() })
  })

  router.get('/projects', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const workspaceId = c.req.query('workspaceId')

    const visibleIds = await listVisible(db, {
      kind: 'project',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ projects: [] })
    }

    const conditions = [inArray(project.id, visibleIds)]
    if (workspaceId) {
      conditions.push(eq(project.workspaceId, workspaceId))
    }

    const rows = await db
      .select({
        id: project.id,
        displayName: project.displayName,
        description: project.description,
        workspaceId: project.workspaceId,
        metadata: project.metadata,
        options: project.options,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })
      .from(project)
      .where(and(...conditions))
      .orderBy(project.createdAt)

    return c.json({ projects: rows })
  })

  router.get('/projects/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'project', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select({
        id: project.id,
        displayName: project.displayName,
        description: project.description,
        workspaceId: project.workspaceId,
        metadata: project.metadata,
        options: project.options,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'project', id)
    if (denied) return denied

    return c.json({ project: row })
  })

  router.post('/projects', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const workspaceId = requireStringField(c, body, 'workspaceId')
    if (workspaceId instanceof Response) return workspaceId

    const workspaceRows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.id, workspaceId), eq(workspace.organizationId, organizationId)))
      .limit(1)

    if (!workspaceRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'workspace', workspaceId)
    if (denied) return denied

    let displayName: string | null
    let description: string | null
    try {
      displayName = parseDisplayName(body)
      description = parseDescription(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const rawType = body.type
    let projectType: 'docker-compose' | 'template' | 'managed'
    if (
      rawType === undefined ||
      rawType === null ||
      rawType === '' ||
      rawType === 'docker-compose'
    ) {
      projectType = 'docker-compose'
    } else if (rawType === 'blank') {
      // Removed type — treat legacy clients as docker-compose
      projectType = 'docker-compose'
    } else if (typeof rawType !== 'string' || !isCreateProjectType(rawType)) {
      return c.json({ error: 'Invalid request' }, 400)
    } else {
      projectType = rawType
    }

    let catalogEntry: CatalogEntry | undefined
    if (projectType === 'template' || projectType === 'managed') {
      const code = body.code
      if (typeof code !== 'string' || !code) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      catalogEntry = getCatalogEntry(code)
      if (!catalogEntry || catalogEntry.kind !== projectType) {
        return c.json({ error: 'Unknown catalog code' }, 400)
      }
    }

    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult

    const secretsConfig = c.get('secretsConfig')

    try {
      const id = await db.transaction(async (tx) => {
      if (projectType === 'docker-compose') {
        const compose =
          optionsResult && 'compose' in optionsResult
            ? optionsResult.compose
            : emptyComposeDocument()
        const [inserted] = await tx
          .insert(project)
          .values({
            displayName,
            description,
            workspaceId,
            metadata: metadataResult ?? { type: 'docker-compose' },
            options: optionsResult ?? { compose },
          })
          .returning({ id: project.id })
        await tx.insert(environment).values({
          projectId: inserted.id,
          displayName: 'production',
          description: 'Default environment',
          options: { compose: emptyComposeDocument() },
        })
        return inserted.id
      }

      const entry = catalogEntry!

      if (!secretsConfig) {
        throw new Error('encryption unavailable')
      }

      if (projectType === 'template') {
        const [inserted] = await tx
          .insert(project)
          .values({
            displayName,
            description,
            workspaceId,
            metadata: metadataResult ?? { type: 'template' },
            options: optionsResult ?? { compose: entry.compose },
          })
          .returning({ id: project.id })
        await scaffoldCatalogEnvironments(
          tx,
          db,
          inserted.id,
          organizationId,
          entry,
          secretsConfig,
        )
        return inserted.id
      }

      const [inserted] = await tx
        .insert(project)
        .values({
          displayName,
          description,
          workspaceId,
          metadata: metadataResult ?? { type: 'managed' },
          options: optionsResult ?? { compose: entry.compose },
        })
        .returning({ id: project.id })

      const [managedRow] = await tx
        .insert(managed)
        .values({
          projectId: inserted.id,
          metadata: { code: entry.code },
          options: entry.options ?? null,
        })
        .returning({ id: managed.id })

      await tx
        .update(project)
        .set({ metadata: { type: 'managed', managed_id: managedRow.id } })
        .where(eq(project.id, inserted.id))

      await scaffoldCatalogEnvironments(
        tx,
        db,
        inserted.id,
        organizationId,
        entry,
        secretsConfig,
      )
      return inserted.id
      })

      return c.json({ ok: true as const, id })
    } catch (err) {
    if (err instanceof Error && err.message === 'encryption unavailable') {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }
    if (err instanceof Error && err.message === 'no encryption-capable daemon for catalog environment') {
      return c.json(
        { error: 'No encryption-capable daemon assigned to this environment' },
        422,
      )
    }
    throw err
    }
  })

  router.patch('/projects/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'project', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'project', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: {
      displayName?: string | null
      description?: string | null
      options?: Record<string, unknown> | null
      updatedAt: string
    }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult
    if (optionsResult !== null) {
      patchFields.options = optionsResult
    }

    await db
      .update(project)
      .set(patchFields)
      .where(eq(project.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/projects/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'project', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'project', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(project).where(eq(project.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
