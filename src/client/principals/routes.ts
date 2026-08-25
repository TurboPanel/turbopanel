import { eq } from 'drizzle-orm'
import {
  SUPPORTED_RUNTIME_SERIES,
  SUPPORTED_RUNTIMES,
} from '../../lib/runtime-registry.ts'
import type { Hono, Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { organization, principal, server } from '../../lib/db/schema.ts'
import { principalHomeDir } from '../../lib/naming.ts'
import type { PrincipalOptionsPersisted } from '../../lib/principal-options.ts'
import {
  assertCanManageOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import { parseResourceLimits } from '../../lib/resource-limits.ts'
import {
  loadServiceIdsByPrincipalIds,
  parseServiceIdsField,
  servicesBelongToProject,
} from './stewards.ts'
import { getCommandQueue } from '../../lib/commands/queue.ts'
import { reconcilePrincipalAccess } from './reconcile.ts'
import {
  addSshKey,
  countSshKeysByPrincipalIds,
  listSshKeys,
  removeSshKey,
  SshKeyRejected,
  SSH_KEY_DUPLICATE_ERROR,
  SSH_KEY_LIMIT_ERROR,
} from './ssh-keys.ts'
import {
  loadEntitlementsByPrincipalIds,
  isServerPrincipalUsernameTaken,
  replaceEntitlements,
  replaceStewards,
  SERVER_PRINCIPAL_PROVIDER,
  USERNAME_IN_USE_ERROR,
} from './store.ts'
import { serializeProjectPrincipal } from './serialize.ts'
import {
  optionsRecordFromJsonb,
  parseAccessField,
  parseCreatePrincipalOptions,
  parsePrincipalUsernameValue,
  parseEntitlementsField,
  patchRequiresServiceIds,
  patchTouchesPrincipal,
  projectPrincipalCreateResponse,
  resourceLimitsFromOptions,
  type InsertedProjectPrincipal,
} from './routes-helpers.ts'

class UsernameInUseError extends Error {
  constructor() {
    super(USERNAME_IN_USE_ERROR)
    this.name = 'UsernameInUseError'
  }
}

type ParsedCreateProjectPrincipal = {
  username: string
  options: PrincipalOptionsPersisted
  override: { uid: number; gid: number } | null
  serviceIds: string[]
  entitlements: { runtime: string; series: string; grantedBy: 'operator' }[]
}

function parseCreatePrincipalUsername(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  const usernameRaw = requireStringField(c, body, 'username')
  if (usernameRaw instanceof Response) return usernameRaw
  const parsed = parsePrincipalUsernameValue(usernameRaw)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }
  return parsed.username
}

async function parseCreateProjectPrincipalRequest(
  c: Context,
  db: Db,
  projectId: string,
  body: Record<string, unknown>,
): Promise<ParsedCreateProjectPrincipal | Response> {
  const username = parseCreatePrincipalUsername(c, body)
  if (username instanceof Response) return username

  const entitlements = parseEntitlementsField(body, {
    runtimes: SUPPORTED_RUNTIMES,
    series: SUPPORTED_RUNTIME_SERIES,
  })
  if (entitlements === null) {
    return c.json({ error: 'invalid_entitlements' }, 400)
  }
  const serviceIds = parseServiceIdsField(body)
  if (serviceIds === null) {
    return c.json({ error: 'invalid_service_ids' }, 400)
  }
  if (!(await servicesBelongToProject(db, projectId, serviceIds))) {
    return c.json({ error: 'invalid_service_ids' }, 400)
  }

  const parsedOptions = parseCreatePrincipalOptions(body)
  if (!parsedOptions.ok) {
    return c.json({ error: parsedOptions.error }, parsedOptions.status)
  }

  return {
    username,
    options: parsedOptions.options,
    override: parsedOptions.override,
    serviceIds,
    entitlements: entitlements ?? [],
  }
}

async function insertProjectPrincipal(
  db: Db,
  organizationId: string,
  projectId: string,
  input: ParsedCreateProjectPrincipal,
): Promise<InsertedProjectPrincipal> {
  return await db.transaction(async (tx) => {
    // Serialize concurrent creates for this org so the uniqueness check
    // cannot race two inserts past each other (case/whitespace variants).
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
      .limit(1)

    if (await isServerPrincipalUsernameTaken(tx, organizationId, input.username)) {
      throw new UsernameInUseError()
    }

    const metadata: Record<string, unknown> = {
      home: principalHomeDir(input.username),
    }
    if (input.override) {
      metadata.uid = input.override.uid
      metadata.gid = input.override.gid
    }

    const [row] = await tx.insert(principal).values({
      kind: 'system',
      provider: SERVER_PRINCIPAL_PROVIDER,
      username: input.username,
      projectId,
      metadata,
      options: input.options,
    }).returning({ id: principal.id })

    if (input.serviceIds.length > 0) {
      await replaceStewards(tx, row.id, input.serviceIds)
    }
    if (input.entitlements.length > 0) {
      await replaceEntitlements(tx, row.id, input.entitlements)
    }
    return {
      id: row.id,
      ...(input.override
        ? { uid: input.override.uid, gid: input.override.gid }
        : {}),
    }
  })
}

export function registerProjectPrincipalRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for project principal routes')
  }
  const secrets = opts.secrets

  router.use('/projects/:projectId/principals', createSessionMiddleware(secrets))
  router.use('/projects/:projectId/principals/:id', createSessionMiddleware(secrets))

  router.get('/projects/:projectId/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
    if (!projectOrgId || projectOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    const rows = await db
      .select({
        id: principal.id,
        kind: principal.kind,
        provider: principal.provider,
        username: principal.username,
        projectId: principal.projectId,
        managedId: principal.managedId,
        metadata: principal.metadata,
        options: principal.options,
        createdAt: principal.createdAt,
        updatedAt: principal.updatedAt,
      })
      .from(principal)
      .where(eq(principal.projectId, projectId))

    const principalIds = rows.map((row) => row.id)
    const serviceIdsByPrincipal = await loadServiceIdsByPrincipalIds(
      db,
      principalIds,
    )
    const entitlementsByPrincipal = await loadEntitlementsByPrincipalIds(
      db,
      principalIds,
    )
    const keyCounts = await countSshKeysByPrincipalIds(db, principalIds)

    return c.json({
      principals: rows.map((row) =>
        serializeProjectPrincipal(
          row,
          serviceIdsByPrincipal.get(row.id) ?? [],
          entitlementsByPrincipal.get(row.id) ?? [],
          keyCounts.get(row.id) ?? 0,
        )
      ),
    })
  })

  router.post('/projects/:projectId/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
    if (!projectOrgId || projectOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'project', projectId)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = await parseCreateProjectPrincipalRequest(c, db, projectId, body)
    if (parsed instanceof Response) return parsed

    try {
      const inserted = await insertProjectPrincipal(
        db,
        orgResult,
        projectId,
        parsed,
      )
      return c.json(projectPrincipalCreateResponse(inserted, parsed.serviceIds))
    } catch (err) {
      if (err instanceof UsernameInUseError) {
        return c.json({ error: USERNAME_IN_USE_ERROR }, 409)
      }
      throw err
    }
  })

  router.patch('/projects/:projectId/principals/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const id = c.req.param('id')

    const [row] = await db.select().from(principal).where(eq(principal.id, id)).limit(1)
    if (row?.projectId !== projectId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'project', projectId)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    if (!patchTouchesPrincipal(body)) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    // Absent means "leave them alone"; `[]` means "revoke everything". Both
    // are real requests, so the two must stay distinguishable.
    const entitlements = parseEntitlementsField(body, {
      runtimes: SUPPORTED_RUNTIMES,
      series: SUPPORTED_RUNTIME_SERIES,
    })
    if (entitlements === null) {
      return c.json({ error: 'invalid_entitlements' }, 400)
    }

    // Absent means "leave it alone"; a value sets it. Rejected rather than
    // dropped, so an operator cannot believe they suspended a live account.
    const accessShell = parseAccessField(body)
    if (accessShell === null) {
      return c.json({ error: 'invalid_access' }, 400)
    }

    const patchesStewards = patchRequiresServiceIds(body)
    const serviceIds = patchesStewards ? parseServiceIdsField(body) : []
    if (serviceIds === null) {
      return c.json({ error: 'invalid_service_ids' }, 400)
    }
    if (
      patchesStewards &&
      !(await servicesBelongToProject(db, projectId, serviceIds))
    ) {
      return c.json({ error: 'invalid_service_ids' }, 400)
    }

    await db.transaction(async (tx) => {
      if (patchesStewards) await replaceStewards(tx, id, serviceIds)
      if (entitlements !== undefined) {
        await replaceEntitlements(tx, id, entitlements)
      }
      const options = accessShell === undefined
        ? {}
        : {
          options: {
            ...optionsRecordFromJsonb(row.options),
            shell: accessShell,
          },
        }
      await tx.update(principal).set({
        ...options,
        updatedAt: new Date().toISOString(),
      }).where(eq(principal.id, id))
    })

    // Entitlements and access are both enforced on the host as unix group
    // membership, so a change that only lands in the database has not actually
    // happened yet. Revoking in particular must not wait for a deploy.
    const reconciled = (entitlements !== undefined || accessShell !== undefined)
      ? await reconcilePrincipalAccess(db, getCommandQueue(c), {
        actorType: 'user',
        actorId: session.userId,
      }, id)
      : { queuedServerIds: [], failedServerIds: [] }

    return c.json({ ok: true as const, serviceIds, reconciled })
  })

  router.delete('/projects/:projectId/principals/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const projectId = c.req.param('projectId')
    const id = c.req.param('id')

    const [row] = await db.select().from(principal).where(eq(principal.id, id)).limit(1)
    if (row?.projectId !== projectId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'project', projectId)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'project', projectId)
    if (immutable) return immutable

    await db.delete(principal).where(eq(principal.id, id))
    return c.json({ ok: true as const })
  })

  // --- SSH keys ----------------------------------------------------------
  //
  // Keys live under the principal because that is what `authorized_keys` is: a
  // per-account file. The panel is authoritative — the daemon writes a
  // root-owned file outside the account's home, so a tenant cannot add a key
  // over SSH that the panel cannot see and therefore cannot revoke.
  router.use(
    '/projects/:projectId/principals/:id/ssh-keys',
    createSessionMiddleware(secrets),
  )
  router.use(
    '/projects/:projectId/principals/:id/ssh-keys/:keyId',
    createSessionMiddleware(secrets),
  )

  router.get('/projects/:projectId/principals/:id/ssh-keys', async (c) => {
    const ctx = await resolvePrincipalRequest(c)
    if (ctx instanceof Response) return ctx
    return c.json({ keys: await listSshKeys(ctx.db, ctx.principalId) })
  })

  router.post('/projects/:projectId/principals/:id/ssh-keys', async (c) => {
    const ctx = await resolvePrincipalRequest(c, { requireMutable: true })
    if (ctx instanceof Response) return ctx

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const name = requireStringField(c, body, 'name')
    if (name instanceof Response) return name

    let key
    try {
      key = await addSshKey(ctx.db, {
        principalId: ctx.principalId,
        name,
        publicKey: (body as Record<string, unknown>).publicKey,
        userId: ctx.userId,
      })
    } catch (err) {
      if (!(err instanceof SshKeyRejected)) throw err
      // The parser's own sentence, not a generic "invalid key": an operator
      // gets this wrong in specific, fixable ways (a pasted options field, a
      // DSA key, the private half by mistake) and each deserves its own
      // instruction.
      if (err.message === SSH_KEY_LIMIT_ERROR) {
        return c.json({ error: SSH_KEY_LIMIT_ERROR }, 409)
      }
      if (err.message === SSH_KEY_DUPLICATE_ERROR) {
        return c.json({ error: SSH_KEY_DUPLICATE_ERROR }, 409)
      }
      return c.json({ error: 'invalid_public_key', detail: err.message }, 400)
    }

    const reconciled = await reconcilePrincipalAccess(
      ctx.db,
      getCommandQueue(c),
      { actorType: 'user', actorId: ctx.userId },
      ctx.principalId,
    )
    return c.json({ key, reconciled }, 201)
  })

  router.delete(
    '/projects/:projectId/principals/:id/ssh-keys/:keyId',
    async (c) => {
      const ctx = await resolvePrincipalRequest(c, { requireMutable: true })
      if (ctx instanceof Response) return ctx

      const removed = await removeSshKey(
        ctx.db,
        ctx.principalId,
        c.req.param('keyId'),
      )
      if (!removed) return c.json({ error: 'Not found' }, 404)

      // The reconcile is the revocation. Without it the row is gone from the
      // panel and the key still opens the account, which is the worst possible
      // gap between what the operator sees and what is true.
      const reconciled = await reconcilePrincipalAccess(
        ctx.db,
        getCommandQueue(c),
        { actorType: 'user', actorId: ctx.userId },
        ctx.principalId,
      )
      return c.json({ ok: true as const, reconciled })
    },
  )
}

