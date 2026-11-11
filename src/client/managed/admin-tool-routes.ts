/**
 * Admin tools of a Database Cluster (phpMyAdmin, Adminer, pgAdmin):
 *
 * - `GET    /environments/:id/managed/admin-tools`
 * - `POST   /environments/:id/managed/admin-tools`
 * - `POST   /environments/:id/managed/admin-tools/:projectId/password`
 * - `POST   /environments/:id/managed/admin-tools/:projectId/update`
 * - `DELETE /environments/:id/managed/admin-tools/:projectId`
 *
 * A tool is an ordinary compose project bound to its own tool login. The login
 * steps (create, rotate, delete) live in `routes.ts` and come in through
 * {@link AdminToolRouteDeps}, which keeps this file free of an import cycle.
 * Session middleware comes from `managedSessionPaths()`.
 */

import type { Context, Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import {
  binding,
  environment,
  managedDatabase,
  project,
  service,
  variable,
} from '../../db/schema.ts'
import { isValidHostname } from '../../contracts/commands/hostname.ts'
import { materializeBinding } from '../../features/bindings/materialize.ts'
import { enqueueIngressForBindingChange } from '../../features/bindings/enqueue-change.ts'
import { recordAudit, type AuditAction } from '../../features/audit/audit-records.ts'
import { deleteProjectCascade } from '../../features/projects/project-delete.ts'
import { assertNotPanelHostnames } from '../../features/hostings/panel-hostname-guard.ts'
import { removeNewManagedLogins } from '../../features/managed/logins.ts'
import { hasOutstandingManagedDestroy } from '../../features/managed/destroy-pending.ts'
import {
  addAdminToolNameSuffix,
  adminToolLoginName,
  adminToolProjectName,
  type AdminToolBody,
  parseAdminToolBody,
} from '../../features/managed/admin-tools/names.ts'
import {
  adminToolMetadata,
  type AdminToolMetadata,
  type AdminToolProject,
  findAdminTool,
  listAdminTools,
} from '../../features/managed/admin-tools/projects.ts'
import {
  ADMIN_TOOL_BINDING_PREFIX,
  ADMIN_TOOL_SERVICE,
  ADMIN_TOOL_WEB_PASSWORD_KEY,
  ADMIN_TOOLS,
  adminToolCompose,
  isAcceptablePgAdminEmail,
} from '../../features/managed/admin-tools/templates.ts'
import { encryptSecret, generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import { storedDaemonFeatures } from '../environments/destroy-data.ts'
import { DEPLOY_CONFIG_FILES_FEATURE } from '../../lib/version-wire.ts'
import { reconcileServicesForEnvironment } from '../environments/reconcile-after-compose-save.ts'
import { isProjectDisplayNameTaken } from '../display-name-uniqueness.ts'
import { confirmationName, refuseUnlessNameConfirmed } from '../confirm-name.ts'
import {
  insertDockerComposeProject,
  resolveWorkspaceTarget,
  runProjectDelete,
} from '../projects/routes.ts'
import { parseJsonBody } from '../shared.ts'
import { resolveManagedTargetServerId, type ManagedContext } from './context.ts'
import { isReservedDatabaseName } from '../../features/managed/routes-helpers.ts'
import { settleDeployOptions } from '../../features/deploy/deploy-options.ts'
import { syncEnvironmentWatch } from '../../features/git/watch-records.ts'

type AuthInfo = { userId: string; organizationId: string }

export type AdminToolScope = {
  db: Db
  auth: AuthInfo
  ctx: ManagedContext
  row: { id: string; serverId: string | null }
}

type ToolLoginMade = {
  loginId: string
  username: string
  password: string
  notes: string[]
  /** Queues the apply that makes the login real (it removes the login itself when it cannot). */
  apply: () => Promise<Response | unknown>
}

/** What `routes.ts` hands in: the login steps a tool shares with the users routes. */
export type AdminToolRouteDeps<S extends AdminToolScope> = {
  loadScope: (c: Context<AppEnv>) => Promise<Response | S>
  createLogin: (
    c: Context<AppEnv>,
    scope: S,
    input: { username: string; access: 'admin' | 'read-only' }
  ) => Promise<Response | ToolLoginMade>
  rotateLogin: (
    c: Context<AppEnv>,
    scope: S,
    loginId: string
  ) => Promise<Response | { plaintext: string }>
  deleteLogin: (c: Context<AppEnv>, scope: S, loginId: string) => Promise<Response>
  /** Read access to the cluster's tool list; answers an empty list itself when there is no cluster. */
  loadReadScope: (
    c: Context<AppEnv>
  ) => Promise<Response | { db: Db; auth: AuthInfo; managedId: string }>
}

/** Names of the tool's own project as the web interface shows them. */
function describeTool(tool: AdminToolProject) {
  const definition = ADMIN_TOOLS[tool.meta.tool]
  return {
    projectId: tool.projectId,
    environmentId: tool.environmentId,
    name: tool.name,
    tool: tool.meta.tool,
    label: definition.label,
    hostname: tool.meta.hostname,
    loginId: tool.meta.loginId,
    loginName: tool.meta.loginName,
    access: tool.meta.access,
    image: tool.meta.image,
    latestImage: definition.image,
    updateAvailable: tool.meta.image !== definition.image,
  }
}

async function audit(
  db: Db,
  auth: AuthInfo,
  action: AuditAction,
  managedId: string,
  context: Record<string, unknown>
): Promise<void> {
  await recordAudit(db, {
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    action,
    targetType: 'managed',
    targetId: managedId,
    context,
  })
}

/** Refuses a hostname the control plane itself serves, with the guard's own sentence. */
async function hostnameRefusal(c: Context<AppEnv>, db: Db, hostname: string) {
  try {
    await assertNotPanelHostnames(db, [hostname])
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : 'That hostname is in use'
    return c.json({ error: 'admin_tool_hostname_in_use', message }, 409)
  }
}

/** The first problem with the request that does not need a login yet, as a response. */
async function checkCreateRequest(
  c: Context<AppEnv>,
  scope: AdminToolScope,
  body: AdminToolBody
): Promise<Response | null> {
  const { db, ctx, row } = scope
  if (!ADMIN_TOOLS[body.tool].engines.includes(ctx.spec.engine)) {
    return c.json(
      {
        error: 'admin_tool_engine_mismatch',
        message: `${ADMIN_TOOLS[body.tool].label} does not work with this database engine.`,
      },
      400
    )
  }
  if (!isValidHostname(body.hostname)) {
    return c.json({ error: 'invalid_hostname', message: 'Enter a valid hostname.' }, 400)
  }
  if (await hasOutstandingManagedDestroy(db, row.id)) {
    return c.json({ error: 'managed_destroy_in_progress' }, 409)
  }
  return await hostnameRefusal(c, db, body.hostname)
}

/** The server the tool runs on must be able to write config files when the tool uses them. */
async function daemonRefusal(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  tool: AdminToolBody['tool']
) {
  if (tool === 'phpmyadmin') return null
  const features = await storedDaemonFeatures(db, serverId)
  if (features.includes(DEPLOY_CONFIG_FILES_FEATURE)) return null
  return c.json(
    {
      error: 'admin_tool_needs_daemon_update',
      message: `The daemon on this Database Cluster's server must be updated before ${ADMIN_TOOLS[tool].label} can run there.`,
    },
    409
  )
}

async function pickProjectName(db: Db, organizationId: string, base: string): Promise<string> {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const name = addAdminToolNameSuffix(base, attempt)
    if (!(await isProjectDisplayNameTaken(db, organizationId, name))) return name
  }
  return addAdminToolNameSuffix(base, Date.now())
}

type NewToolProject = { projectId: string; environmentId: string; serviceId?: string }

async function insertToolProject(
  c: Context<AppEnv>,
  scope: AdminToolScope,
  input: {
    body: AdminToolBody
    meta: AdminToolMetadata
    serverId: string
    email: string | undefined
    webPassword: string | undefined
    workspaceId: string
    clusterName: string | null
  }
): Promise<Response | NewToolProject> {
  const { db, auth, ctx } = scope
  const { workspaceId } = input
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) return c.json({ error: 'Encryption unavailable' }, 503)
  const name = await pickProjectName(
    db,
    auth.organizationId,
    adminToolProjectName(input.clusterName, ADMIN_TOOLS[input.body.tool].label)
  )
  const compose = adminToolCompose({
    tool: input.body.tool,
    engine: ctx.spec.engine,
    hostname: input.body.hostname,
    email: input.email,
    revision: input.meta.revision,
  })
  const sealedWeb = input.webPassword
    ? await encryptSecret(dataEncryptionSecrets, input.webPassword)
    : null
  return await db.transaction(async (tx) => {
    const projectId = await insertDockerComposeProject(tx, {
      name,
      description: null,
      workspaceId,
      organizationId: auth.organizationId,
      metadata: input.meta,
      icon: null,
      options: { compose },
      serverId: input.serverId,
      defaultEnvironmentName: 'production',
    })
    const [env] = await tx
      .select({ id: environment.id })
      .from(environment)
      .where(and(eq(environment.projectId, projectId), eq(environment.isPrimary, true)))
      .limit(1)
    if (sealedWeb) {
      await tx.insert(variable).values({
        environmentId: env.id,
        key: ADMIN_TOOL_WEB_PASSWORD_KEY,
        value: sealedWeb,
        isSecret: true,
      })
    }
    return { projectId, environmentId: env.id }
  })
}

