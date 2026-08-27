import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
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
  isManagedEngineCatalogEntry,
  listCatalog,
  resolveCatalogVariablePlaintext,
  type CatalogEntry,
} from './catalog/index.ts'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import { deleteProjectCascade } from '../../lib/db/project-delete.ts'
import {
  planEnvironmentsTeardown,
  reclaimDeletedEnvironmentHosts,
} from '../environments/teardown.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { reconcileServicesForProject } from '../environments/reconcile-after-compose-save.ts'
import {
  configureProjectType,
  DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
  insertEmptyProject,
  isProductionEnvironmentName,
  loadDefaultEnvironmentName,
} from './empty-setup.ts'
import {
  isProjectDisplayNameTaken,
  PROJECT_NAME_IN_USE_ERROR,
} from '../display-name-uniqueness.ts'
import { UUID_RE } from '../repositories/routes-helpers.ts'
import {
  adoptProjectRepository,
  loadOrganizationRepositoryIds,
  loadProjectRepositoryId,
} from '../../lib/db/repository-records.ts'
import {
  assertDefaultServerIdShape,
  catalogProjectOptions,
  mapCreateProjectError,
  normalizeProjectPatchOptions,
  parseConfigureProjectBody,
  parseCreateProjectMetadata,
  parseCreateProjectNames,
  parseCreateProjectOptions,
  parseCreateProjectServerIdField,
  parseJsonbField,
  resolveCatalogEntryForCreate,
  resolveCreateProjectType,
  stampCreateProjectMetadata,
} from './routes-helpers.ts'

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

type ResolvedCreateProjectType = import('./routes-helpers.ts').ResolvedCreateProjectType

