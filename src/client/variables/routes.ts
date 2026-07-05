import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecretForDaemon } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { variable } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import {
  resolveVariableDaemonRecipient,
  type VariableParentRefs,
} from './resolve-environment-daemon.ts'
import {
  resolveInheritedVariablesForEnvironment,
  resolveInheritedVariablesForHosting,
  resolveInheritedVariablesForService,
  type ResolvedVariableMap,
} from './resolve-inherited.ts'

const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const PARTIAL_UNIQUE_INDEX_NAMES = [
  'uniq_var_org',
  'uniq_var_workspace',
  'uniq_var_project',
  'uniq_var_environment',
  'uniq_var_service',
  'uniq_var_hosting',
  'uniq_var_server',
] as const

const PARENT_BODY_FIELDS = [
  { bodyKey: 'organizationId', column: 'organizationId', entityKind: 'organization' },
  { bodyKey: 'workspaceId', column: 'workspaceId', entityKind: 'workspace' },
  { bodyKey: 'projectId', column: 'projectId', entityKind: 'project' },
  { bodyKey: 'environmentId', column: 'environmentId', entityKind: 'environment' },
  { bodyKey: 'serviceId', column: 'serviceId', entityKind: 'service' },
  { bodyKey: 'hostingId', column: 'hostingId', entityKind: 'hosting' },
  { bodyKey: 'serverId', column: 'serverId', entityKind: 'server' },
] as const

type VariableParentColumn = typeof PARENT_BODY_FIELDS[number]['column']

type ParsedVariableParent = {
  column: VariableParentColumn
  id: string
  entityKind: string
}

const VARIABLE_SELECT_FIELDS = {
  id: variable.id,
  organizationId: variable.organizationId,
  workspaceId: variable.workspaceId,
  projectId: variable.projectId,
  environmentId: variable.environmentId,
  serviceId: variable.serviceId,
  hostingId: variable.hostingId,
  serverId: variable.serverId,
  key: variable.key,
  value: variable.value,
  isSecret: variable.isSecret,
  description: variable.description,
  createdAt: variable.createdAt,
  updatedAt: variable.updatedAt,
}

type VariableRow = {
  id: string
  organizationId: string | null
  workspaceId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  hostingId: string | null
  serverId: string | null
  key: string
  value: string
  isSecret: boolean
  description: string | null
  createdAt: string
  updatedAt: string
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function isVariableKeyUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return PARTIAL_UNIQUE_INDEX_NAMES.some((name) => message.includes(name))
}