type BindResult = { serviceId: string } | Response

/** Binds the tool's service to its login on the cluster's first database (the tool browses all it may use). */
async function bindToolToLogin(
  c: Context<AppEnv>,
  scope: AdminToolScope,
  params: { environmentId: string; loginId: string }
): Promise<BindResult> {
  const { db, ctx, row } = scope
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) return c.json({ error: 'Encryption unavailable' }, 503)
  await reconcileServicesForEnvironment(db, params.environmentId)
  const [svc] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.environmentId, params.environmentId),
        eq(service.composeServiceName, ADMIN_TOOL_SERVICE)
      )
    )
    .limit(1)
  if (!svc) return c.json({ error: 'admin_tool_service_missing' }, 500)
  const databases = await db
    .select({ id: managedDatabase.id, name: managedDatabase.name })
    .from(managedDatabase)
    .where(eq(managedDatabase.managedId, row.id))
    .orderBy(asc(managedDatabase.createdAt))
  const first = databases.find((entry) => !isReservedDatabaseName(ctx.spec.engine, entry.name))
  if (!first) return c.json({ error: 'admin_tool_needs_database' }, 409)
  const [inserted] = await db
    .insert(binding)
    .values({
      loginId: params.loginId,
      serviceId: svc.id,
      databaseId: first.id,
      keyPrefix: ADMIN_TOOL_BINDING_PREFIX,
      isEmitEngineDefaults: false,
      preset: null,
    })
    .returning({ id: binding.id })
  const materialized = await materializeBinding(db, dataEncryptionSecrets, inserted.id)
  if (!('ok' in materialized)) {
    await db.delete(binding).where(eq(binding.id, inserted.id))
    return c.json({ error: materialized.kind }, 422)
  }
  return { serviceId: svc.id }
}

