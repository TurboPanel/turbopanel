import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { variable } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import {
  resolveInheritedVariablesForEnvironment,
  resolveInheritedVariablesForHosting,
  resolveInheritedVariablesForService,
  type ResolvedVariableMap,
} from './resolve-inherited.ts'
import {
  buildInsertValues,
  hasImmutableParentChange,
  isVariableKeyUniqueViolation,
  PARENT_BODY_FIELDS,
  parseIsSecret,
  parseOptionalBoolean,
  parseOptionalDescription,
  parseOptionalStringValue,
  parseVariableKey,
  parseVariableParent,
  resolvePatchIsSecret,
  serializeResolvedVariables,
  serializeVariable,
  trimVariableValueOnWrite,
  type ParsedVariableParent,
} from './routes-helpers.ts'

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
  isLiteral: variable.isLiteral,
  forBuild: variable.forBuild,
  forRuntime: variable.forRuntime,
  description: variable.description,
  createdAt: variable.createdAt,
  updatedAt: variable.updatedAt,
}

type ResolvedEntityKind = 'hosting' | 'service' | 'environment'

async function respondWithResolvedVariables(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  kind: ResolvedEntityKind,
  entityId: string,
  resolve: (db: Db, id: string) => Promise<ResolvedVariableMap>,
) {
  const entityOrgId = await resolveEntityOrganizationId(db, kind, entityId)
  if (!entityOrgId || entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = await assertCanReadOr403(c, kind, entityId)
  if (denied) return denied

  const resolved = await resolve(db, entityId)
  return c.json({ variables: serializeResolvedVariables(resolved) })
}

async function sealVariableValue(
  c: Context<AppEnv>,
  value: string,
): Promise<string | Response> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }

  return encryptSecret(dataEncryptionSecrets, value)
}

type ExistingVariableForPatch = {
  isSecret: boolean
  value: string
}

type VariablePatchFields = {
  key?: string
  value?: string
  isSecret?: boolean
  isLiteral?: boolean
  forBuild?: boolean
  forRuntime?: boolean
  description?: string | null
  updatedAt: string
}

function applyOptionalKeyPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  updateFields: VariablePatchFields,
): Response | undefined {
  if (body.key === undefined) return
  const key = parseVariableKey(c, body.key)
  if (key instanceof Response) return key
  updateFields.key = key
}

function applyOptionalDescriptionPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  updateFields: VariablePatchFields,
): Response | undefined {
  if (body.description === undefined) return
  const description = parseOptionalDescription(c, body.description)
  if (description instanceof Response) return description
  updateFields.description = description ?? null
}

async function sealOrPlainValue(
  c: Context<AppEnv>,
  plaintext: string,
  asSecret: boolean,
): Promise<string | Response> {
  if (!asSecret) return plaintext
  return sealVariableValue(c, plaintext)
}

async function applyValueAndSecretPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  existing: ExistingVariableForPatch,
  nextIsSecret: boolean,
  updateFields: VariablePatchFields,
): Promise<Response | undefined> {
  const valueProvided = body.value !== undefined
  const switchingToSecret = nextIsSecret && !existing.isSecret
  const switchingFromSecret = !nextIsSecret && existing.isSecret

  if (valueProvided) {
    if (body.value !== null && typeof body.value !== 'string') {
      return c.json({ error: 'Invalid request' }, 400)
    }
    const plaintextValue = trimVariableValueOnWrite(body.value ?? '')
    const stored = await sealOrPlainValue(c, plaintextValue, nextIsSecret)
    if (stored instanceof Response) return stored
    updateFields.value = stored
    return
  }

  if (switchingToSecret) {
    const sealed = await sealVariableValue(c, existing.value)
    if (sealed instanceof Response) return sealed
    updateFields.value = sealed
    return
  }

  if (switchingFromSecret) {
    return c.json(
      { error: 'value is required when converting a secret variable to non-secret' },
      400,
    )
  }
}

function applyOptionalBooleanPatch(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  field: 'isLiteral' | 'forBuild' | 'forRuntime',
  updateFields: VariablePatchFields,
): Response | undefined {
  if (body[field] === undefined) return
  const parsed = parseOptionalBoolean(c, body[field])
  if (parsed instanceof Response) return parsed
  updateFields[field] = parsed
}

