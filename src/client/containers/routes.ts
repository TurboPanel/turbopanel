import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { container, server, service } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseJsonBody,
  parseJsonbObject,
  requireStringField,
  stripPromotedMetadataKeys,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'

/** Identity/status/compose keys live on real columns — never persist into metadata. */
const CONTAINER_PROMOTED_METADATA_KEYS = [
  'containerId',
  'containerName',
  'status',
  'composeServiceName',
  'ordinal',
  'role',
] as const

type ContainerRow = {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  ordinal: number
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

function serializeContainer(row: ContainerRow) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serverId: row.serverId,
    containerId: row.containerId,
    containerName: row.containerName,
    status: row.status,
    role: row.role,
    composeServiceName: row.composeServiceName,
    ordinal: row.ordinal,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function readOptionalPositiveInt(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  return rounded > 0 ? rounded : undefined
}

function readOptionalTopLevelString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

type CreateContainerFields = {
  serviceId: string
  serverId: string
  containerId: string
  containerName: string
  status: string
  composeServiceName: string
  ordinal: number
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

function parseCreateContainerFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateContainerFields | Response {
  const serviceId = requireStringField(c, body, 'serviceId')
  if (serviceId instanceof Response) return serviceId

  const serverId = requireStringField(c, body, 'serverId')
  if (serverId instanceof Response) return serverId

  const containerId = requireStringField(c, body, 'containerId')
  if (containerId instanceof Response) return containerId

  const containerName = requireStringField(c, body, 'containerName')
  if (containerName instanceof Response) return containerName

  const status = requireStringField(c, body, 'status')
  if (status instanceof Response) return status

  const composeServiceName = requireStringField(c, body, 'composeServiceName')
  if (composeServiceName instanceof Response) return composeServiceName

  const ordinal = readOptionalPositiveInt(body, 'ordinal') ?? 1

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult

  const metadata = metadataResult === null
    ? null
    : stripPromotedMetadataKeys(metadataResult, CONTAINER_PROMOTED_METADATA_KEYS)

  return {
    serviceId,
    serverId,
    containerId,
    containerName,
    status,
    composeServiceName,
    ordinal,
    metadata,
    options: optionsResult,
  }
}

const CONTAINER_SELECT = {
  id: container.id,
  serviceId: container.serviceId,
  serverId: container.serverId,
  containerId: container.containerId,
  containerName: container.containerName,
  status: container.status,
  role: container.role,
  composeServiceName: container.composeServiceName,
  ordinal: container.ordinal,
  metadata: container.metadata,
  options: container.options,
  createdAt: container.createdAt,
  updatedAt: container.updatedAt,
} as const

export function registerContainerRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/containers', createSessionMiddleware(opts.secrets))
  router.use('/containers/:id', createSessionMiddleware(opts.secrets))

  router.get('/containers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serviceId = c.req.query('serviceId')
    const serverId = c.req.query('serverId')
    const status = c.req.query('status')
    const environmentId = c.req.query('environmentId')

    const visibleIds = await listVisible(db, {
      kind: 'container',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ containers: [] })
    }

    const conditions = [inArray(container.id, visibleIds)]
    if (serviceId) {
      conditions.push(eq(container.serviceId, serviceId))
    }
    if (serverId) {
      conditions.push(eq(container.serverId, serverId))
    }
    if (status) {
      conditions.push(eq(container.status, status))
    }
    if (environmentId) {
      conditions.push(
        inArray(
          container.serviceId,
          db.select({ id: service.id }).from(service).where(
            eq(service.environmentId, environmentId),
          ),
        ),
      )
    }

    const rows = await db
      .select(CONTAINER_SELECT)
      .from(container)
      .where(and(...conditions))
      .orderBy(container.createdAt)

    return c.json({ containers: rows.map(serializeContainer) })
  })

  router.get('/containers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'container', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select(CONTAINER_SELECT)
      .from(container)
      .where(eq(container.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'container', id)
    if (denied) return denied

    return c.json({ container: serializeContainer(row) })
  })

  router.post('/containers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = parseCreateContainerFields(c, body)
    if (fields instanceof Response) return fields

    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', fields.serviceId)
    if (!serviceOrgId || serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const serverRows = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, fields.serverId))
      .limit(1)

    const serverOrgId = serverRows[0]?.organizationId
    if (!serverOrgId || serverOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'service', fields.serviceId)
    if (denied) return denied

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(container)
        .values({
          serviceId: fields.serviceId,
          serverId: fields.serverId,
          containerId: fields.containerId,
          containerName: fields.containerName,
          status: fields.status,
          composeServiceName: fields.composeServiceName,
          ordinal: fields.ordinal,
          ...(fields.metadata !== null ? { metadata: fields.metadata } : {}),
          ...(fields.options !== null ? { options: fields.options } : {}),
        })
        .returning({ id: container.id })
      return inserted.id
    })

    return c.json({ ok: true as const, id })
  })

  router.patch('/containers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'container', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'container', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: {
      metadata?: Record<string, unknown> | null
      options?: Record<string, unknown> | null
      containerId?: string
      containerName?: string
      status?: string
      composeServiceName?: string
      updatedAt: string
    }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const nextContainerId = readOptionalTopLevelString(body, 'containerId')
    const nextContainerName = readOptionalTopLevelString(body, 'containerName')
    const nextStatus = readOptionalTopLevelString(body, 'status')
    const nextComposeServiceName = readOptionalTopLevelString(body, 'composeServiceName')
    if (nextContainerId) patchFields.containerId = nextContainerId
    if (nextContainerName) patchFields.containerName = nextContainerName
    if (nextStatus) patchFields.status = nextStatus
    if (nextComposeServiceName) patchFields.composeServiceName = nextComposeServiceName

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    if (metadataResult !== null) {
      patchFields.metadata = stripPromotedMetadataKeys(
        metadataResult,
        CONTAINER_PROMOTED_METADATA_KEYS,
      )
    }

    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult
    if (optionsResult !== null) patchFields.options = optionsResult

    await db
      .update(container)
      .set(patchFields)
      .where(eq(container.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/containers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'container', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'container', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(container).where(eq(container.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
