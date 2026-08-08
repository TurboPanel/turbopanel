import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { network } from '../../lib/db/schema.ts'
import { isValidCidr } from '../../lib/ip-address.ts'
import { canAccessOrganization, ORG_ID_HEADER } from '../org-context.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
  parseJsonbObject,
} from '../shared.ts'
import { normalizeDockerNetworkOptions } from '../../lib/docker-network-name.ts'
import {
  assertNetworkKindScope,
  buildNetworkCreateValues,
  type NetworkCreateFields,
} from './network-scope.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NETWORK_KINDS = new Set(['datacenter', 'server', 'docker'])

const NETWORK_SELECT = {
  id: network.id,
  organizationId: network.organizationId,
  datacenterId: network.datacenterId,
  serverId: network.serverId,
  kind: network.kind,
  cidr: network.cidr,
  displayName: network.name,
  metadata: network.metadata,
  options: network.options,
  createdAt: network.createdAt,
  updatedAt: network.updatedAt,
}

type NetworkPatchFields = {
  displayName?: string | null
  cidr?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

async function validateOptionalScopeId(
  c: Context,
  db: Db,
  organizationId: string,
  kind: 'datacenter' | 'server',
  raw: unknown,
): Promise<string | null | undefined | Response> {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const entityOrgId = await resolveEntityOrganizationId(db, kind, raw)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return raw
}

async function resolveOrgScopedQueryFilter(
  c: Context,
  db: Db,
  organizationId: string,
  queryKey: 'datacenterId' | 'serverId',
  kind: 'datacenter' | 'server',
): Promise<string | undefined | Response> {
  const raw = c.req.query(queryKey)?.trim()
  if (!raw) return undefined
  if (!UUID_RE.test(raw)) return c.json({ error: 'Invalid request' }, 400)
  const entityOrgId = await resolveEntityOrganizationId(db, kind, raw)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return raw
}

function resolveKindQueryFilter(c: Context): string | undefined | Response {
  const kindFilter = c.req.query('kind')?.trim()
  if (!kindFilter) return undefined
  if (!NETWORK_KINDS.has(kindFilter)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return kindFilter
}

async function resolveCreateNetworkOrganization(
  c: Context,
  db: Db,
  userId: string,
  body: Record<string, unknown>,
): Promise<string | Response> {
  const orgIdRaw = body.organizationId
  if (typeof orgIdRaw !== 'string' || !UUID_RE.test(orgIdRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const contextOrgId = c.req.header(ORG_ID_HEADER)?.trim() ||
    c.req.query('organizationId')?.trim()
  if (contextOrgId && contextOrgId !== orgIdRaw) {
    return c.json({ error: 'organizationId mismatch' }, 400)
  }

  const orgAllowed = await canAccessOrganization(db, userId, orgIdRaw)
  if (!orgAllowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  return orgIdRaw
}

export { assertNetworkKindScope, buildNetworkCreateValues } from './network-scope.ts'

function parseNetworkKind(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  const kindRaw = body.kind
  if (typeof kindRaw !== 'string' || !NETWORK_KINDS.has(kindRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return kindRaw
}

function parseOptionalDisplayNameField(
  c: Context,
  body: Record<string, unknown>,
): string | null | Response {
  if (body.displayName === undefined) return null
  try {
    return parseDisplayName(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
}

function parseOptionalCidrField(
  c: Context,
  body: Record<string, unknown>,
): string | null | Response {
  if (body.cidr === undefined || body.cidr === null) return null
  if (typeof body.cidr !== 'string' || !isValidCidr(body.cidr)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return body.cidr.trim()
}

function applyCidrPatch(
  c: Context,
  body: Record<string, unknown>,
  patchFields: NetworkPatchFields,
): Response | null {
  if (body.cidr === undefined) return null
  if (body.cidr === null) {
    patchFields.cidr = null
    return null
  }
  if (typeof body.cidr === 'string' && isValidCidr(body.cidr)) {
    patchFields.cidr = body.cidr.trim()
    return null
  }
  return c.json({ error: 'Invalid request' }, 400)
}

/**
 * `kind: docker` rows register long-lived host Docker networks for compose
 * `networks.*.external`. Require a valid `options.dockerNetworkName`.
 */
function requireDockerNetworkOptions(
  c: Context,
  options: Record<string, unknown> | null,
): Record<string, unknown> | Response {
  const normalized = normalizeDockerNetworkOptions(options)
  if (!normalized) {
    return c.json({ error: 'docker_network_name_required' }, 400)
  }
  return normalized
}

function parseNetworkPatchFields(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
): NetworkPatchFields | Response {
  let patchFields: NetworkPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (body.displayName !== undefined) {
    try {
      patchFields.name = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }
  }

  const cidrDenied = applyCidrPatch(c, body, patchFields)
  if (cidrDenied) return cidrDenied

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) patchFields.metadata = metadataResult

  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult !== null) {
    if (kind === 'docker') {
      const dockerOptions = requireDockerNetworkOptions(c, optionsResult)
      if (dockerOptions instanceof Response) return dockerOptions
      patchFields.options = dockerOptions
    } else {
      patchFields.options = optionsResult
    }
  }

  return patchFields
}

type NetworkCreateFieldsLocal = NetworkCreateFields

function parseCreateNetworkOptions(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
): Record<string, unknown> | null | Response {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (kind !== 'docker') return optionsResult
  return requireDockerNetworkOptions(c, optionsResult)
}

async function parseNetworkCreateFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<NetworkCreateFieldsLocal | Response> {
  const kind = parseNetworkKind(c, body)
  if (kind instanceof Response) return kind

  const datacenterId = await validateOptionalScopeId(
    c,
    db,
    organizationId,
    'datacenter',
    body.datacenterId,
  )
  if (datacenterId instanceof Response) return datacenterId

  const serverId = await validateOptionalScopeId(
    c,
    db,
    organizationId,
    'server',
    body.serverId,
  )
  if (serverId instanceof Response) return serverId

  const scopeDenied = assertNetworkKindScope(c, kind, datacenterId, serverId)
  if (scopeDenied) return scopeDenied

  const displayName = parseOptionalDisplayNameField(c, body)
  if (displayName instanceof Response) return displayName

  const cidr = parseOptionalCidrField(c, body)
  if (cidr instanceof Response) return cidr

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult

  const optionsResult = parseCreateNetworkOptions(c, body, kind)
  if (optionsResult instanceof Response) return optionsResult

  return {
    kind,
    datacenterId,
    serverId,
    displayName,
    cidr,
    metadata: metadataResult,
    options: optionsResult,
  }
}

export function registerNetworkRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for network routes')
  }
  const secrets = opts.secrets

  router.use('/networks', createSessionMiddleware(secrets))
  router.use('/networks/:id', createSessionMiddleware(secrets))

  router.get('/networks', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const manageDenied = await assertCanManageOr403(c, 'organization', organizationId)
    if (manageDenied) return manageDenied

    const visibleIds = await listVisible(db, {
      kind: 'network',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ networks: [] })
    }

    const conditions = [
      inArray(network.id, visibleIds),
      eq(network.organizationId, organizationId),
    ]

    const datacenterFilter = await resolveOrgScopedQueryFilter(
      c,
      db,
      organizationId,
      'datacenterId',
      'datacenter',
    )
    if (datacenterFilter instanceof Response) return datacenterFilter
    if (datacenterFilter) {
      conditions.push(eq(network.datacenterId, datacenterFilter))
    }

    const serverFilter = await resolveOrgScopedQueryFilter(
      c,
      db,
      organizationId,
      'serverId',
      'server',
    )
    if (serverFilter instanceof Response) return serverFilter
    if (serverFilter) {
      conditions.push(eq(network.serverId, serverFilter))
    }

    const kindFilter = resolveKindQueryFilter(c)
    if (kindFilter instanceof Response) return kindFilter
    if (kindFilter) {
      conditions.push(eq(network.kind, kindFilter))
    }

    const rows = await db
      .select(NETWORK_SELECT)
      .from(network)
      .where(and(...conditions))
      .orderBy(network.createdAt)

    return c.json({ networks: rows })
  })

  router.get('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'network', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'network', id)
    if (denied) return denied

    const [row] = await db
      .select(NETWORK_SELECT)
      .from(network)
      .where(eq(network.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)

    return c.json({ network: row })
  })

  router.post('/networks', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const organizationId = await resolveCreateNetworkOrganization(
      c,
      db,
      session.userId,
      body,
    )
    if (organizationId instanceof Response) return organizationId

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const fields = await parseNetworkCreateFields(c, db, organizationId, body)
    if (fields instanceof Response) return fields

    const [inserted] = await db
      .insert(network)
      .values(buildNetworkCreateValues({ organizationId, ...fields }))
      .returning({ id: network.id })

    const id = inserted?.id
    if (!id) return c.json({ error: 'Failed to create network' }, 500)

    return c.json({ ok: true as const, id })
  })

  router.patch('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'network', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'network', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    if (body.datacenterId !== undefined || body.serverId !== undefined) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const [existing] = await db
      .select({ kind: network.kind })
      .from(network)
      .where(eq(network.id, id))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const patchFields = parseNetworkPatchFields(c, body, existing.kind)
    if (patchFields instanceof Response) return patchFields

    await db.update(network).set(patchFields).where(eq(network.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'network', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'network', id)
    if (denied) return denied

    await db.delete(network).where(eq(network.id, id))

    return c.json({ ok: true as const })
  })
}