/**
 * The authz preamble every principal-scoped route repeats: session, org match,
 * project ownership of the principal, manage permission, and (for writes) that
 * the project is not system-owned.
 *
 * Factored out because the SSH key routes need exactly the same five checks in
 * exactly the same order, and a route that skipped one would be a hole in a
 * credential surface rather than a style problem.
 */
async function resolvePrincipalRequest(
  c: Context<AppEnv>,
  opts: { requireMutable?: boolean } = {},
): Promise<
  { db: Db; principalId: string; projectId: string; userId: string } | Response
> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  // Read with a fallback rather than `!`: this helper is shared across two
  // route shapes, so the path params are only `string | undefined` here.
  const projectId = c.req.param('projectId') ?? ''
  const principalId = c.req.param('id') ?? ''
  if (!projectId || !principalId) return c.json({ error: 'Not found' }, 404)

  const projectOrgId = await resolveEntityOrganizationId(db, 'project', projectId)
  if (!projectOrgId || projectOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const [row] = await db
    .select({ projectId: principal.projectId })
    .from(principal)
    .where(eq(principal.id, principalId))
    .limit(1)
  if (row?.projectId !== projectId) return c.json({ error: 'Not found' }, 404)

  const denied = await assertCanManageOr403(c, 'project', projectId)
  if (denied) return denied

  if (opts.requireMutable) {
    const immutable = await assertNotSystemOwnedOr403(c, 'project', projectId)
    if (immutable) return immutable
  }

  return { db, principalId, projectId, userId: session.userId }
}

