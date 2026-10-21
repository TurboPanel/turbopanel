import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisibleVersions } from '../authz/index.ts'
import { resolveEntityOrganizationId, resolveEntityVersion } from '../authz/create-access-grant.ts'
import {
  cachedEnvironmentDetail,
  cachedEnvironmentsList,
} from '../../query-cache/read-models/hierarchy-reads.ts'
import { getDb, type Db } from '../../db/connection.ts'
import { environment } from '../../db/schema.ts'
import { settleDeployOptions } from '../../features/deploy/deploy-options.ts'
import {
  deleteEnvironmentCascade,
  type EnvironmentDeleteResult,
  type EnvironmentDeleteRefusal,
} from '../../features/projects/project-delete.ts'
import { verifyServerInOrg } from './deploy-prepare.ts'
import { loadRepinNeedsRedeployForEnvironment } from './repin-needs-redeploy.ts'
import { reconcileServicesForEnvironment } from './reconcile-after-compose-save.ts'
import {
  environmentNameInUse,
  isEnvironmentNameUniqueViolation,
  refuseDeleteWhileFolders,
  updateEnvironmentChecked,
} from './rename-lock.ts'
import { syncEnvironmentWatch } from '../../features/git/watch-records.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import { hierarchyDeleteHasChildrenResponse, isForeignKeyViolation } from '../hierarchy-delete.ts'
import { planEnvironmentTeardown, reclaimDeletedEnvironmentHosts } from './teardown.ts'
import {
  composePrincipalAliases,
  loadProjectOptions,
  loadProjectPrincipalAliases,
  unionAliasSets,
} from '../../features/principals/principal-alias-records.ts'
import {
  adoptProjectRepository,
  loadEnvironmentProjectRepository,
  loadOrganizationRepositoryIds,
  loadProjectRepositoryId,
} from '../../features/git/repository-records.ts'
import { copyOfPrimaryOptions } from '../../features/projects/primary-environment-copy.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  isFirstEnvironmentOf,
  PrimaryEnvironmentConflictError,
  loadPrimaryEnvironment,
  lockProjectForEnvironmentChange,
  setPrimaryEnvironment,
  sortEnvironmentsForDisplay,
} from '../../features/projects/primary-environment.ts'
import {
  parseCreateEnvironmentJsonb,
  parseCreateEnvironmentNames,
  parseCreateEnvironmentStart,
  standAloneEnvironmentOptions,
  parseEnvironmentPatchMetadata,
  parseEnvironmentPatchOptions,
  parseOptionalServerIdShape,
  serializeEnvironment,
} from './routes-helpers.ts'

type EnvironmentPatchFields = {
  name?: string | null
  description?: string | null
  serverId?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  isPinned?: boolean
  updatedAt: string
}

type CreateEnvironmentInput = {
  projectId: string
  /** The parent project's binding, already resolved for the lint above. */
  projectRepositoryId: string | null
  name: string
  description: string | null
  serverId?: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
  /** Plain-words list of what a copy left behind (empty unless the environment is a copy). */
  notCopied: string[]
  /** The copy the options were checked as, to be re-read under the project lock; null when not a copy. */
  copySnapshot: string | null
}

function buildEnvironmentPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>
): EnvironmentPatchFields | Response {
  let patchFields: EnvironmentPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadataResult = parseEnvironmentPatchMetadata(body)
  if (!metadataResult.ok) {
    return c.json({ error: metadataResult.error }, metadataResult.status)
  }
  if (metadataResult.metadata !== 'absent') {
    patchFields.metadata = metadataResult.metadata
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') return c.json({ error: 'Invalid request' }, 400)
    patchFields.isPinned = body.pinned
  }
  return patchFields
}

/**
 * A PATCH replaces `options` wholesale, and the compose editor sends only
 * `compose`: carry the stored deploy settings over unless the body names them.
 */
async function keepStoredDeployOptions(
  db: Db,
  environmentId: string,
  patchFields: EnvironmentPatchFields
): Promise<void> {
  if (!patchFields.options) return
  const [row] = await db
    .select({ options: environment.options })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  patchFields.options = settleDeployOptions(row?.options, patchFields.options, 'environment')
}

/** `{ error }`, plus the detail `message` when the validator supplied one. */
function validationErrorBody(failure: { error: string; message?: string }) {
  return failure.message === undefined
    ? { error: failure.error }
    : { error: failure.error, message: failure.message }
}

function applyEnvironmentOptionsPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  patchFields: EnvironmentPatchFields,
  knownSourceIds: ReadonlySet<string>,
  projectRepositoryId: string | null,
  knownPrincipalAliases: ReadonlySet<string>,
  projectOptions: unknown
): Response | undefined {
  const optionsResult = parseEnvironmentPatchOptions(
    body,
    {
      knownSourceIds,
      knownPrincipalAliases,
      projectRepositoryId,
      // An environment's compose IS the overlay. Linting it as `base` produced
      // a spurious advisory telling the operator that `!reset` / `!override`
      // "only take effect in an overlay compose file" — about the overlay.
      layer: 'overlay',
    },
    // Its changes are then checked as the merge with the Base, not alone.
    projectOptions
  )
  if (!optionsResult.ok) {
    if ('issues' in optionsResult) {
      return c.json({ error: optionsResult.error, issues: optionsResult.issues }, 400)
    }
    return c.json(validationErrorBody(optionsResult), optionsResult.status)
  }
  if (optionsResult.options === 'absent') return
  patchFields.options = optionsResult.options
}

/**
 * Any server in the organization may be pinned — including the co-located
 * control-plane host. Decided 2026-09-17 (user): a single-server install runs
 * the panel and the operator's projects on the same box; the only thing it
 * gives up is multi-node placement. The former 403 guard is gone on purpose.
 */
