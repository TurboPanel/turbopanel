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
 * {@link AdminToolRouteDeps}, which keeps this file free of an import cycle;
 * everything stored goes through {@link AdminToolStore}, so the handlers run in
 * tests without a database. Session middleware comes from `managedSessionPaths()`.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { isValidHostname } from '../../contracts/commands/hostname.ts'
import { DEPLOY_CONFIG_FILES_FEATURE } from '../../lib/version-wire.ts'
import { generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import {
  adminToolLoginName,
  type AdminToolBody,
  parseAdminToolBody,
} from '../../features/managed/admin-tools/names.ts'
import {
  adminToolMetadata,
  type AdminToolMetadata,
  type AdminToolProject,
  listAdminTools,
} from '../../features/managed/admin-tools/projects.ts'
import {
  ADMIN_TOOLS,
  isAcceptablePgAdminEmail,
} from '../../features/managed/admin-tools/templates.ts'
import { confirmationName, refuseUnlessNameConfirmed } from '../confirm-name.ts'
import { parseJsonBody } from '../shared.ts'
import { resolveManagedTargetServerId } from './context.ts'
import {
  type AdminToolScope,
  type AdminToolStore,
  type AuthInfo,
  createDbAdminToolStore,
  isRefusal,
  type NewToolProject,
  type Refusal,
} from './admin-tool-store.ts'

export type { AdminToolScope } from './admin-tool-store.ts'

type ToolLoginMade = {
  loginId: string
  username: string
  password: string
  notes: string[]
  /** Queues the apply that makes the login real (it removes the login itself when it cannot). */
  apply: () => Promise<Response | object>
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
  /** Tests swap the database-backed store for an in-memory one. */
  storeFor?: (c: Context<AppEnv>, scope: S) => AdminToolStore
  /** Tests swap the list query. */
  listTools?: typeof listAdminTools
}

function storeOf<S extends AdminToolScope>(
  deps: AdminToolRouteDeps<S>,
  c: Context<AppEnv>,
  scope: S
): AdminToolStore {
  return (deps.storeFor ?? createDbAdminToolStore)(c, scope)
}

function refuse(c: Context<AppEnv>, refusal: Refusal): Response {
  const { status, ...body } = refusal
  return c.json(body, status)
}

/** What the web interface shows for one tool. */
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

/** The first problem with the request that does not need a login yet, as a refusal. */
async function checkCreateRequest(
  scope: AdminToolScope,
  store: AdminToolStore,
  body: AdminToolBody
): Promise<Refusal | null> {
  if (!ADMIN_TOOLS[body.tool].engines.includes(scope.ctx.spec.engine)) {
    return {
      error: 'admin_tool_engine_mismatch',
      status: 400,
      message: `${ADMIN_TOOLS[body.tool].label} does not work with this database engine.`,
    }
  }
  if (!isValidHostname(body.hostname)) {
    return { error: 'invalid_hostname', status: 400, message: 'Enter a valid hostname.' }
  }
  if (await store.destroyPending()) return { error: 'managed_destroy_in_progress', status: 409 }
  const panel = await store.panelHostnameRefusal(body.hostname)
  if (panel) return { error: 'admin_tool_hostname_in_use', status: 409, message: panel }
  if (await store.hostnameInUse(body.hostname)) {
    return {
      error: 'hostname_in_use',
      status: 409,
      message: 'Another site already answers on this hostname.',
    }
  }
  return null
}

/** The server the tool runs on must be able to write config files when the tool uses them. */
async function daemonRefusal(
  store: AdminToolStore,
  serverId: string,
  tool: AdminToolBody['tool']
): Promise<Refusal | null> {
  if (tool === 'phpmyadmin') return null
  const features = await store.daemonFeatures(serverId)
  if (features.includes(DEPLOY_CONFIG_FILES_FEATURE)) return null
  return {
    error: 'admin_tool_needs_daemon_update',
    status: 409,
    message: `The daemon on this Database Cluster's server must be updated before ${ADMIN_TOOLS[tool].label} can run there.`,
  }
}

/** pgAdmin signs in with the adder's email; a special-use domain fails its own check. */
function pgAdminEmailRefusal(tool: AdminToolBody['tool'], email?: string): Refusal | null {
  if (tool !== 'pgadmin' || (email && isAcceptablePgAdminEmail(email))) return null
  return {
    error: 'admin_tool_email_invalid',
    status: 400,
    message:
      'pgAdmin signs in with your email, and it does not accept this address. Use an address on a public domain.',
  }
}

type CreatePlan<S extends AdminToolScope> = {
  scope: S
  store: AdminToolStore
  body: AdminToolBody
  serverId: string
  email: string | undefined
  workspaceId: string
  clusterName: string | null
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
  const store = storeOf(deps, c, scope)
  const refused = await checkCreateRequest(scope, store, body)
  if (refused) return refuse(c, refused)
  const serverId = resolveManagedTargetServerId(c, scope.row.serverId)
  if (serverId instanceof Response) return serverId
  const oldDaemon = await daemonRefusal(store, serverId, body.tool)
  if (oldDaemon) return refuse(c, oldDaemon)
  const email = body.tool === 'pgadmin' ? (c.get('session')?.email ?? undefined) : undefined
  const badEmail = pgAdminEmailRefusal(body.tool, email)
  if (badEmail) return refuse(c, badEmail)
  const target = await store.resolveWorkspace()
  if (target instanceof Response) return target
  return { scope, store, body, serverId, email, ...target }
}

/** Makes the project and binds it, taking back the login and project when a step fails. */
async function buildToolProject<S extends AdminToolScope>(
  c: Context<AppEnv>,
  plan: CreatePlan<S>,
  login: ToolLoginMade,
  web: { sealed: string } | undefined
): Promise<Response | (NewToolProject & { serviceId: string })> {
  const { scope, store, body, serverId, email, workspaceId, clusterName } = plan
  const meta: AdminToolMetadata = adminToolMetadata({
    tool: body.tool,
    managedId: scope.row.id,
    loginId: login.loginId,
    loginName: login.username,
    hostname: body.hostname,
    access: body.access,
    revision: 1,
    ...(email ? { email } : {}),
  })
  const made: { projectId?: string; loginId: string } = { loginId: login.loginId }
  try {
    const created = await store.insertProject({
      tool: body.tool,
      meta,
      serverId,
      email,
      sealedWebPassword: web?.sealed,
      workspaceId,
      clusterName,
    })
    if (isRefusal(created)) {
      await store.undoCreate(made)
      return refuse(c, created)
    }
    made.projectId = created.projectId
    const bound = await store.bind(created.environmentId, login.loginId)
    if (isRefusal(bound)) {
      await store.undoCreate(made)
      return refuse(c, bound)
    }
    return { ...created, serviceId: bound.serviceId }
  } catch (err) {
    await store.undoCreate(made)
    throw err
  }
}

async function createTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const plan = await planCreate(c, deps)
  if (plan instanceof Response) return plan
  const { scope, store, body, email } = plan
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
    await store.dropProject(created.projectId)
    return applied
  }
  // The proxy learns about the binding only once the login really exists.
  await store.enqueueIngress(created.serviceId)
  await store.audit('managed.admin_tool.create', {
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

async function resetTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const scope = await deps.loadScope(c)
  if (scope instanceof Response) return scope
  const store = storeOf(deps, c, scope)
  const tool = await store.findTool(c.req.param('projectId') ?? '')
  if (!tool) return c.json({ error: 'Not found' }, 404)
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'Encryption unavailable' }, 503)
  const rotated = await deps.rotateLogin(c, scope, tool.meta.loginId)
  if (rotated instanceof Response) return rotated
  const web = tool.meta.tool === 'pgadmin' ? await generateSealedSecret(secrets) : undefined
  if (web) await store.setWebPassword(tool.environmentId, web.sealed)
  await store.rewrite(tool, tool.meta.revision + 1)
  await store.audit('managed.admin_tool.password', { projectId: tool.projectId })
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
  const store = storeOf(deps, c, scope)
  const tool = await store.findTool(c.req.param('projectId') ?? '')
  if (!tool) return c.json({ error: 'Not found' }, 404)
  await store.rewrite(tool, tool.meta.revision + 1)
  await store.audit('managed.admin_tool.update', {
    projectId: tool.projectId,
    image: ADMIN_TOOLS[tool.meta.tool].image,
  })
  return c.json({ ok: true, environmentId: tool.environmentId })
}

