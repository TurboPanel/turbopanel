import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { environment, project, variable, workspace } from '../../lib/db/schema.ts'
import {
  getCatalogEntry,
  isCreateProjectType,
  isManagedEngineCatalogEntry,
  listCatalog,
  resolveCatalogVariablePlaintext,
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
  assertNotSystemOwnedOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseDescription,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
  stripPromotedMetadataKeys,
} from '../shared.ts'
import {
  deleteProjectCascade,
  PROJECT_HAS_RUNNING_SERVICES_ERROR,
} from '../../lib/db/project-delete.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { reconcileServicesForProject } from '../environments/reconcile-after-compose-save.ts'
import {
  parseContainerNamingInput,
  parseDefaultServerIdInput,
} from '../../lib/project-options.ts'
import { isPlacementServerId } from '../../lib/compose/placement.ts'
import {
  configureProjectType,
  DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
  insertEmptyProject,
  isConfiguredProjectType,
  isProductionEnvironmentName,
  loadDefaultEnvironmentName,
} from './empty-setup.ts'
import {
  isProjectDisplayNameTaken,
  PROJECT_NAME_IN_USE_ERROR,
} from '../display-name-uniqueness.ts'

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function scaffoldCatalogEnvironments(
  tx: DbTx,
  projectId: string,
  entry: CatalogEntry,
  dataEncryptionSecrets: DerivedSecretsConfig,
  serverId?: string | null,
  defaultEnvironmentName?: string,
) {
  for (const env of entry.environments) {
    const displayName = isProductionEnvironmentName(env.displayName)
      ? (defaultEnvironmentName ?? env.displayName)
      : env.displayName
    const [insertedEnv] = await tx
      .insert(environment)
      .values({
        projectId,
        name: displayName,
        description: env.description ?? null,
        ...(serverId ? { serverId } : {}),
        options: env.compose ? { compose: env.compose } : null,
      })
      .returning({ id: environment.id })

    if (!env.variables) continue

    // One map per environment so sharedCredentialId only aliases within that env.
    const sharedCredentials = new Map<string, string>()

    for (const v of env.variables) {
      const plaintext = resolveCatalogVariablePlaintext(v, sharedCredentials)
      const storedValue = v.isSecret
        ? await encryptSecret(dataEncryptionSecrets, plaintext)
        : plaintext
      await tx.insert(variable).values({
        environmentId: insertedEnv.id,
        key: v.key,
        value: storedValue,
        isSecret: v.isSecret,
      })
    }
  }
}

type ResolvedCreateProjectType = CreateProjectType | 'empty'

function resolveCreateProjectType(
  body: Record<string, unknown>,
): ResolvedCreateProjectType | 'invalid' {
  const rawType = body.type
  // Missing / blank type is rejected — callers must send an explicit value.
  if (rawType === undefined || rawType === null || rawType === '') {
    return 'invalid'
  }
  // Explicit empty — name + workspace only; type chosen later via configure.
  if (rawType === 'empty') {
    return 'empty'
  }
  if (typeof rawType !== 'string' || !isCreateProjectType(rawType)) {
    return 'invalid'
  }
  return rawType
}

function resolveCatalogEntryForCreate(
  projectType: ResolvedCreateProjectType,
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
  status: 503
} | null {
  if (!(err instanceof Error)) return null
  if (err.message === 'encryption unavailable') {
    return { error: 'Encryption unavailable', status: 503 }
  }
  return null
}

async function runCreateProjectTransaction(
  db: Db,
  input: {
    projectType: ResolvedCreateProjectType
    displayName: string | null
    description: string | null
    workspaceId: string
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
    catalogEntry: CatalogEntry | undefined
    dataEncryptionSecrets: DerivedSecretsConfig | undefined
    serverId: string | null
    defaultEnvironmentName: string
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    if (input.projectType === 'empty') {
      return insertEmptyProject(tx, {
        name: input.displayName,
        description: input.description,
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        defaultEnvironmentName: input.defaultEnvironmentName,
      })
    }

    if (input.projectType === 'docker-compose') {
      return insertDockerComposeProject(tx, {
        name: input.displayName,
        description: input.description,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
        options: input.options,
        serverId: input.serverId,
        defaultEnvironmentName: input.defaultEnvironmentName,
      })
    }

    if (!input.dataEncryptionSecrets) {
      throw new Error('encryption unavailable')
    }
    if (!input.catalogEntry) {
      throw new TypeError('catalog entry required for template/managed projects')
    }

    return insertCatalogProject(tx, {
      projectType: input.projectType,
      name: input.displayName,
      description: input.description,
      workspaceId: input.workspaceId,
      metadata: input.metadata,
      options: input.options,
      entry: input.catalogEntry,
      dataEncryptionSecrets: input.dataEncryptionSecrets,
      serverId: input.serverId,
      defaultEnvironmentName: input.defaultEnvironmentName,
    })
  })
}

