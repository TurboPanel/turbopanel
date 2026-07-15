import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import {
  assertComposeDocument,
  composeDocumentToRuntimeYaml,
  mergeComposeOverlay,
} from '../../lib/compose/index.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import { isNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { getCommandQueue, type CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import {
  environment,
  hosting,
  project,
  server,
  service,
} from '../../lib/db/schema.ts'
import { getDaemonCellRegistry, getDb, type Db } from '../../db.ts'
import {
  assertCanManageOr403,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'

type DeployHostingPayload = {
  hostingId: string
  serviceId: string
  composeServiceName: string
  hostnames: string[]
  pathPrefix?: string
  targetPort?: number
}

function assertDispatchInfrastructure(c: Context<AppEnv>): CommandQueue | Response {
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }

  const commandQueue = getCommandQueue(c)
  if (!commandQueue || isNoopCommandQueue(commandQueue)) {
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  return commandQueue
}

async function verifyServerInOrg(
  db: Db,
  serverId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  return Boolean(row)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readComposeServiceName(metadata: unknown, fallback: string): string {
  if (isPlainObject(metadata) && typeof metadata.composeServiceName === 'string') {
    return metadata.composeServiceName
  }
  return fallback
}

function readHostnames(options: unknown): string[] {
  if (!isPlainObject(options)) return []
  const hostnames = options.hostnames
  if (!Array.isArray(hostnames)) return []
  return hostnames.filter((h): h is string => typeof h === 'string' && h.length > 0)
}

function readPathPrefix(options: unknown): string | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.pathPrefix === 'string' ? options.pathPrefix : undefined
}

function readTargetPort(options: unknown): number | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.targetPort === 'number' && Number.isFinite(options.targetPort)
    ? options.targetPort
    : undefined
}

function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

function projectComposeName(displayName: string | null, projectId: string): string {
  const raw = (displayName ?? projectId).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
  const trimmed = raw.replaceAll(/^-+|-+$/g, '').slice(0, 40)
  return trimmed.length > 0 ? trimmed : `project-${projectId.slice(0, 8)}`
}

async function buildHostingPayload(
  db: Db,
  environmentId: string,
): Promise<DeployHostingPayload[]> {
  const serviceRows = await db
    .select({
      id: service.id,
      displayName: service.displayName,
      metadata: service.metadata,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId))

  const hostingPayload: DeployHostingPayload[] = []

  for (const svc of serviceRows) {
    const composeServiceName = readComposeServiceName(
      svc.metadata,
      svc.displayName ?? svc.id,
    )
    const hostingRows = await db
      .select({
        id: hosting.id,
        options: hosting.options,
      })
      .from(hosting)
      .where(eq(hosting.serviceId, svc.id))

    for (const h of hostingRows) {
      const hostnames = readHostnames(h.options)
      if (hostnames.length === 0) continue
      hostingPayload.push({
        hostingId: h.id,
        serviceId: svc.id,
        composeServiceName,
        hostnames,
        pathPrefix: readPathPrefix(h.options),
        targetPort: readTargetPort(h.options),
      })
    }
  }

  return hostingPayload
}

type LoadedDeployCompose = {
  envRow: { id: string; projectId: string; options: unknown; metadata: unknown }
  projectRow: { id: string; displayName: string | null; options: unknown }
  composeYaml: string
}

async function loadDeployComposeYaml(
  db: Db,
  environmentId: string,
): Promise<LoadedDeployCompose | Response> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      options: environment.options,
      metadata: environment.metadata,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!envRow) return Response.json({ error: 'Not found' }, { status: 404 })

  const [projectRow] = await db
    .select({
      id: project.id,
      displayName: project.displayName,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return Response.json({ error: 'Not found' }, { status: 404 })

  try {
    const baseCompose = assertComposeDocument(extractComposeFromOptions(projectRow.options))
    const overlayCompose = assertComposeDocument(extractComposeFromOptions(envRow.options))
    const merged = mergeComposeOverlay(baseCompose, overlayCompose)
    return {
      envRow,
      projectRow,
      composeYaml: composeDocumentToRuntimeYaml(merged),
    }
  } catch {
    return Response.json({ error: 'Invalid compose document' }, { status: 400 })
  }
}

async function authorizeDeployRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<{ userId: string; serverId: string } | Response> {
  const denied = await assertCanManageOr403(c, 'environment', environmentId)
  if (denied) return denied

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const body = await parseJsonBody(c)
  if (body instanceof Response) return body

  const serverId = requireStringField(c, body, 'serverId')
  if (serverId instanceof Response) return serverId

  if (!(await verifyServerInOrg(db, serverId, orgResult))) {
    return c.json({ error: 'Not found' }, 404)
  }

  return { userId: session.userId, serverId }
}

async function enqueueDeployCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string
    userId: string
    environmentId: string
    projectId: string
    projectName: string
    composeYaml: string
    hostings: DeployHostingPayload[]
  },
): Promise<Response> {
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorEntityType: 'user',
    actorEntityId: params.userId,
    type: 'environment.deploy',
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      composeYaml: params.composeYaml,
      hostings: params.hostings,
    },
    expiresAt,
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: 'environment.deploy',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return Response.json({ error: 'Command queue unavailable' }, { status: 503 })
  }

  return Response.json({
    ok: true as const,
    commandId: record.id,
    status: 'queued' as const,
  })
}

/**
 * Register `POST /environments/:id/deploy` — single-server compose deploy.
 * Status is polled via existing `GET /servers/:serverId/commands/:commandId`.
 */
export function registerEnvironmentDeployRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment deploy routes')
  }
  router.use('/environments/:id/deploy', createSessionMiddleware(opts.secrets))

  router.post('/environments/:id/deploy', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeDeployRequest(c, db, environmentId)
    if (auth instanceof Response) return auth

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const loaded = await loadDeployComposeYaml(db, environmentId)
    if (loaded instanceof Response) return loaded

    const hostingPayload = await buildHostingPayload(db, environmentId)
    const prevMeta = isPlainObject(loaded.envRow.metadata) ? loaded.envRow.metadata : {}
    await db
      .update(environment)
      .set({
        metadata: { ...prevMeta, serverId: auth.serverId },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId))

    const projectName = `tp-${projectComposeName(loaded.projectRow.displayName, loaded.projectRow.id)}-${environmentId.slice(0, 8)}`

    return enqueueDeployCommand(db, commandQueue, {
      serverId: auth.serverId,
      userId: auth.userId,
      environmentId,
      projectId: loaded.projectRow.id,
      projectName,
      composeYaml: loaded.composeYaml,
      hostings: hostingPayload,
    })
  })
}