function runCreateProjectTransaction(
  db: Db,
  input: {
    projectType: ResolvedCreateProjectType
    name: string | null
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
  return db.transaction((tx) => {
    if (input.projectType === 'empty') {
      return insertEmptyProject(tx, {
        name: input.name,
        description: input.description,
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        defaultEnvironmentName: input.defaultEnvironmentName,
      })
    }

    if (input.projectType === 'docker-compose') {
      return insertDockerComposeProject(tx, {
        name: input.name,
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
      name: input.name,
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
  name: string | null
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

function resolveWorkspaceIdForCreate(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<string | Response> {
  const workspaceId = requireStringField(c, body, 'workspaceId')
  if (workspaceId instanceof Response) return Promise.resolve(workspaceId)

  return resolveWorkspaceTarget(c, db, workspaceId, organizationId)
}

function parseNameAndDescription(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): { name: string | null; description: string | null } | Response {
  const parsed = parseCreateProjectNames(body)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }
  return parsed
}

async function resolveServerIdForCreate(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<string | null | Response> {
  const parsed = parseCreateProjectServerIdField(body)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }
  if (parsed.serverId === undefined) return null
  if (parsed.serverId === null) return null
  if (!(await verifyServerInOrg(db, parsed.serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
  return parsed.serverId
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

  const nameFields = parseNameAndDescription(c, body)
  if (nameFields instanceof Response) return nameFields
  const { name, description } = nameFields

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

  const knownSourceIds = await loadOrganizationRepositoryIds(db, organizationId)
  // A project being created has no binding yet, so the rule is "at most one
  // distinct repository"; the id that survives it is adopted onto the row below.
  const optionsResult = parseCreateProjectOptions(body, {
    knownSourceIds,
    projectRepositoryId: null,
  })
  if (!optionsResult.ok) {
    if ('issues' in optionsResult) {
      return c.json({ error: optionsResult.error, issues: optionsResult.issues }, 400)
    }
    return c.json({ error: optionsResult.error }, optionsResult.status)
  }

  const metadataResult = parseCreateProjectMetadata(body)
  if (!metadataResult.ok) {
    return c.json({ error: metadataResult.error }, metadataResult.status)
  }
  const { metadata } = metadataResult

  const serverId = await resolveServerIdForCreate(c, db, body, organizationId)
  if (serverId instanceof Response) return serverId

  const defaultEnvironmentName = await loadDefaultEnvironmentName(
    db,
    organizationId,
  )

  return {
    name,
    description,
    workspaceId,
    organizationId,
    projectType,
    catalogEntry,
    options: optionsResult.options,
    metadata,
    serverId,
    defaultEnvironmentName,
  }
}

/**
 * Validates an optional move target for PATCH. Returns `undefined` when no
 * move was requested; otherwise the target workspace id or an error Response.
 */
function parseProjectMoveTarget(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<string | Response | undefined> {
  if (body.workspaceId === undefined) return Promise.resolve(undefined)

  const workspaceId = requireStringField(c, body, 'workspaceId')
  if (workspaceId instanceof Response) return Promise.resolve(workspaceId)

  return resolveWorkspaceTarget(c, db, workspaceId, organizationId)
}

/**
 * Validates optional `options` on PATCH — compose lint + containerNaming +
 * defaultServerId shape. Org membership for defaultServerId is checked in the
 * PATCH handler (async). Returns `null` when options were omitted; otherwise
 * the normalized object or an error Response.
 */
/**
 * Optional explicit re-bind of the project's repository on PATCH.
 *
 * Returns `undefined` when the caller did not mention `repositoryId` — the
 * common case, where the stored binding stands. An explicit `null` unbinds.
 *
 * This is the *only* way to move a bound project to a different repository:
 * adoption deliberately never overwrites an existing binding, because a compose
 * save that silently repointed the whole project would be indistinguishable
 * from a typo. Sent alongside the new compose, it is also what makes the swap
 * one save rather than two — the lint below already reads this value, so the
 * document and the binding are checked against each other, not against the
 * binding being replaced.
 */
function parseProjectRepositoryRebind(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): string | null | undefined | Response {
  if (!('repositoryId' in body)) return undefined
  const value = body.repositoryId
  if (value === null) return null
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

function parseProjectPatchOptions(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  knownSourceIds: ReadonlySet<string>,
  projectRepositoryId: string | null,
): Record<string, unknown> | null | Response {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (optionsResult === null) return null

  const normalized = normalizeProjectPatchOptions(optionsResult, {
    knownSourceIds,
    projectRepositoryId,
  })
  if (!normalized.ok) {
    if ('issues' in normalized) {
      return c.json({ error: normalized.error, issues: normalized.issues }, 400)
    }
    return c.json({ error: normalized.error }, normalized.status)
  }
  return normalized.options
}

type ProjectPatchFields = {
  name?: string | null
  description?: string | null
  repositoryId?: string | null
  options?: Record<string, unknown> | null
  workspaceId?: string
  updatedAt: string
}

function buildProjectPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  moveTarget: string | undefined,
  knownSourceIds: ReadonlySet<string>,
  projectRepositoryId: string | null,
): ProjectPatchFields | Response {
  let patchFields: ProjectPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const optionsResult = parseProjectPatchOptions(
    c,
    body,
    knownSourceIds,
    projectRepositoryId,
  )
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
  const shapeError = assertDefaultServerIdShape(options)
  if (shapeError) {
    return c.json({ error: shapeError.error }, shapeError.status)
  }
  if (!options || !('defaultServerId' in options)) return
  const serverId = options.defaultServerId
  if (serverId === undefined || serverId === null) return
  if (typeof serverId !== 'string') return
  if (!(await verifyServerInOrg(db, serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
}

type ManageableProject = {
  db: Db
  organizationId: string
  userId: string
}

/**
 * Shared preamble for the manage-scoped `/projects/:id` routes: database,
 * session, organization membership, ownership of the `:id` path param, the
 * `organization:manage` permission, and the system-owned guard. Returns the
 * error Response for the first check that fails.
 */
async function resolveManageableProject(
  c: Context<AppEnv>,
  id: string,
): Promise<ManageableProject | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(db, 'project', id)
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = await assertCanOr403(c, 'organization:manage', 'project', id)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, 'project', id)
  if (immutable) return immutable

  return { db, organizationId: orgResult, userId: session.userId }
}

type ProjectRepositoryBinding = {
  /** `undefined` when the caller never mentioned `repositoryId`. */
  rebind: string | null | undefined
  /** The binding the patch should lint against: the rebind, else the stored one. */
  projectRepositoryId: string | null
}

async function resolveProjectRepositoryBinding(
  c: Context<AppEnv>,
  db: Db,
  body: Record<string, unknown>,
  id: string,
  knownSourceIds: ReadonlySet<string>,
): Promise<ProjectRepositoryBinding | Response> {
  const rebind = parseProjectRepositoryRebind(c, body)
  if (rebind instanceof Response) return rebind
  if (rebind && !knownSourceIds.has(rebind)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const stored = (await loadProjectRepositoryId(db, id)) ?? null
  return {
    rebind,
    projectRepositoryId: rebind === undefined ? stored : rebind,
  }
}

async function insertDockerComposeProject(
  tx: DbTx,
  fields: {
    name: string | null
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
      name: fields.name,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: stampCreateProjectMetadata(fields.metadata, {
        type: 'docker-compose',
      }),
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

async function insertCatalogProject(
  tx: DbTx,
  fields: {
    projectType: 'template' | 'managed'
    name: string | null
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
      name: fields.name,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: stampCreateProjectMetadata(fields.metadata, {
        type: fields.projectType,
        ...(isEngine ? { code: fields.entry.code } : {}),
      }),
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

  router.get('/project-catalog', (c) => {
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
        name: project.name,
        description: project.description,
        workspaceId: project.workspaceId,
        repositoryId: project.repositoryId,
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
        name: project.name,
        description: project.description,
        workspaceId: project.workspaceId,
        repositoryId: project.repositoryId,
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
        input.name,
      )
    ) {
      return c.json({ error: PROJECT_NAME_IN_USE_ERROR }, 409)
    }

    try {
      const id = await runCreateProjectTransaction(db, {
        ...input,
        dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
      })
      // The wizard seeds a compose draft and creates the project in one act, so
      // the repository the operator picked arrives here inside `options` rather
      // than as a field of its own. `empty` is excluded because it persists no
      // options at all — adopting there would bind a repository the project's
      // compose does not actually name.
      if (input.projectType !== 'empty') {
        await adoptProjectRepository(db, id, input.options, null)
      }
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
    const id = c.req.param('id')
    const scope = await resolveManageableProject(c, id)
    if (scope instanceof Response) return scope
    const { db, organizationId } = scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const configureBody = parseConfigureProjectBody(body)
    if (!configureBody.ok) {
      return c.json({ error: configureBody.error }, configureBody.status)
    }

    const serverId = await resolveServerIdForCreate(c, db, body, organizationId)
    if (serverId instanceof Response) return serverId

    const defaultEnvironmentName = await loadDefaultEnvironmentName(
      db,
      organizationId,
    )

    const result = await configureProjectType(db, {
      projectId: id,
      projectType: configureBody.projectType,
      catalogCode: configureBody.catalogCode,
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
    const id = c.req.param('id')
    const scope = await resolveManageableProject(c, id)
    if (scope instanceof Response) return scope
    const { db, organizationId } = scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const moveTarget = await parseProjectMoveTarget(c, db, body, organizationId)
    if (moveTarget instanceof Response) return moveTarget

    const knownSourceIds = await loadOrganizationRepositoryIds(db, organizationId)
    const binding = await resolveProjectRepositoryBinding(
      c,
      db,
      body,
      id,
      knownSourceIds,
    )
    if (binding instanceof Response) return binding
    const { rebind, projectRepositoryId } = binding

    const patchFields = buildProjectPatchFields(
      c,
      body,
      moveTarget,
      knownSourceIds,
      projectRepositoryId,
    )
    if (patchFields instanceof Response) return patchFields
    if (rebind !== undefined) patchFields.repositoryId = rebind

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
      await adoptProjectRepository(db, id, patchFields.options, projectRepositoryId)
      await reconcileServicesForProject(db, id)
    }

    return c.json({ ok: true as const })
  })

  router.delete('/projects/:id', async (c) => {
    const id = c.req.param('id')
    const scope = await resolveManageableProject(c, id)
    if (scope instanceof Response) return scope
    const { db, userId } = scope

    // Capture host teardown material while the service / hosting / segment
    // rows still exist; the commands go out after the cascade commits.
    const environmentIds = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, id))
    const teardownPlans = await planEnvironmentsTeardown(
      db,
      environmentIds.map((row) => row.id),
    )

    const result = await deleteProjectCascade(db, id)
    if (!result.ok) {
      return c.json({ error: result.error }, 409)
    }

    await reclaimDeletedEnvironmentHosts(
      c,
      db,
      teardownPlans,
      userId,
    )

    return c.json({ ok: true as const })
  })
}
