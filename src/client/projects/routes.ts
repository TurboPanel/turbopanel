import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
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
  type CreateProjectType,
} from './catalog/index.ts'
import {
  applyValidatedComposeOption,
  emptyComposeDocument,
  stripProjectComposePlacementOption,
} from '../../lib/compose/index.ts'
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
  deleteProjectCascade,
  PROJECT_HAS_RUNNING_SERVICES_ERROR,
} from '../../lib/db/project-delete.ts'

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

async function scaffoldCatalogEnvironments(
  tx: DbTx,
  db: Db,
  projectId: string,
  organizationId: string,
  entry: CatalogEntry,
  secretsConfig: SecretsConfig,
) {
  for (const env of entry.environments) {
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

function resolveCreateProjectType(
  body: Record<string, unknown>,
): CreateProjectType | 'invalid' {
  const rawType = body.type
  if (
    rawType === undefined ||
    rawType === null ||
    rawType === '' ||
    rawType === 'docker-compose'
  ) {
    return 'docker-compose'
  }
  if (typeof rawType !== 'string' || !isCreateProjectType(rawType)) {
    return 'invalid'
  }
  return rawType
}

function resolveCatalogEntryForCreate(
  projectType: CreateProjectType,
  body: Record<string, unknown>,
): CatalogEntry | 'missing_code' | 'unknown_code' | undefined {
  if (projectType !== 'template' && projectType !== 'managed') {
    return undefined
  }
  const code = body.code
  if (typeof code !== 'string' || !code) {
    return 'missing_code'
  }
  const catalogEntry = getCatalogEntry(code)
  if (catalogEntry?.kind !== projectType) {
    return 'unknown_code'
  }
  return catalogEntry
}

function mapCreateProjectError(err: unknown): {
  error: string
  status: 503 | 422
} | null {
  if (!(err instanceof Error)) return null
  if (err.message === 'encryption unavailable') {
    return { error: 'Encryption unavailable', status: 503 }
  }
  if (err.message === 'no encryption-capable daemon for catalog environment') {
    return {
      error: 'No encryption-capable daemon assigned to this environment',
      status: 422,
    }
  }
  return null
}

async function runCreateProjectTransaction(
  db: Db,
  input: {
    projectType: CreateProjectType
    displayName: string | null
    description: string | null
    workspaceId: string
    organizationId: string
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
    catalogEntry: CatalogEntry | undefined
    secretsConfig: SecretsConfig | undefined
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    if (input.projectType === 'docker-compose') {
      return insertDockerComposeProject(tx, {
        displayName: input.displayName,
        description: input.description,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
        options: input.options,
      })
    }

    if (!input.secretsConfig) {
      throw new Error('encryption unavailable')
    }
    if (!input.catalogEntry) {
      throw new TypeError('catalog entry required for template/managed projects')
    }

    return insertCatalogProject(tx, db, {
      projectType: input.projectType,
      displayName: input.displayName,
      description: input.description,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      metadata: input.metadata,
      options: input.options,
      entry: input.catalogEntry,
      secretsConfig: input.secretsConfig,
    })
  })
}

type CreateProjectInput = {
  displayName: string | null
  description: string | null
  workspaceId: string
  organizationId: string
  projectType: CreateProjectType
  catalogEntry: CatalogEntry | undefined
  options: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

async function parseCreateProjectInput(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
): Promise<CreateProjectInput | Response> {
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

  const projectType = resolveCreateProjectType(body)
  if (projectType === 'invalid') {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const catalogEntry = resolveCatalogEntryForCreate(projectType, body)
  if (catalogEntry === 'missing_code') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (catalogEntry === 'unknown_code') {
    return c.json({ error: 'Unknown catalog code' }, 400)
  }

  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  const createComposeOption = applyValidatedComposeOption(optionsResult)
  if (!createComposeOption.ok) {
    return c.json({ error: 'compose_invalid', issues: createComposeOption.issues }, 400)
  }
  stripProjectComposePlacementOption(optionsResult)

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult

  return {
    displayName,
    description,
    workspaceId,
    organizationId,
    projectType,
    catalogEntry,
    options: optionsResult,
    metadata: metadataResult,
  }
}

/**
 * Validates an optional move target for PATCH. Returns `undefined` when no
 * move was requested; otherwise the target workspace id or an error Response.
 */
async function parseProjectMoveTarget(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<string | Response | undefined> {
  if (body.workspaceId === undefined) return undefined

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

  return workspaceId
}

async function insertDockerComposeProject(
  tx: DbTx,
  fields: {
    displayName: string | null
    description: string | null
    workspaceId: string
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
  },
): Promise<string> {
  const compose =
    fields.options && 'compose' in fields.options
      ? fields.options.compose
      : emptyComposeDocument()
  const [inserted] = await tx
    .insert(project)
    .values({
      displayName: fields.displayName,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: fields.metadata ?? { type: 'docker-compose' },
      options: fields.options ?? { compose },
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

async function insertCatalogProject(
  tx: DbTx,
  db: Db,
  fields: {
    projectType: 'template' | 'managed'
    displayName: string | null
    description: string | null
    workspaceId: string
    organizationId: string
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
    entry: CatalogEntry
    secretsConfig: SecretsConfig
  },
): Promise<string> {
  const [inserted] = await tx
    .insert(project)
    .values({
      displayName: fields.displayName,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: fields.metadata ?? { type: fields.projectType },
      options: fields.options ?? { compose: fields.entry.compose },
    })
    .returning({ id: project.id })

  if (fields.projectType === 'managed') {
    const [managedRow] = await tx
      .insert(managed)
      .values({
        projectId: inserted.id,
        metadata: { code: fields.entry.code },
        options: fields.entry.options ?? null,
      })
      .returning({ id: managed.id })

    await tx
      .update(project)
      .set({ metadata: { type: 'managed', managed_id: managedRow.id } })
      .where(eq(project.id, inserted.id))
  }

  await scaffoldCatalogEnvironments(
    tx,
    db,
    inserted.id,
    fields.organizationId,
    fields.entry,
    fields.secretsConfig,
  )
  return inserted.id
}

export function registerProjectRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for project routes')
  }
  const secrets = opts.secrets

  router.use('/projects', createSessionMiddleware(secrets))
  router.use('/projects/:id', createSessionMiddleware(secrets))
  router.use('/project-catalog', createSessionMiddleware(secrets))

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

    const input = await parseCreateProjectInput(c, db, orgResult)
    if (input instanceof Response) return input

    try {
      const id = await runCreateProjectTransaction(db, {
        ...input,
        secretsConfig: c.get('secretsConfig'),
      })
      return c.json({ ok: true as const, id })
    } catch (err) {
      const mapped = mapCreateProjectError(err)
      if (mapped) return c.json({ error: mapped.error }, mapped.status)
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

    const moveTarget = await parseProjectMoveTarget(c, db, body, organizationId)
    if (moveTarget instanceof Response) return moveTarget

    let patchFields: {
      displayName?: string | null
      description?: string | null
      options?: Record<string, unknown> | null
      workspaceId?: string
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
      const composeOption = applyValidatedComposeOption(optionsResult)
      if (!composeOption.ok) {
        return c.json({ error: 'compose_invalid', issues: composeOption.issues }, 400)
      }
      stripProjectComposePlacementOption(optionsResult)
      patchFields.options = optionsResult
    }

    if (moveTarget !== undefined) {
      patchFields.workspaceId = moveTarget
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

    const result = await deleteProjectCascade(db, id)
    if (!result.ok) {
      return c.json({ error: PROJECT_HAS_RUNNING_SERVICES_ERROR }, 409)
    }

    return c.json({ ok: true as const })
  })
}
