/**
 * Everything an admin tool route reads or writes in the database, behind one
 * interface so the route handlers can be tested without a database. The
 * default implementation ({@link createDbAdminToolStore}) uses the request's own
 * `db`; nothing is cached across requests.
 */

import type { Context } from 'hono'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import {
  binding,
  environment,
  hostname as hostnameTable,
  managedDatabase,
  project,
  service,
  variable,
} from '../../db/schema.ts'
import { recordAudit, type AuditAction } from '../../features/audit/audit-records.ts'
import { materializeBinding } from '../../features/bindings/materialize.ts'
import { enqueueIngressForBindingChange } from '../../features/bindings/enqueue-change.ts'
import { settleDeployOptions } from '../../features/deploy/deploy-options.ts'
import { syncEnvironmentWatch } from '../../features/git/watch-records.ts'
import { assertNotPanelHostnames } from '../../features/hostings/panel-hostname-guard.ts'
import { removeNewManagedLogins } from '../../features/managed/logins.ts'
import { hasOutstandingManagedDestroy } from '../../features/managed/destroy-pending.ts'
import { isReservedDatabaseName } from '../../features/managed/routes-helpers.ts'
import { hostingRoutingNames } from '../../features/servers/hostname-records.ts'
import { deleteProjectCascade } from '../../features/projects/project-delete.ts'
import {
  addAdminToolNameSuffix,
  adminToolProjectName,
} from '../../features/managed/admin-tools/names.ts'
import {
  type AdminToolMetadata,
  type AdminToolProject,
  findAdminTool,
} from '../../features/managed/admin-tools/projects.ts'
import {
  ADMIN_TOOL_BINDING_PREFIX,
  ADMIN_TOOL_SERVICE,
  ADMIN_TOOL_WEB_PASSWORD_KEY,
  ADMIN_TOOLS,
  type AdminToolId,
  adminToolCompose,
} from '../../features/managed/admin-tools/templates.ts'
import { storedDaemonFeatures } from '../environments/destroy-data.ts'
import { reconcileServicesForEnvironment } from '../environments/reconcile-after-compose-save.ts'
import { isProjectDisplayNameTaken } from '../display-name-uniqueness.ts'
import {
  insertDockerComposeProject,
  resolveWorkspaceTarget,
  runProjectDelete,
} from '../projects/routes.ts'
import type { ManagedContext } from './context.ts'

export type AuthInfo = { userId: string; organizationId: string }

export type AdminToolScope = {
  db: Db
  auth: AuthInfo
  ctx: ManagedContext
  row: { id: string; serverId: string | null }
}

/** A refusal the handler turns into a JSON answer. */
export type Refusal = {
  error: string
  status: 400 | 404 | 409 | 422 | 500 | 503
  message?: string
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value
}

export type NewToolProject = { projectId: string; environmentId: string }

export type NewToolProjectInput = {
  tool: AdminToolId
  meta: AdminToolMetadata
  serverId: string
  email: string | undefined
  /** The web password already sealed for storage (pgAdmin only). */
  sealedWebPassword: string | undefined
  workspaceId: string
  clusterName: string | null
}

export type AdminToolStore = {
  findTool: (projectId: string) => Promise<AdminToolProject | undefined>
  destroyPending: () => Promise<boolean>
  /** The control plane's own refusal sentence for a hostname it serves, or `null`. */
  panelHostnameRefusal: (hostname: string) => Promise<string | null>
  hostnameInUse: (hostname: string) => Promise<boolean>
  daemonFeatures: (serverId: string) => Promise<readonly string[]>
  resolveWorkspace: () => Promise<Response | { workspaceId: string; clusterName: string | null }>
  insertProject: (input: NewToolProjectInput) => Promise<NewToolProject | Refusal>
  bind: (environmentId: string, loginId: string) => Promise<{ serviceId: string } | Refusal>
  enqueueIngress: (serviceId: string) => Promise<void>
  /** Takes back a failed create: the project (when made) and the login row. */
  undoCreate: (made: { projectId?: string; loginId: string }) => Promise<void>
  dropProject: (projectId: string) => Promise<void>
  setWebPassword: (environmentId: string, sealed: string) => Promise<void>
  rewrite: (tool: AdminToolProject, revision: number) => Promise<void>
  audit: (action: AuditAction, context: Record<string, unknown>) => Promise<void>
  removeProject: (projectId: string) => Promise<Response>
}

async function pickProjectName(db: Db, organizationId: string, base: string): Promise<string> {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const name = addAdminToolNameSuffix(base, attempt)
    if (!(await isProjectDisplayNameTaken(db, organizationId, name))) return name
  }
  return addAdminToolNameSuffix(base, Date.now())
}

async function panelRefusalFor(db: Db, hostname: string): Promise<string | null> {
  try {
    await assertNotPanelHostnames(db, [hostname])
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'That hostname is in use'
  }
}