async function buildVariablePatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  existing: ExistingVariableForPatch,
): Promise<VariablePatchFields | Response> {
  const updateFields: VariablePatchFields = {
    updatedAt: new Date().toISOString(),
  }

  const keyError = applyOptionalKeyPatch(c, body, updateFields)
  if (keyError) return keyError

  const descriptionError = applyOptionalDescriptionPatch(c, body, updateFields)
  if (descriptionError) return descriptionError

  for (const field of ['isLiteral', 'forBuild', 'forRuntime'] as const) {
    const boolError = applyOptionalBooleanPatch(c, body, field, updateFields)
    if (boolError) return boolError
  }

  const secretResult = resolvePatchIsSecret(c, body, existing.isSecret)
  if (secretResult instanceof Response) return secretResult

  if (secretResult.toggled) {
    updateFields.isSecret = secretResult.nextIsSecret
  }

  const valueError = await applyValueAndSecretPatch(
    c,
    body,
    existing,
    secretResult.nextIsSecret,
    updateFields,
  )
  if (valueError) return valueError

  if (Object.keys(updateFields).length === 1) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return updateFields
}

type VariableCreateFields = {
  parent: ParsedVariableParent
  key: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
  value: string
  description: string | null
}

async function parseVariableCreateFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  organizationId: string,
): Promise<VariableCreateFields | Response> {
  const parent = parseVariableParent(c, body)
  if (parent instanceof Response) return parent

  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const parentOrgId = await resolveEntityOrganizationId(db, parent.entityKind, parent.id)
  if (!parentOrgId || parentOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = await assertCanCreateOr403(c, parent.entityKind, parent.id)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, parent.entityKind, parent.id)
  if (immutable) return immutable

  const key = parseVariableKey(c, body.key)
  if (key instanceof Response) return key

  const isSecret = parseIsSecret(c, body)
  if (isSecret instanceof Response) return isSecret

  const isLiteral = parseOptionalBoolean(c, body.isLiteral) ?? false
  if (isLiteral instanceof Response) return isLiteral

  const forBuild = parseOptionalBoolean(c, body.forBuild) ?? false
  if (forBuild instanceof Response) return forBuild

  const forRuntime = parseOptionalBoolean(c, body.forRuntime) ?? true
  if (forRuntime instanceof Response) return forRuntime

  const parsedValue = parseOptionalStringValue(c, body.value)
  if (parsedValue instanceof Response) return parsedValue
  if (parsedValue === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const parsedDescription = parseOptionalDescription(c, body.description)
  if (parsedDescription instanceof Response) return parsedDescription

  const plaintextValue = trimVariableValueOnWrite(parsedValue ?? '')
  const storedValue = await sealOrPlainValue(c, plaintextValue, isSecret)
  if (storedValue instanceof Response) return storedValue

  return {
    parent,
    key,
    isSecret,
    isLiteral,
    forBuild,
    forRuntime,
    value: storedValue,
    description: parsedDescription ?? null,
  }
}

export function registerVariableRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for variable routes')
  }
  const secrets = opts.secrets

  router.use('/variables', createSessionMiddleware(secrets))
  router.use('/variables/resolved', createSessionMiddleware(secrets))
  router.use('/variables/:id', createSessionMiddleware(secrets))

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
      return respondWithResolvedVariables(
        c,
        db,
        organizationId,
        'hosting',
        hostingId,
        resolveInheritedVariablesForHosting,
      )
    }

    if (serviceId) {
      return respondWithResolvedVariables(
        c,
        db,
        organizationId,
        'service',
        serviceId,
        resolveInheritedVariablesForService,
      )
    }

    return respondWithResolvedVariables(
      c,
      db,
      organizationId,
      'environment',
      environmentId!,
      resolveInheritedVariablesForEnvironment,
    )
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

    const fields = await parseVariableCreateFields(c, body, organizationId)
    if (fields instanceof Response) return fields

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(variable)
          .values(buildInsertValues(fields.parent, {
            key: fields.key,
            value: fields.value,
            isSecret: fields.isSecret,
            isLiteral: fields.isLiteral,
            forBuild: fields.forBuild,
            forRuntime: fields.forRuntime,
            description: fields.description,
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

    const denied = await assertCanOr403(c, 'organization:manage', 'variable', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'variable', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    if (hasImmutableParentChange(body)) {
      return c.json({ error: 'Parent resource cannot be changed after creation' }, 400)
    }

    const existingRows = await db
      .select({
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

    const updateFields = await buildVariablePatchFields(c, body, existing)
    if (updateFields instanceof Response) return updateFields

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

    const denied = await assertCanOr403(c, 'organization:manage', 'variable', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'variable', id)
    if (immutable) return immutable

    await db.delete(variable).where(eq(variable.id, id))

    return c.json({ ok: true as const })
  })
}