/** Why a login delete was refused, in the words of its answer. */
async function refusalReason(response: Response): Promise<string> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? error : 'refused'
}

async function removeTool<S extends AdminToolScope>(
  c: Context<AppEnv>,
  deps: AdminToolRouteDeps<S>
): Promise<Response> {
  const scope = await deps.loadScope(c)
  if (scope instanceof Response) return scope
  const store = storeOf(deps, c, scope)
  const tool = await store.findTool(c.req.param('projectId') ?? '')
  if (!tool) return c.json({ error: 'Not found' }, 404)
  const needsName = refuseUnlessNameConfirmed(
    c,
    'admin tool',
    confirmationName(tool.name, tool.projectId)
  )
  if (needsName) return needsName
  const removed = await store.removeProject(tool.projectId)
  if (!removed.ok) return removed
  await store.audit('managed.admin_tool.delete', {
    tool: tool.meta.tool,
    projectId: tool.projectId,
    loginId: tool.meta.loginId,
  })
  const dropped = await deps.deleteLogin(c, scope, tool.meta.loginId)
  if (dropped.ok) return c.json({ ok: true })
  // The tool is gone. The login stays in the Users list to remove by hand.
  return c.json({
    ok: true,
    loginNotRemoved: { name: tool.meta.loginName, reason: await refusalReason(dropped) },
  })
}

export function registerManagedAdminToolRoutes<S extends AdminToolScope>(
  router: Hono<AppEnv>,
  deps: AdminToolRouteDeps<S>
): void {
  router.get('/environments/:id/managed/admin-tools', async (c) => {
    const scope = await deps.loadReadScope(c)
    if (scope instanceof Response) return scope
    const list = deps.listTools ?? listAdminTools
    const tools = await list(scope.db, scope.managedId, scope.auth.organizationId)
    return c.json({ tools: tools.map(describeTool) })
  })
  router.post('/environments/:id/managed/admin-tools', (c) => createTool(c, deps))
  router.post('/environments/:id/managed/admin-tools/:projectId/password', (c) =>
    resetTool(c, deps)
  )
  router.post('/environments/:id/managed/admin-tools/:projectId/update', (c) => updateTool(c, deps))
  router.delete('/environments/:id/managed/admin-tools/:projectId', (c) => removeTool(c, deps))
}