async function insertProjectRows(
  scope: AdminToolScope,
  input: NewToolProjectInput
): Promise<NewToolProject> {
  const { db, auth, ctx } = scope
  const name = await pickProjectName(
    db,
    auth.organizationId,
    adminToolProjectName(input.clusterName, ADMIN_TOOLS[input.tool].label)
  )
  const compose = adminToolCompose({
    tool: input.tool,
    engine: ctx.spec.engine,
    hostname: input.meta.hostname,
    email: input.email,
    revision: input.meta.revision,
  })
  return await db.transaction(async (tx) => {
    const projectId = await insertDockerComposeProject(tx, {
      name,
      description: null,
      workspaceId: input.workspaceId,
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
    if (input.sealedWebPassword) {
      await tx.insert(variable).values({
        environmentId: env.id,
        key: ADMIN_TOOL_WEB_PASSWORD_KEY,
        value: input.sealedWebPassword,
        isSecret: true,
      })
    }
    return { projectId, environmentId: env.id }
  })
}

async function bindRows(
  c: Context<AppEnv>,
  scope: AdminToolScope,
  environmentId: string,
  loginId: string
): Promise<{ serviceId: string } | Refusal> {
  const { db, ctx, row } = scope
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) return { error: 'Encryption unavailable', status: 503 }
  await reconcileServicesForEnvironment(db, environmentId)
  const [svc] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.environmentId, environmentId),
        eq(service.composeServiceName, ADMIN_TOOL_SERVICE)
      )
    )
    .limit(1)
  if (!svc) return { error: 'admin_tool_service_missing', status: 500 }
  const databases = await db
    .select({ id: managedDatabase.id, name: managedDatabase.name })
    .from(managedDatabase)
    .where(eq(managedDatabase.managedId, row.id))
    .orderBy(asc(managedDatabase.createdAt))
  const first = databases.find((entry) => !isReservedDatabaseName(ctx.spec.engine, entry.name))
  if (!first) return { error: 'admin_tool_needs_database', status: 409 }
  const [inserted] = await db
    .insert(binding)
    .values({
      loginId,
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
    return { error: materialized.kind, status: 422 }
  }
  return { serviceId: svc.id }
}

async function rewriteRows(scope: AdminToolScope, tool: AdminToolProject, revision: number) {
  const { db, ctx } = scope
  const compose = adminToolCompose({
    tool: tool.meta.tool,
    engine: ctx.spec.engine,
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

export function createDbAdminToolStore(c: Context<AppEnv>, scope: AdminToolScope): AdminToolStore {
  const { db, auth, ctx, row } = scope
  return {
    findTool: (projectId) => findAdminTool(db, row.id, auth.organizationId, projectId),
    destroyPending: () => hasOutstandingManagedDestroy(db, row.id),
    panelHostnameRefusal: (hostname) => panelRefusalFor(db, hostname),
    hostnameInUse: async (hostname) => {
      const names = hostingRoutingNames([hostname], undefined)
      const taken = await db
        .select({ id: hostnameTable.id })
        .from(hostnameTable)
        .where(
          and(
            eq(hostnameTable.routingOrganizationId, auth.organizationId),
            inArray(hostnameTable.hostname, names)
          )
        )
        .limit(1)
      return taken.length > 0
    },
    daemonFeatures: (serverId) => storedDaemonFeatures(db, serverId),
    resolveWorkspace: async () => {
      const [cluster] = await db
        .select({ name: project.name, workspaceId: project.workspaceId })
        .from(project)
        .where(eq(project.id, ctx.projectId))
        .limit(1)
      if (!cluster) return c.json({ error: 'Not found' }, 404)
      const workspaceId = await resolveWorkspaceTarget(
        c,
        db,
        cluster.workspaceId,
        auth.organizationId
      )
      if (workspaceId instanceof Response) return workspaceId
      return { workspaceId, clusterName: cluster.name }
    },
    insertProject: (input) => insertProjectRows(scope, input),
    bind: (environmentId, loginId) => bindRows(c, scope, environmentId, loginId),
    enqueueIngress: async (serviceId) => {
      await enqueueIngressForBindingChange(c, db, {
        serviceIds: [serviceId],
        managedId: row.id,
        actorId: auth.userId,
        organizationId: auth.organizationId,
      })
    },
    undoCreate: async (made) => {
      if (made.projectId) await deleteProjectCascade(db, made.projectId)
      await removeNewManagedLogins(db, row.id, [made.loginId])
    },
    dropProject: async (projectId) => {
      await deleteProjectCascade(db, projectId)
    },
    setWebPassword: async (environmentId, sealed) => {
      await db
        .update(variable)
        .set({ value: sealed, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(variable.environmentId, environmentId),
            eq(variable.key, ADMIN_TOOL_WEB_PASSWORD_KEY)
          )
        )
    },
    rewrite: (tool, revision) => rewriteRows(scope, tool, revision),
    audit: async (action, context) => {
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action,
        targetType: 'managed',
        targetId: row.id,
        context,
      })
    },
    removeProject: (projectId) =>
      runProjectDelete(
        c,
        { db, userId: auth.userId, organizationId: auth.organizationId },
        projectId
      ),
  }
}