function serializeVariable(row: VariableRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    hostingId: row.hostingId,
    serverId: row.serverId,
    key: row.key,
    isSecret: row.isSecret,
    value: row.isSecret ? null : row.value,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function parseVariableKey(c: Context, key: unknown): string | Response {
  if (typeof key !== 'string' || !key || !VARIABLE_KEY_RE.test(key)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return key
}

function parseIsSecret(
  c: Context,
  body: Record<string, unknown>,
): boolean | Response {
  if (body.isSecret === undefined || body.isSecret === null) {
    return false
  }
  if (typeof body.isSecret !== 'boolean') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return body.isSecret
}

function serializeResolvedVariables(map: ResolvedVariableMap) {
  const variables: Record<string, { isSecret: boolean; value: string | null }> = {}
  for (const [key, entry] of map) {
    variables[key] = {
      isSecret: entry.isSecret,
      value: entry.isSecret ? null : entry.value,
    }
  }
  return variables
}

function parseVariableParent(
  c: Context,
  body: Record<string, unknown>,
): ParsedVariableParent | Response {
  const specified = PARENT_BODY_FIELDS.filter(({ bodyKey }) => {
    const value = body[bodyKey]
    return value !== undefined && value !== null && value !== ''
  })

  if (specified.length !== 1) {
    return c.json({ error: 'Exactly one parent resource must be specified' }, 400)
  }

  const { bodyKey, column, entityKind } = specified[0]!
  const id = body[bodyKey]
  if (typeof id !== 'string' || !id) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { column, id, entityKind }
}

function parentRefsFromRow(row: VariableParentRefs & { id?: string }): VariableParentRefs {
  return {
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    hostingId: row.hostingId,
    serverId: row.serverId,
  }
}

function buildInsertValues(
  parent: ParsedVariableParent,
  fields: {
    key: string
    value: string
    isSecret: boolean
    description: string | null
  },
) {
  return {
    organizationId: null,
    workspaceId: null,
    projectId: null,
    environmentId: null,
    serviceId: null,
    hostingId: null,
    serverId: null,
    key: fields.key,
    value: fields.value,
    isSecret: fields.isSecret,
    description: fields.description,
    [parent.column]: parent.id,
  }
}

const IMMUTABLE_PARENT_BODY_KEYS = PARENT_BODY_FIELDS.map(({ bodyKey }) => bodyKey)

function hasImmutableParentChange(body: Record<string, unknown>): boolean {
  return IMMUTABLE_PARENT_BODY_KEYS.some((key) => body[key] !== undefined)
}

async function sealVariableValue(
  c: Context,
  parent: VariableParentRefs,
  organizationId: string,
  value: string,
): Promise<string | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const secretsConfig = c.get('secretsConfig')
  if (!secretsConfig) {
    return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }

  const recipient = await resolveVariableDaemonRecipient(
    db,
    parent,
    organizationId,
    c.get('daemonCellRegistry'),
  )
  if (!recipient) {
    return c.json(
      { error: 'No encryption-capable daemon assigned to this variable scope' },
      422,
    )
  }

  return encryptSecretForDaemon(secretsConfig, recipient, value)
}

function parseOptionalStringValue(
  c: Context,
  value: unknown,
): string | null | Response | 'absent' {
  if (value === undefined) return 'absent'
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

function parseOptionalDescription(
  c: Context,
  value: unknown,
): string | null | Response | 'absent' {
  if (value === undefined) return 'absent'
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (value.length > 255) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function registerVariableRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/variables', createSessionMiddleware(opts.secrets))
  router.use('/variables/resolved', createSessionMiddleware(opts.secrets))
  router.use('/variables/:id', createSessionMiddleware(opts.secrets))

  router.get('/variables/resolved', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serviceId = c.req.query('serviceId')
    const environmentId = c.req.query('environmentId')
    const hostingId = c.req.query('hostingId')

    const specified = [serviceId, environmentId, hostingId].filter(
      (value) => value !== undefined && value !== '',
    )
    if (specified.length !== 1) {
      return c.json(
        { error: 'Exactly one of serviceId, environmentId, or hostingId must be specified' },
        400,
      )
    }

    if (hostingId) {
      const entityOrgId = await resolveEntityOrganizationId(db, 'hosting', hostingId)
      if (!entityOrgId || entityOrgId !== organizationId) {
        return c.json({ error: 'Not found' }, 404)
      }

      const denied = await assertCanReadOr403(c, 'hosting', hostingId)
      if (denied) return denied

      const resolved = await resolveInheritedVariablesForHosting(db, hostingId)
      return c.json({ variables: serializeResolvedVariables(resolved) })
    }

    if (serviceId) {
      const entityOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
      if (!entityOrgId || entityOrgId !== organizationId) {
        return c.json({ error: 'Not found' }, 404)
      }

      const denied = await assertCanReadOr403(c, 'service', serviceId)
      if (denied) return denied

      const resolved = await resolveInheritedVariablesForService(db, serviceId)
      return c.json({ variables: serializeResolvedVariables(resolved) })
    }

    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId!)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'environment', environmentId!)
    if (denied) return denied

    const resolved = await resolveInheritedVariablesForEnvironment(db, environmentId!)
    return c.json({ variables: serializeResolvedVariables(resolved) })
  })

  router.get('/variables', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'variable',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ variables: [] })
    }

    const conditions = [inArray(variable.id, visibleIds)]

    for (const { bodyKey, column } of PARENT_BODY_FIELDS) {
      const filterValue = c.req.query(bodyKey)
      if (filterValue) {
        conditions.push(eq(variable[column], filterValue))
      }
    }

    const rows = await db
      .select(VARIABLE_SELECT_FIELDS)
      .from(variable)
      .where(and(...conditions))
      .orderBy(variable.createdAt)

    return c.json({ variables: rows.map(serializeVariable) })
  })

  router.get('/variables/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'variable', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db
      .select(VARIABLE_SELECT_FIELDS)
      .from(variable)
      .where(eq(variable.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'variable', id)
    if (denied) return denied

    return c.json({ variable: serializeVariable(row) })
  })

  router.post('/variables', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parent = parseVariableParent(c, body)
    if (parent instanceof Response) return parent

    const parentOrgId = await resolveEntityOrganizationId(db, parent.entityKind, parent.id)
    if (!parentOrgId || parentOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, parent.entityKind, parent.id)
    if (denied) return denied

    const key = parseVariableKey(c, body.key)
    if (key instanceof Response) return key

    const isSecret = parseIsSecret(c, body)
    if (isSecret instanceof Response) return isSecret

    const parsedValue = parseOptionalStringValue(c, body.value)
    if (parsedValue instanceof Response) return parsedValue
    if (parsedValue === null) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const parsedDescription = parseOptionalDescription(c, body.description)
    if (parsedDescription instanceof Response) return parsedDescription

    const plaintextValue = parsedValue === 'absent' ? '' : parsedValue

    let storedValue: string
    if (isSecret) {
      const parentRefs: VariableParentRefs = { [parent.column]: parent.id }
      const sealed = await sealVariableValue(c, parentRefs, organizationId, plaintextValue)
      if (sealed instanceof Response) return sealed
      storedValue = sealed
    } else {
      storedValue = plaintextValue
    }

    const description = parsedDescription === 'absent' ? null : parsedDescription

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(variable)
          .values(buildInsertValues(parent, {
            key,
            value: storedValue,
            isSecret,
            description,
          }))
          .returning({ id: variable.id })
        return inserted.id
      })

      return c.json({ ok: true as const, id })
    } catch (err) {
      if (isVariableKeyUniqueViolation(err)) {
        return c.json(
          { error: 'A variable with this key already exists in this scope' },
          409,
        )
      }
      throw err
    }
  })

  router.patch('/variables/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'variable', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'variable', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    if (hasImmutableParentChange(body)) {
      return c.json({ error: 'Parent resource cannot be changed after creation' }, 400)
    }

    const existingRows = await db
      .select({
        organizationId: variable.organizationId,
        workspaceId: variable.workspaceId,
        projectId: variable.projectId,
        environmentId: variable.environmentId,
        serviceId: variable.serviceId,
        hostingId: variable.hostingId,
        serverId: variable.serverId,
        isSecret: variable.isSecret,
        value: variable.value,
      })
      .from(variable)
      .where(eq(variable.id, id))
      .limit(1)

    const existing = existingRows[0]
    if (!existing) {
      return c.json({ error: 'Not found' }, 404)
    }

    const updateFields: {
      key?: string
      value?: string
      isSecret?: boolean
      description?: string | null
      updatedAt: string
    } = { updatedAt: new Date().toISOString() }

    if (body.key !== undefined) {
      const key = parseVariableKey(c, body.key)
      if (key instanceof Response) return key
      updateFields.key = key
    }

    if (body.description !== undefined) {
      const description = parseOptionalDescription(c, body.description)
      if (description instanceof Response) return description
      updateFields.description = description === 'absent' ? null : description
    }

    if (body.isSecret !== undefined && typeof body.isSecret !== 'boolean') {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const isSecretToggled = body.isSecret !== undefined
    const nextIsSecret = isSecretToggled
      ? body.isSecret === true
      : existing.isSecret

    if (isSecretToggled) {
      updateFields.isSecret = nextIsSecret
    }

    const valueProvided = body.value !== undefined
    const switchingToSecret = nextIsSecret && !existing.isSecret
    const switchingFromSecret = !nextIsSecret && existing.isSecret
    const parentRefs = parentRefsFromRow(existing)

    if (valueProvided) {
      if (body.value !== null && typeof body.value !== 'string') {
        return c.json({ error: 'Invalid request' }, 400)
      }
      const plaintextValue = body.value === null ? '' : body.value

      if (nextIsSecret) {
        const sealed = await sealVariableValue(
          c,
          parentRefs,
          organizationId,
          plaintextValue,
        )
        if (sealed instanceof Response) return sealed
        updateFields.value = sealed
      } else {
        updateFields.value = plaintextValue
      }
    } else if (switchingToSecret) {
      const sealed = await sealVariableValue(
        c,
        parentRefs,
        organizationId,
        existing.value,
      )
      if (sealed instanceof Response) return sealed
      updateFields.value = sealed
    } else if (switchingFromSecret) {
      return c.json(
        { error: 'value is required when converting a secret variable to non-secret' },
        400,
      )
    }

    if (Object.keys(updateFields).length === 1) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    try {
      await db
        .update(variable)
        .set(updateFields)
        .where(eq(variable.id, id))

      return c.json({ ok: true as const })
    } catch (err) {
      if (isVariableKeyUniqueViolation(err)) {
        return c.json(
          { error: 'A variable with this key already exists in this scope' },
          409,
        )
      }
      throw err
    }
  })

  router.delete('/variables/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'variable', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:own', 'variable', id)
    if (denied) return denied

    await db.delete(variable).where(eq(variable.id, id))

    return c.json({ ok: true as const })
  })
}