type CreateProjectInput = {
  displayName: string | null
  description: string | null
  workspaceId: string
  organizationId: string
  projectType: ResolvedCreateProjectType
  catalogEntry: CatalogEntry | undefined
  options: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  serverId: string | null
  defaultEnvironmentName: string
}

/**
 * Confirms `workspaceId` belongs to `organizationId` and the caller may
 * create resources within it. Shared by create and move-target validation.
 */
async function resolveWorkspaceTarget(
  c: Context<AppEnv>,
  db: Db,
  workspaceId: string,
  organizationId: string,
): Promise<string | Response> {
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

  const immutable = await assertNotSystemOwnedOr403(c, 'workspace', workspaceId)
  if (immutable) return immutable

  return workspaceId
}

async function resolveWorkspaceIdForCreate(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<string | Response> {
  const workspaceId = requireStringField(c, body, 'workspaceId')
  if (workspaceId instanceof Response) return workspaceId

  return resolveWorkspaceTarget(c, db, workspaceId, organizationId)
}

function parseDisplayNameAndDescription(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): { displayName: string | null; description: string | null } | Response {
  try {
    return {
      displayName: parseDisplayName(body),
      description: parseDescription(body),
    }
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
}

async function resolveServerIdForCreate(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<string | null | Response> {
  if (body.serverId === undefined || body.serverId === null) return null
  if (typeof body.serverId !== 'string' || body.serverId.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (!(await verifyServerInOrg(db, body.serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
  return body.serverId
}

async function parseCreateProjectInput(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
): Promise<CreateProjectInput | Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body

  const workspaceId = await resolveWorkspaceIdForCreate(c, db, body, organizationId)
  if (workspaceId instanceof Response) return workspaceId

  const nameFields = parseDisplayNameAndDescription(c, body)
  if (nameFields instanceof Response) return nameFields
  const { displayName, description } = nameFields

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
  // `metadata.component` is reserved for system project identity — public
  // create must never stamp it (system hierarchy provisions it internally).
  const metadata = metadataResult === null
    ? null
    : stripPromotedMetadataKeys(metadataResult, ['component'])

  const serverId = await resolveServerIdForCreate(c, db, body, organizationId)
  if (serverId instanceof Response) return serverId

  const defaultEnvironmentName = await loadDefaultEnvironmentName(
    db,
    organizationId,
  )

  return {
    displayName,
    description,
    workspaceId,
    organizationId,
    projectType,
    catalogEntry,
    options: optionsResult,
    metadata,
    serverId,
    defaultEnvironmentName,
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

  return resolveWorkspaceTarget(c, db, workspaceId, organizationId)
}

/**
 * Validates optional `options` on PATCH — compose lint + containerNaming +
 * defaultServerId shape. Org membership for defaultServerId is checked in the
 * PATCH handler (async). Returns `null` when options were omitted; otherwise
 * the normalized object or an error Response.
 */
function parseProjectPatchOptions(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Record<string, unknown> | null | Response {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult === null) return null

  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return c.json({ error: 'compose_invalid', issues: composeOption.issues }, 400)
  }

  if ('containerNaming' in optionsResult) {
    const naming = parseContainerNamingInput(optionsResult.containerNaming)
    if (!naming.ok) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    optionsResult.containerNaming = naming.value
  }

  if ('defaultServerId' in optionsResult) {
    const parsed = parseDefaultServerIdInput(optionsResult.defaultServerId)
    if (!parsed.ok) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    if (parsed.value === null) {
      delete optionsResult.defaultServerId
    } else {
      optionsResult.defaultServerId = parsed.value
    }
  }

  stripProjectComposePlacementOption(optionsResult)
  return optionsResult
}

type ProjectPatchFields = {
  displayName?: string | null
  description?: string | null
  options?: Record<string, unknown> | null
  workspaceId?: string
  updatedAt: string
}

function buildProjectPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  moveTarget: string | undefined,
): ProjectPatchFields | Response {
  let patchFields: ProjectPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const optionsResult = parseProjectPatchOptions(c, body)
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult !== null) {
    patchFields.options = optionsResult
  }

  if (moveTarget !== undefined) {
    patchFields.workspaceId = moveTarget
  }

  return patchFields
}

async function assertDefaultServerIdInOrg(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  options: Record<string, unknown> | null | undefined,
): Promise<Response | undefined> {
  if (!options || !('defaultServerId' in options)) return
  const serverId = options.defaultServerId
  if (serverId === undefined || serverId === null) return
  if (!isPlacementServerId(serverId)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (!(await verifyServerInOrg(db, serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
}

async function insertDockerComposeProject(
  tx: DbTx,
  fields: {
    displayName: string | null
    description: string | null
    workspaceId: string
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
    serverId: string | null
    defaultEnvironmentName: string
  },
): Promise<string> {
  const compose =
    fields.options && 'compose' in fields.options
      ? fields.options.compose
      : emptyComposeDocument()
  const [inserted] = await tx
    .insert(project)
    .values({
      name: fields.displayName,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: fields.metadata ?? { type: 'docker-compose' },
      options: fields.options ?? { compose },
    })
    .returning({ id: project.id })
  await tx.insert(environment).values({
    projectId: inserted.id,
    name: fields.defaultEnvironmentName,
    description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
    ...(fields.serverId ? { serverId: fields.serverId } : {}),
    options: { compose: emptyComposeDocument() },
  })
  return inserted.id
}

function catalogProjectOptions(
  fields: {
    options: Record<string, unknown> | null
    entry: CatalogEntry
  },
  includeEngineOptions: boolean,
): Record<string, unknown> {
  if (fields.options) return fields.options
  if (includeEngineOptions && fields.entry.options) {
    return { compose: fields.entry.compose, ...fields.entry.options }
  }
  return { compose: fields.entry.compose }
}

async function insertCatalogProject(
  tx: DbTx,
  fields: {
    projectType: 'template' | 'managed'
    displayName: string | null
    description: string | null
    workspaceId: string
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
    entry: CatalogEntry
    dataEncryptionSecrets: DerivedSecretsConfig
    serverId: string | null
    defaultEnvironmentName: string
  },
): Promise<string> {
  const isEngine =
    fields.projectType === 'managed' && isManagedEngineCatalogEntry(fields.entry)

  const [inserted] = await tx
    .insert(project)
    .values({
      name: fields.displayName,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: fields.metadata ?? {
        type: fields.projectType,
        ...(isEngine ? { code: fields.entry.code } : {}),
      },
      options: catalogProjectOptions(fields, isEngine),
    })
    .returning({ id: project.id })

  // Managed engines scaffold project + environment only; the environment-scoped
  // managed row is created later by provisioning.
  await scaffoldCatalogEnvironments(
    tx,
    inserted.id,
    fields.entry,
    fields.dataEncryptionSecrets,
    fields.serverId,
    fields.defaultEnvironmentName,
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
  router.use('/projects/:id/configure', createSessionMiddleware(secrets))
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
        displayName: project.name,
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
        displayName: project.name,
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

    if (
      await isProjectDisplayNameTaken(
        db,
        input.organizationId,
        input.displayName,
      )
    ) {
      return c.json({ error: PROJECT_NAME_IN_USE_ERROR }, 409)
    }

    try {
      const id = await runCreateProjectTransaction(db, {
        ...input,
        dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
      })
      await reconcileServicesForProject(db, id)
      return c.json({ ok: true as const, id })
    } catch (err) {
      const mapped = mapCreateProjectError(err)
      if (mapped) return c.json({ error: mapped.error }, mapped.status)
      throw err
    }
  })

  /**
   * Apply type / catalog selection to an empty project (resumable setup).
   * Idempotent when already configured with the same type (+ code).
   */
  router.post('/projects/:id/configure', async (c) => {
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

    const denied = await assertCanOr403(c, 'organization:manage', 'project', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'project', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const rawType = body.type
    if (typeof rawType !== 'string' || !isConfiguredProjectType(rawType)) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    let catalogCode: string | undefined
    if (rawType === 'template' || rawType === 'managed') {
      if (typeof body.code !== 'string' || !body.code) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      catalogCode = body.code
    }

    const serverId = await resolveServerIdForCreate(c, db, body, organizationId)
    if (serverId instanceof Response) return serverId

    const defaultEnvironmentName = await loadDefaultEnvironmentName(
      db,
      organizationId,
    )

    const result = await configureProjectType(db, {
      projectId: id,
      projectType: rawType,
      catalogCode,
      dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
      serverId,
      defaultEnvironmentName,
    })
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }

    await reconcileServicesForProject(db, id)
    return c.json({
      ok: true as const,
      alreadyConfigured: result.alreadyConfigured,
    })
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

    const denied = await assertCanOr403(c, 'organization:manage', 'project', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'project', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const moveTarget = await parseProjectMoveTarget(c, db, body, organizationId)
    if (moveTarget instanceof Response) return moveTarget

    const patchFields = buildProjectPatchFields(c, body, moveTarget)
    if (patchFields instanceof Response) return patchFields

    if (
      patchFields.name !== undefined &&
      (await isProjectDisplayNameTaken(
        db,
        organizationId,
        patchFields.name,
        id,
      ))
    ) {
      return c.json({ error: PROJECT_NAME_IN_USE_ERROR }, 409)
    }

    const defaultServerError = await assertDefaultServerIdInOrg(
      c,
      db,
      organizationId,
      patchFields.options,
    )
    if (defaultServerError) return defaultServerError

    await db
      .update(project)
      .set(patchFields)
      .where(eq(project.id, id))

    if (patchFields.options !== undefined) {
      await reconcileServicesForProject(db, id)
    }

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

    const denied = await assertCanOr403(c, 'organization:manage', 'project', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'project', id)
    if (immutable) return immutable

    const result = await deleteProjectCascade(db, id)
    if (!result.ok) {
      return c.json({ error: PROJECT_HAS_RUNNING_SERVICES_ERROR }, 409)
    }

    return c.json({ ok: true as const })
  })
}