export function registerOrganizationLimitsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization limits routes')
  }

  router.use('/organizations/:id/resource-limits', createSessionMiddleware(opts.secrets))

  router.get('/organizations/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    if (id !== orgResult) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanOr403(c, 'organization:manage', 'organization', id)
    if (denied) return denied

    const [orgRow] = await db.select({ options: organization.options }).from(organization).where(
      eq(organization.id, id),
    ).limit(1)

    return c.json({
      resourceLimits: resourceLimitsFromOptions(orgRow?.options),
    })
  })

  router.put('/organizations/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    if (id !== orgResult) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanOr403(c, 'organization:own', 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const limits = parseResourceLimits(body.resourceLimits)
    if (limits === null) return c.json({ error: 'Invalid request' }, 400)

    const [orgRow] = await db.select({ options: organization.options }).from(organization).where(
      eq(organization.id, id),
    ).limit(1)

    const prevOptions = optionsRecordFromJsonb(orgRow?.options)

    await db.update(organization).set({
      options: { ...prevOptions, resourceLimits: limits },
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id))

    return c.json({ ok: true as const, resourceLimits: limits })
  })
}

export function registerServerLimitsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server limits routes')
  }

  router.use('/servers/:id/resource-limits', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    const serverOrgId = await resolveEntityOrganizationId(db, 'server', id)
    if (!serverOrgId || serverOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'server', id)
    if (denied) return denied

    const [serverRow] = await db.select({ options: server.options }).from(server).where(
      eq(server.id, id),
    ).limit(1)

    return c.json({
      resourceLimits: resourceLimitsFromOptions(serverRow?.options),
    })
  })

  router.put('/servers/:id/resource-limits', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    const serverOrgId = await resolveEntityOrganizationId(db, 'server', id)
    if (!serverOrgId || serverOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'server', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const limits = parseResourceLimits(body.resourceLimits)
    if (limits === null) return c.json({ error: 'Invalid request' }, 400)

    const [serverRow] = await db.select({ options: server.options }).from(server).where(
      eq(server.id, id),
    ).limit(1)

    const prevOptions = optionsRecordFromJsonb(serverRow?.options)

    await db.update(server).set({
      options: { ...prevOptions, resourceLimits: limits },
      updatedAt: new Date().toISOString(),
    }).where(eq(server.id, id))

    return c.json({ ok: true as const, resourceLimits: limits })
  })
}