async function parseOptionalServerId(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>
): Promise<string | null | undefined | Response> {
  const parsed = parseOptionalServerIdShape(body)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }
  if (parsed.serverId === undefined) return undefined
  if (parsed.serverId === null) return null
  if (!(await verifyServerInOrg(db, parsed.serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
  return parsed.serverId
}

async function applyEnvironmentServerIdPatch(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  patchFields: EnvironmentPatchFields
): Promise<Response | undefined> {
  const serverId = await parseOptionalServerId(c, db, organizationId, body)
  if (serverId instanceof Response) return serverId
  if (serverId === undefined) return
  patchFields.serverId = serverId
}

async function parseCreateEnvironmentInput(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string
): Promise<CreateEnvironmentInput | Response> {
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

  const immutable = await assertNotSystemOwnedOr403(c, 'project', projectId)
  if (immutable) return immutable

  const names = parseCreateEnvironmentNames(body)
  if (!names.ok) {
    return c.json(
      names.message === undefined
        ? { error: names.error }
        : { error: names.error, message: names.message },
      names.status
    )
  }

  const startResult = parseCreateEnvironmentStart(body)
  if (!startResult.ok) return c.json(validationErrorBody(startResult), startResult.status)
  // A new environment starts as a copy of the primary one's own changes unless
  // the caller asks for an empty one or sends its own options. The copy goes
  // through the same checks as options a caller typed.
  const {
    body: sourceBody,
    notCopied,
    copySnapshot,
  } = await resolveCreateStartBody(db, projectId, body, startResult.start)

  const knownSourceIds = await loadOrganizationRepositoryIds(db, organizationId)
  // An overlay is part of its project's compose, so it answers to the same
  // one-repository rule — and to the project's binding, not to its own.
  const projectRepositoryId = (await loadProjectRepositoryId(db, projectId)) ?? null
  const jsonb = parseCreateEnvironmentJsonb(
    sourceBody,
    {
      knownSourceIds,
      // Same union as the PATCH lane: the project's persisted root plus this
      // document's own.
      knownPrincipalAliases: unionAliasSets(
        await loadProjectPrincipalAliases(db, projectId),
        composePrincipalAliases(sourceBody.options)
      ),
      layer: 'overlay',
      projectRepositoryId,
    },
    await loadProjectOptions(db, projectId)
  )
  if (!jsonb.ok) {
    if ('issues' in jsonb) {
      return c.json({ error: jsonb.error, issues: jsonb.issues }, 400)
    }
    return c.json(validationErrorBody(jsonb), jsonb.status)
  }

  const serverId = await parseOptionalServerId(c, db, organizationId, body)
  if (serverId instanceof Response) return serverId

  return {
    projectRepositoryId,
    projectId,
    name: names.name,
    description: names.description,
    ...(serverId !== undefined ? { serverId } : {}),
    metadata: jsonb.metadata,
    options: jsonb.options,
    notCopied,
    copySnapshot,
  }
}

function primaryConflict(c: Context<AppEnv>): Response {
  return c.json(
    {
      error: 'primary_environment_conflict',
      message: 'The primary environment changed at the same time. Reload and try again.',
    },
    409
  )
}

/** The body whose `options` the new environment is checked and stored with. */
async function resolveCreateStartBody(
  db: Db,
  projectId: string,
  body: Record<string, unknown>,
  start: 'copy' | 'empty' | null
): Promise<{ body: Record<string, unknown>; notCopied: string[]; copySnapshot: string | null }> {
  const plain = (next: Record<string, unknown>) => ({
    body: next,
    notCopied: [],
    copySnapshot: null,
  })
  if (start === 'empty') return plain({ ...body, options: standAloneEnvironmentOptions() })
  if (start === null && body.options !== undefined && body.options !== null) return plain(body)
  const primary = await loadPrimaryEnvironment(db, projectId)
  if (!primary) return plain(body)
  const copied = copyOfPrimaryOptions(primary.options, await loadProjectOptions(db, projectId))
  return {
    body: copied.options ? { ...body, options: copied.options } : body,
    notCopied: copied.notCopied,
    copySnapshot: JSON.stringify(copied.options),
  }
}

/**
 * Insert the environment under the project lock. A copy is read again under
 * that lock: if the primary (or the Base) changed since the options were
 * checked, nothing is created and the caller gets a conflict.
 */
async function insertEnvironmentLocked(db: Db, input: CreateEnvironmentInput): Promise<string> {
  return await db.transaction(async (tx) => {
    // The first environment of a project is its primary one; the lock keeps
    // two creates from both deciding they are first.
    await lockProjectForEnvironmentChange(tx, input.projectId)
    if (input.copySnapshot !== null) {
      const primary = await loadPrimaryEnvironment(tx, input.projectId)
      const again = primary
        ? copyOfPrimaryOptions(primary.options, await loadProjectOptions(tx, input.projectId))
        : null
      if (JSON.stringify(again?.options ?? null) !== input.copySnapshot) {
        throw new PrimaryEnvironmentConflictError()
      }
    }
    const [inserted] = await tx
      .insert(environment)
      .values({
        name: input.name,
        description: input.description,
        projectId: input.projectId,
        isPrimary: isFirstEnvironmentOf(input.projectId),
        ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
        ...(input.metadata !== null ? { metadata: input.metadata } : {}),
        ...(input.options !== null ? { options: input.options } : {}),
      })
      .returning({ id: environment.id })
    if (input.options !== null) await syncEnvironmentWatch(tx, inserted.id)
    return inserted.id
  })
}

/** A row created while the delete ran trips an FK: report it as "has children". */
async function deleteEnvironmentCascadeGuarded(
  db: Db,
  id: string,
  listenerSync?: Parameters<typeof deleteEnvironmentCascade>[2]
): Promise<EnvironmentDeleteResult | 'has_children'> {
  try {
    return await deleteEnvironmentCascade(db, id, listenerSync)
  } catch (error) {
    if (isForeignKeyViolation(error)) return 'has_children'
    throw error
  }
}

function environmentDeleteRefusal(
  c: Context<AppEnv>,
  error: EnvironmentDeleteRefusal,
  detail?: Record<string, unknown>
): Response {
  return c.json({ error, ...detail }, 409)
}

/** After a saved `options` patch: adopt the repository the compose names and refresh the service rows. */
async function settleAfterOptionsPatch(
  db: Db,
  environmentId: string,
  parent: { projectId: string; repositoryId: string | null } | null | undefined,
  patchFields: EnvironmentPatchFields
): Promise<void> {
  if (patchFields.options === undefined) return
  if (parent) {
    await adoptProjectRepository(db, parent.projectId, patchFields.options, parent.repositoryId)
  }
  await reconcileServicesForEnvironment(db, environmentId)
}

/**
 * Apply an environment PATCH body (name, description, server, metadata, options,
 * pinned) with every check the PATCH route runs. Returns a response when the
 * change is refused, otherwise null. The caller has already checked access.
 */
export async function applyEnvironmentPatch(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  id: string,
  body: Record<string, unknown>
): Promise<Response | null> {
  const patchFields = buildEnvironmentPatchFields(c, body)
  if (patchFields instanceof Response) return patchFields

  const serverIdError = await applyEnvironmentServerIdPatch(
    c,
    db,
    organizationId,
    body,
    patchFields
  )
  if (serverIdError) return serverIdError

  const knownSourceIds = await loadOrganizationRepositoryIds(db, organizationId)
  const parent = await loadEnvironmentProjectRepository(db, id)
  // An overlay answers to the project's root as well as its own: a service
  // here may name an alias the base declared, and one the base did not is a
  // dangling reference either way.
  const optionsError = applyEnvironmentOptionsPatch(
    c,
    body,
    patchFields,
    knownSourceIds,
    parent?.repositoryId ?? null,
    unionAliasSets(
      parent ? await loadProjectPrincipalAliases(db, parent.projectId) : new Set(),
      composePrincipalAliases(body.options)
    ),
    parent ? await loadProjectOptions(db, parent.projectId) : null
  )
  if (optionsError) return optionsError
  await keepStoredDeployOptions(db, id, patchFields)

  const refused = await updateEnvironmentChecked(c, db, id, patchFields, {
    syncWatch: patchFields.options !== undefined,
  })
  if (refused) return refused

  await settleAfterOptionsPatch(db, id, parent, patchFields)
  return null
}

export function registerEnvironmentRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment routes')
  }
  const secrets = opts.secrets

  router.use('/environments', createSessionMiddleware(secrets))
  router.use('/environments/:id', createSessionMiddleware(secrets))
  router.use('/environments/:id/primary', createSessionMiddleware(secrets))

  router.get('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const projectId = c.req.query('projectId')

    // Who may see which environment is decided here, on the primary connection;
    // the visible ids (with when each last changed) go into the cached read.
    const visible = await listVisibleVersions(db, {
      kind: 'environment',
      userId: session.userId,
      organizationId,
    })

    if (visible.length === 0) {
      return c.json({ environments: [] })
    }

    const all = await cachedEnvironmentsList(c, { organizationId, visible })
    const rows = projectId ? all.filter((row) => row.projectId === projectId) : all

    return c.json({ environments: sortEnvironmentsForDisplay(rows).map(serializeEnvironment) })
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
    const entity = await resolveEntityVersion(db, 'environment', id)
    if (entity?.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const row = await cachedEnvironmentDetail(c, {
      organizationId,
      id,
      updatedAt: entity.updatedAt,
    })
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'environment', id)
    if (denied) return denied

    // Derived from `ip.metadata.repin` — a hosting `bindAddress` is frozen at
    // deploy time, so a repinned membership address is surfaced as a notice,
    // never as an automatic `environment.deploy`.
    const needsRedeploy = await loadRepinNeedsRedeployForEnvironment(db, id)

    return c.json({ environment: serializeEnvironment(row), needsRedeploy })
  })

  router.post('/environments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const input = await parseCreateEnvironmentInput(c, db, orgResult)
    if (input instanceof Response) return input

    let id: string
    try {
      id = await insertEnvironmentLocked(db, input)
    } catch (err) {
      if (isEnvironmentNameUniqueViolation(err)) return environmentNameInUse(c)
      if (err instanceof PrimaryEnvironmentConflictError) return primaryConflict(c)
      throw err
    }

    await adoptProjectRepository(db, input.projectId, input.options, input.projectRepositoryId)
    await reconcileServicesForEnvironment(db, id)

    return c.json({ ok: true as const, id, notCopied: input.notCopied })
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

    const immutable = await assertNotSystemOwnedOr403(c, 'environment', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const refused = await applyEnvironmentPatch(c, db, organizationId, id, body)
    if (refused) return refused

    return c.json({ ok: true as const })
  })

  // Make this environment the project's primary one. Idempotent.
  router.post('/environments/:id/primary', async (c) => {
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

    const immutable = await assertNotSystemOwnedOr403(c, 'environment', id)
    if (immutable) return immutable

    const [row] = await db
      .select({ projectId: environment.projectId, wasPrimary: environment.isPrimary })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    let changed: boolean
    try {
      changed = await db.transaction((tx) => setPrimaryEnvironment(tx, row.projectId, id))
    } catch (err) {
      if (!(err instanceof PrimaryEnvironmentConflictError)) throw err
      return primaryConflict(c)
    }
    if (!changed) return c.json({ error: 'Not found' }, 404)
    // Making the primary environment primary again changed nothing: no audit row.
    if (!row.wasPrimary)
      await recordAudit(db, {
        organizationId,
        actorUserId: session.userId,
        actorEmail: session.email ?? null,
        action: 'environment.primary.set',
        targetType: 'environment',
        targetId: id,
        context: { projectId: row.projectId },
      })
    return c.json({ ok: true as const, id, projectId: row.projectId })
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

    const immutable = await assertNotSystemOwnedOr403(c, 'environment', id)
    if (immutable) return immutable

    const stepUp = await requireStepUpIfConfigured(c, organizationId, 'environment.delete')
    if (stepUp) return stepUp

    // The name is a folder on the servers: an environment with folders cannot go.
    const foldersBlock = await refuseDeleteWhileFolders(c, db, id)
    if (foldersBlock) return foldersBlock

    // Planned before the delete: the payload is built from rows the delete
    // removes. Dispatched after it commits.
    const teardownPlan = await planEnvironmentTeardown(db, id)

    // Refuses (409) while a container is running or a deploy is in progress;
    // otherwise drops the environment and everything under it.
    const result = await deleteEnvironmentCascadeGuarded(db, id, {
      c,
      actorId: session.userId,
      organizationId,
    })
    if (result === 'has_children') return hierarchyDeleteHasChildrenResponse(c)
    if (!result.ok) return environmentDeleteRefusal(c, result.error, result.detail)

    await reclaimDeletedEnvironmentHosts(c, db, teardownPlan ? [teardownPlan] : [], session.userId)

    return c.json({
      ok: true as const,
      ...(result.warning ? { warning: result.warning } : {}),
    })
  })
}
