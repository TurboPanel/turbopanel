import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { ResolvedVariableMap } from './resolve-inherited.ts'

export const VARIABLE_KEY_RE = /^[A-Za-z_]\w*$/

const PARTIAL_UNIQUE_INDEX_NAMES = [
  'uniq_var_org',
  'uniq_var_workspace',
  'uniq_var_project',
  'uniq_var_environment',
  'uniq_var_service',
  'uniq_var_hosting',
  'uniq_var_server',
] as const

export const PARENT_BODY_FIELDS = [
  { bodyKey: 'organizationId', column: 'organizationId', entityKind: 'organization' },
  { bodyKey: 'workspaceId', column: 'workspaceId', entityKind: 'workspace' },
  { bodyKey: 'projectId', column: 'projectId', entityKind: 'project' },
  { bodyKey: 'environmentId', column: 'environmentId', entityKind: 'environment' },
  { bodyKey: 'serviceId', column: 'serviceId', entityKind: 'service' },
  { bodyKey: 'hostingId', column: 'hostingId', entityKind: 'hosting' },
  { bodyKey: 'serverId', column: 'serverId', entityKind: 'server' },
] as const

export type VariableParentColumn = typeof PARENT_BODY_FIELDS[number]['column']

export type ParsedVariableParent = {
  column: VariableParentColumn
  id: string
  entityKind: string
}

export type VariableRow = {
  id: string
  organizationId: string | null
  workspaceId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  hostingId: string | null
  serverId: string | null
  bindingId: string | null
  key: string
  value: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
  description: string | null
  createdAt: string
  updatedAt: string
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

export function isVariableKeyUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return PARTIAL_UNIQUE_INDEX_NAMES.some((name) => message.includes(name))
}

/** Client PATCH/DELETE of a binding-owned variable. */
export const BINDING_OWNED_VARIABLE_ERROR = 'binding_owned_variable'

/** Client create that collides with a binding-emitted key. */
export const BINDING_KEY_CONFLICT_ERROR = 'binding_key_conflict'

export function serializeVariable(row: VariableRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    hostingId: row.hostingId,
    serverId: row.serverId,
    bindingId: row.bindingId,
    key: row.key,
    isSecret: row.isSecret,
    isLiteral: row.isLiteral,
    forBuild: row.forBuild,
    forRuntime: row.forRuntime,
    value: row.isSecret ? null : row.value,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function parseVariableKey(c: Context<AppEnv>, key: unknown): string | Response {
  if (typeof key !== 'string' || !key || !VARIABLE_KEY_RE.test(key)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return key
}

export function parseIsSecret(
  c: Context<AppEnv>,
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

export function parseOptionalBoolean(
  c: Context<AppEnv>,
  value: unknown,
): boolean | Response | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function trimVariableValueOnWrite(value: string): string {
  return value.trim()
}

export function serializeResolvedVariables(map: ResolvedVariableMap) {
  const variables: Record<string, {
    isSecret: boolean
    isLiteral: boolean
    forBuild: boolean
    forRuntime: boolean
    value: string | null
  }> = {}
  for (const [key, entry] of map) {
    variables[key] = {
      isSecret: entry.isSecret,
      isLiteral: entry.isLiteral,
      forBuild: entry.forBuild,
      forRuntime: entry.forRuntime,
      value: entry.isSecret ? null : entry.value,
    }
  }
  return variables
}

export function parseVariableParent(
  c: Context<AppEnv>,
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

export function buildInsertValues(
  parent: ParsedVariableParent,
  fields: {
    key: string
    value: string
    isSecret: boolean
    isLiteral: boolean
    forBuild: boolean
    forRuntime: boolean
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
    isLiteral: fields.isLiteral,
    forBuild: fields.forBuild,
    forRuntime: fields.forRuntime,
    description: fields.description,
    [parent.column]: parent.id,
  }
}

const IMMUTABLE_PARENT_BODY_KEYS = PARENT_BODY_FIELDS.map(({ bodyKey }) => bodyKey)

export function hasImmutableParentChange(body: Record<string, unknown>): boolean {
  return IMMUTABLE_PARENT_BODY_KEYS.some((key) => body[key] !== undefined)
}

export function parseOptionalStringValue(
  c: Context<AppEnv>,
  value: unknown,
): string | null | Response | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function parseOptionalDescription(
  c: Context<AppEnv>,
  value: unknown,
): string | null | Response | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (value.length > 255) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function resolvePatchIsSecret(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  existingIsSecret: boolean,
): { nextIsSecret: boolean; toggled: boolean } | Response {
  if (body.isSecret !== undefined && typeof body.isSecret !== 'boolean') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const toggled = body.isSecret !== undefined
  return {
    toggled,
    nextIsSecret: toggled ? body.isSecret === true : existingIsSecret,
  }
}

export type ResolvedVariablesQuery =
  | { kind: 'hosting'; id: string }
  | { kind: 'service'; id: string }
  | { kind: 'environment'; id: string }

export function parseResolvedVariablesQuery(params: {
  serviceId: string | undefined
  environmentId: string | undefined
  hostingId: string | undefined
}):
  | { ok: true; query: ResolvedVariablesQuery }
  | { ok: false; error: string; status: 400 } {
  const specified = [params.serviceId, params.environmentId, params.hostingId].filter(
    (value) => value !== undefined && value !== '',
  )
  if (specified.length !== 1) {
    return {
      ok: false,
      error: 'Exactly one of serviceId, environmentId, or hostingId must be specified',
      status: 400,
    }
  }
  if (params.hostingId) {
    return { ok: true, query: { kind: 'hosting', id: params.hostingId } }
  }
  if (params.serviceId) {
    return { ok: true, query: { kind: 'service', id: params.serviceId } }
  }
  return { ok: true, query: { kind: 'environment', id: params.environmentId! } }
}

export function variableKeyUniqueConflictMessage(): string {
  return 'A variable with this key already exists in this scope'
}

export function validateVariableKeyValue(
  key: unknown,
): { ok: true; key: string } | { ok: false; error: string; status: 400 } {
  if (typeof key !== 'string' || !key || !VARIABLE_KEY_RE.test(key)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, key }
}

export function patchHasOnlyUpdatedAt(updateFields: Record<string, unknown>): boolean {
  return Object.keys(updateFields).length === 1
}

export function switchingSecretRequiresValue(
  nextIsSecret: boolean,
  existingIsSecret: boolean,
  valueProvided: boolean,
): boolean {
  return !nextIsSecret && existingIsSecret && !valueProvided
}