/** Takes back what a failed create made: the project (before any deploy) and the login row. */
async function undoCreate(
  db: Db,
  managedId: string,
  made: { projectId?: string; loginId: string }
): Promise<void> {
  if (made.projectId) await deleteProjectCascade(db, made.projectId)
  await removeNewManagedLogins(db, managedId, [made.loginId])
}

function sessionEmail(c: Context<AppEnv>): string | undefined {
  return c.get('session')?.email ?? undefined
}

type CreatePlan<S extends AdminToolScope> = {
  scope: S
  body: AdminToolBody
  serverId: string
  email: string | undefined
  workspaceId: string
  clusterName: string | null
}

/** The cluster's own workspace, if the caller may create a project in it. */
async function resolveToolWorkspace(c: Context<AppEnv>, scope: AdminToolScope) {
  const { db, auth, ctx } = scope
  const [cluster] = await db
    .select({ name: project.name, workspaceId: project.workspaceId })
    .from(project)
    .where(eq(project.id, ctx.projectId))
    .limit(1)
  if (!cluster) return c.json({ error: 'Not found' }, 404)
  const workspaceId = await resolveWorkspaceTarget(c, db, cluster.workspaceId, auth.organizationId)
  if (workspaceId instanceof Response) return workspaceId
  return { workspaceId, clusterName: cluster.name }
}

/** pgAdmin signs in with the adder's email; a special-use domain fails its own check. */
function pgAdminEmailRefusal(c: Context<AppEnv>, tool: AdminToolBody['tool'], email?: string) {
  if (tool !== 'pgadmin' || (email && isAcceptablePgAdminEmail(email))) return null
  return c.json(
    {
      error: 'admin_tool_email_invalid',
      message:
        'pgAdmin signs in with your email, and it does not accept this address. Use an address on a public domain.',
    },
    400
  )
}

/** Every check that needs no login yet; the first problem answers. */
async function planCreate<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response | CreatePlan<S>> {
  const scope = await deps.loadScope(c)
  if (scope instanceof Response) return scope
  const raw = await parseJsonBody(c)
  if (raw instanceof Response) return raw
  const parsed = parseAdminToolBody(raw)
  if (!parsed.ok) return c.json({ error: parsed.error, message: parsed.message }, 400)
  const { body } = parsed
  const refused = await checkCreateRequest(c, scope, body)
  if (refused) return refused
  const serverId = resolveManagedTargetServerId(c, scope.row.serverId)
  if (serverId instanceof Response) return serverId
  const oldDaemon = await daemonRefusal(c, scope.db, serverId, body.tool)
  if (oldDaemon) return oldDaemon
  const email = body.tool === 'pgadmin' ? sessionEmail(c) : undefined
  const badEmail = pgAdminEmailRefusal(c, body.tool, email)
  if (badEmail) return badEmail
  const target = await resolveToolWorkspace(c, scope)
  if (target instanceof Response) return target
  return { scope, body, serverId, email, ...target }
}

/** Makes the project and binds it, taking back the login and project when a step fails. */
async function buildToolProject(
  c: Context<AppEnv>,
  plan: CreatePlan<AdminToolScope>,
  login: ToolLoginMade,
  web: { plaintext: string } | undefined
): Promise<Response | NewToolProject> {
  const { scope, body, serverId, email, workspaceId, clusterName } = plan
  const { db, row } = scope
  const meta = adminToolMetadata({
    tool: body.tool,
    managedId: row.id,
    loginId: login.loginId,
    loginName: login.username,
    hostname: body.hostname,
    access: body.access,
    revision: 1,
    ...(email ? { email } : {}),
  })
  const made: { projectId?: string; loginId: string } = { loginId: login.loginId }
  try {
    const created = await insertToolProject(c, scope, {
      body,
      meta,
      serverId,
      email,
      webPassword: web?.plaintext,
      workspaceId,
      clusterName,
    })
    if (created instanceof Response) {
      await undoCreate(db, row.id, made)
      return created
    }
    made.projectId = created.projectId
    const bound = await bindToolToLogin(c, scope, {
      environmentId: created.environmentId,
      loginId: login.loginId,
    })
    if (bound instanceof Response) {
      await undoCreate(db, row.id, made)
      return bound
    }
    return { ...created, serviceId: bound.serviceId }
  } catch (err) {
    await undoCreate(db, row.id, made)
    throw err
  }
}

async function createTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const plan = await planCreate(c, deps)
  if (plan instanceof Response) return plan
  const { scope, body, email } = plan
  const { db, auth, row } = scope
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'Encryption unavailable' }, 503)
  const login = await deps.createLogin(c, scope, {
    username: adminToolLoginName(body.tool),
    access: body.access,
  })
  if (login instanceof Response) return login
  const web = body.tool === 'pgadmin' ? await generateSealedSecret(secrets) : undefined
  const created = await buildToolProject(c, plan, login, web)
  if (created instanceof Response) return created
  const applied = await login.apply()
  if (applied instanceof Response) {
    // The apply already removed the login; the project goes with it.
    await deleteProjectCascade(db, created.projectId)
    return applied
  }
  // The proxy learns about the binding only once the login really exists.
  if (created.serviceId) {
    await enqueueIngressForBindingChange(c, db, {
      serviceIds: [created.serviceId],
      managedId: row.id,
      actorId: auth.userId,
      organizationId: auth.organizationId,
    })
  }
  await audit(db, auth, 'managed.admin_tool.create', row.id, {
    tool: body.tool,
    projectId: created.projectId,
    loginName: login.username,
    hostname: body.hostname,
    access: body.access,
  })
  return c.json({
    ok: true,
    projectId: created.projectId,
    environmentId: created.environmentId,
    loginName: login.username,
    loginPassword: login.password,
    ...(web && email ? { webEmail: email, webPassword: web.plaintext } : {}),
    ...(login.notes.length > 0 ? { notes: login.notes } : {}),
  })
}

/** Rewrites the tool's overlay from the current template and stores the new revision and pin. */
async function rewriteTool(db: Db, tool: AdminToolProject, engine: string, revision: number) {
  const compose = adminToolCompose({
    tool: tool.meta.tool,
    engine,
    hostname: tool.meta.hostname,
    email: tool.meta.email,
    revision,
  })
  const [existing] = await db
    .select({ options: environment.options })
    .from(environment)
    .where(eq(environment.id, tool.environmentId))
    .limit(1)
  await db.transaction(async (tx) => {
    await tx
      .update(environment)
      .set({
        options: settleDeployOptions(existing?.options, { compose }, 'environment'),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, tool.environmentId))
    await tx
      .update(project)
      .set({
        metadata: { ...tool.meta, revision, image: ADMIN_TOOLS[tool.meta.tool].image },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, tool.projectId))
  })
  await syncEnvironmentWatch(db, tool.environmentId)
}

async function resetTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const scope = await deps.loadScope(c)
  if (scope instanceof Response) return scope
  const { db, auth, ctx, row } = scope
  const tool = await findAdminTool(db, row.id, auth.organizationId, c.req.param('projectId') ?? '')
  if (!tool) return c.json({ error: 'Not found' }, 404)
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'Encryption unavailable' }, 503)
  const rotated = await deps.rotateLogin(c, scope, tool.meta.loginId)
  if (rotated instanceof Response) return rotated
  const web = tool.meta.tool === 'pgadmin' ? await generateSealedSecret(secrets) : undefined
  if (web) {
    await db
      .update(variable)
      .set({ value: web.sealed, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(variable.environmentId, tool.environmentId),
          eq(variable.key, ADMIN_TOOL_WEB_PASSWORD_KEY)
        )
      )
  }
  await rewriteTool(db, tool, ctx.spec.engine, tool.meta.revision + 1)
  await audit(db, auth, 'managed.admin_tool.password', row.id, { projectId: tool.projectId })
  return c.json({
    ok: true,
    loginName: tool.meta.loginName,
    loginPassword: rotated.plaintext,
    ...(web && tool.meta.email ? { webEmail: tool.meta.email, webPassword: web.plaintext } : {}),
  })
}

async function updateTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const scope = await deps.loadScope(c)
  if (scope instanceof Response) return scope
  const { db, auth, ctx, row } = scope
  const tool = await findAdminTool(db, row.id, auth.organizationId, c.req.param('projectId') ?? '')
  if (!tool) return c.json({ error: 'Not found' }, 404)
  await rewriteTool(db, tool, ctx.spec.engine, tool.meta.revision + 1)
  await audit(db, auth, 'managed.admin_tool.update', row.id, {
    projectId: tool.projectId,
    image: ADMIN_TOOLS[tool.meta.tool].image,
  })
  return c.json({ ok: true, environmentId: tool.environmentId })
}

async function removeTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const scope = await deps.loadScope(c)
  if (scope instanceof Response) return scope
  const { db, auth, row } = scope
  const tool = await findAdminTool(db, row.id, auth.organizationId, c.req.param('projectId') ?? '')
  if (!tool) return c.json({ error: 'Not found' }, 404)
  const needsName = refuseUnlessNameConfirmed(
    c,
    'admin tool',
    confirmationName(tool.name, tool.projectId)
  )
  if (needsName) return needsName
  const removed = await runProjectDelete(
    c,
    { db, userId: auth.userId, organizationId: auth.organizationId },
    tool.projectId
  )
  if (!removed.ok) return removed
  await audit(db, auth, 'managed.admin_tool.delete', row.id, {
    tool: tool.meta.tool,
    projectId: tool.projectId,
    loginId: tool.meta.loginId,
  })
  // The tool is gone; a refusal here leaves the login in the Users list to remove by hand.
  const dropped = await deps.deleteLogin(c, scope, tool.meta.loginId)
  if (!dropped.ok) return dropped
  return c.json({ ok: true })
}

export function registerManagedAdminToolRoutes<S extends AdminToolScope>(
  router: Hono<AppEnv>,
  deps: AdminToolRouteDeps<S>
): void {
  router.get('/environments/:id/managed/admin-tools', async (c) => {
    const scope = await deps.loadReadScope(c)
    if (scope instanceof Response) return scope
    const tools = await listAdminTools(scope.db, scope.managedId, scope.auth.organizationId)
    return c.json({ tools: tools.map(describeTool) })
  })
  router.post('/environments/:id/managed/admin-tools', (c) => createTool(c, deps))
  router.post('/environments/:id/managed/admin-tools/:projectId/password', (c) =>
    resetTool(c, deps)
  )
  router.post('/environments/:id/managed/admin-tools/:projectId/update', (c) => updateTool(c, deps))
  router.delete('/environments/:id/managed/admin-tools/:projectId', (c) => removeTool(c, deps))
}
