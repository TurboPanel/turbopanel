import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { storage } from '../../lib/db/schema.ts'
import { parseJsonbObject, requireStringField } from '../shared.ts'

export const MAX_STORAGE_CONTENT_BYTES = 256 * 1024

export const STORAGE_KINDS = ['volume', 'directory', 'file'] as const
export type StorageKind = typeof STORAGE_KINDS[number]

export const ACCESS_MODES = ['single_writer', 'multi_reader', 'multi_writer'] as const
export type StorageAccessMode = typeof ACCESS_MODES[number]

export const RETENTION_POLICIES = ['retain', 'delete'] as const
export type StorageRetention = typeof RETENTION_POLICIES[number]

export const API_LOCATION_PROVIDERS = ['docker', 'path'] as const
export type ApiLocationProvider = typeof API_LOCATION_PROVIDERS[number]

export const LOCATION_ROLES = ['primary', 'replica', 'scratch', 'archive'] as const
export type LocationRole = typeof LOCATION_ROLES[number]

export const LOCATION_STATES = [
  'pending',
  'materializing',
  'ready',
  'syncing',
  'stale',
  'failed',
  'retiring',
] as const
export type LocationState = typeof LOCATION_STATES[number]

export const PARENT_FIELDS = [
  { bodyKey: 'workspaceId', column: 'workspaceId' as const, entityKind: 'workspace' as const },
  { bodyKey: 'projectId', column: 'projectId' as const, entityKind: 'project' as const },
  { bodyKey: 'environmentId', column: 'environmentId' as const, entityKind: 'environment' as const },
  { bodyKey: 'serviceId', column: 'serviceId' as const, entityKind: 'service' as const },
] as const

type StorageRow = typeof storage.$inferSelect
export type StorageParentEntityKind =
  | 'organization'
  | 'workspace'
  | 'project'
  | 'environment'
  | 'service'

export type StorageParentRef = {
  column: (typeof PARENT_FIELDS)[number]['column'] | null
  id: string | null
  entityKind: StorageParentEntityKind
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStorageKind(value: unknown): value is StorageKind {
  return typeof value === 'string' &&
    (STORAGE_KINDS as readonly string[]).includes(value)
}

export function isAccessMode(value: unknown): value is StorageAccessMode {
  return typeof value === 'string' &&
    (ACCESS_MODES as readonly string[]).includes(value)
}

export function isRetention(value: unknown): value is StorageRetention {
  return typeof value === 'string' &&
    (RETENTION_POLICIES as readonly string[]).includes(value)
}

export function isApiLocationProvider(value: unknown): value is ApiLocationProvider {
  return typeof value === 'string' &&
    (API_LOCATION_PROVIDERS as readonly string[]).includes(value)
}

export function isLocationRole(value: unknown): value is LocationRole {
  return typeof value === 'string' &&
    (LOCATION_ROLES as readonly string[]).includes(value)
}

export function isLocationState(value: unknown): value is LocationState {
  return typeof value === 'string' &&
    (LOCATION_STATES as readonly string[]).includes(value)
}

export function optionalStringField(value: unknown): string | null {
  if (typeof value === 'string') return value
  return null
}

export function resolveStorageProjectId(parent: StorageParentRef): string | null {
  if (parent.column === 'projectId') return parent.id
  return null
}

export function resolvePatchKind(body: Record<string, unknown>, existing: StorageRow): StorageKind {
  if (isStorageKind(body.kind)) return body.kind
  return existing.kind as StorageKind
}

export function resolvePatchPrincipalId(
  body: Record<string, unknown>,
  existing: string | null,
): string | null {
  if (body.principalId === null) return null
  if (typeof body.principalId === 'string') return body.principalId
  return existing
}

export function resolveStorageParentContext(row: StorageRow | undefined): {
  parentId: string
  entityKind: StorageParentEntityKind
} | null {
  if (!row) return null
  if (row.serviceId) {
    return { parentId: row.serviceId, entityKind: 'service' }
  }
  if (row.environmentId) {
    return { parentId: row.environmentId, entityKind: 'environment' }
  }
  if (row.projectId) {
    return { parentId: row.projectId, entityKind: 'project' }
  }
  if (row.workspaceId) {
    return { parentId: row.workspaceId, entityKind: 'workspace' }
  }
  return { parentId: row.organizationId, entityKind: 'organization' }
}

export function parseStorageParent(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): StorageParentRef | Response {
  const specified = PARENT_FIELDS.filter(({ bodyKey }) => {
    const value = body[bodyKey]
    return value !== undefined && value !== null && value !== ''
  })
  if (specified.length > 1) {
    return c.json({ error: 'At most one parent resource may be specified' }, 400)
  }
  if (specified.length === 0) {
    return { column: null, id: null, entityKind: 'organization' }
  }
  const { bodyKey, column, entityKind } = specified[0]!
  const id = body[bodyKey]
  if (typeof id !== 'string' || !id) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return { column, id, entityKind }
}

export function storageContentByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

export function isStorageContentTooLarge(content: string): boolean {
  return storageContentByteLength(content) > MAX_STORAGE_CONTENT_BYTES
}

export function parseOptionalStorageContent(
  c: Context<AppEnv>,
  value: unknown,
): string | undefined | Response {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export type CreateLocationFields = {
  provider: ApiLocationProvider
  serverId: string
  path: string | null
  role: LocationRole
  state: LocationState
  endpoint: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

export type CreateMountFields = {
  serviceId: string
  destinationPath: string
  subpath: string | null
  readOnly: boolean
}

export type CreateStorageFields = {
  kind: StorageKind
  name: string
  accessMode: StorageAccessMode
  retention: StorageRetention
  principalId: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
  location: CreateLocationFields | undefined
  mount: CreateMountFields | undefined
}

function parseEnumField<T extends string>(
  c: Context<AppEnv>,
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T | Response {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  return c.json({ error: 'Invalid request' }, 400)
}

function parseOptionalBoolean(
  c: Context<AppEnv>,
  value: unknown,
  fallback: boolean,
): boolean | Response {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  return c.json({ error: 'Invalid request' }, 400)
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}

export const LOCATION_PRIMARY_EXISTS_ERROR = 'location_primary_exists'
export const LOCATION_SERVER_PROVIDER_EXISTS_ERROR = 'location_server_provider_exists'
export const MOUNT_DESTINATION_IN_USE_ERROR = 'mount_destination_in_use'
export const SCRATCH_LOCATION_NOT_MOUNTABLE_ERROR = 'scratch_location_not_mountable'

function uniqueViolationMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(err)
}

export function mapStorageUniqueViolation(
  err: unknown,
): { error: string; status: 409 } | null {
  if (!isPostgresUniqueViolation(err)) return null
  const message = uniqueViolationMessage(err)
  if (message.includes('uniq_location_storage_primary')) {
    return { error: LOCATION_PRIMARY_EXISTS_ERROR, status: 409 }
  }
  if (message.includes('uniq_location_storage_server_provider')) {
    return { error: LOCATION_SERVER_PROVIDER_EXISTS_ERROR, status: 409 }
  }
  if (message.includes('uniq_mount_service_destination')) {
    return { error: MOUNT_DESTINATION_IN_USE_ERROR, status: 409 }
  }
  return { error: 'conflict', status: 409 }
}

export function parseLocationRecord(
  c: Context<AppEnv>,
  loc: Record<string, unknown>,
): CreateLocationFields | Response {
  if (!isApiLocationProvider(loc.provider)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const serverId = requireStringField(c, loc, 'serverId')
  if (serverId instanceof Response) return serverId
  const role = parseEnumField(c, loc.role, LOCATION_ROLES, 'primary')
  if (role instanceof Response) return role
  const state = parseEnumField(c, loc.state, LOCATION_STATES, 'pending')
  if (state instanceof Response) return state
  const metadata = parseJsonbObject(c, loc, 'metadata')
  if (metadata instanceof Response) return metadata
  const options = parseJsonbObject(c, loc, 'options')
  if (options instanceof Response) return options
  return {
    provider: loc.provider,
    serverId,
    path: optionalStringField(loc.path),
    role,
    state,
    endpoint: optionalStringField(loc.endpoint),
    metadata,
    options,
  }
}

export function parseMountRecord(
  c: Context<AppEnv>,
  mountBody: Record<string, unknown>,
): CreateMountFields | Response {
  const serviceId = requireStringField(c, mountBody, 'serviceId')
  if (serviceId instanceof Response) return serviceId
  const destinationPath = requireStringField(c, mountBody, 'destinationPath')
  if (destinationPath instanceof Response) return destinationPath
  if (!destinationPath.trim()) {
    return c.json({ error: 'destinationPath is required' }, 400)
  }
  const readOnly = parseOptionalBoolean(c, mountBody.readOnly, false)
  if (readOnly instanceof Response) return readOnly
  return {
    serviceId,
    destinationPath,
    subpath: optionalStringField(mountBody.subpath),
    readOnly,
  }
}

export function parseCreateLocationFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateLocationFields | undefined | Response {
  if (body.location === undefined) return undefined
  if (!isRecord(body.location)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return parseLocationRecord(c, body.location)
}

export function parseCreateMountFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateMountFields | undefined | Response {
  if (body.mount === undefined) return undefined
  if (!isRecord(body.mount)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return parseMountRecord(c, body.mount)
}

export function parseCreateStorageFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateStorageFields | Response {
  const kind = body.kind
  if (!isStorageKind(kind)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const name = requireStringField(c, body, 'name')
  if (name instanceof Response) return name

  const accessMode = parseEnumField(c, body.accessMode, ACCESS_MODES, 'single_writer')
  if (accessMode instanceof Response) return accessMode
  const retention = parseEnumField(c, body.retention, RETENTION_POLICIES, 'retain')
  if (retention instanceof Response) return retention

  const metadata = parseJsonbObject(c, body, 'metadata')
  if (metadata instanceof Response) return metadata
  const options = parseJsonbObject(c, body, 'options')
  if (options instanceof Response) return options

  const location = parseCreateLocationFields(c, body)
  if (location instanceof Response) return location
  const mount = parseCreateMountFields(c, body)
  if (mount instanceof Response) return mount

  if (mount && location?.role === 'scratch') {
    return c.json({ error: SCRATCH_LOCATION_NOT_MOUNTABLE_ERROR }, 400)
  }

  return {
    kind,
    name,
    accessMode,
    retention,
    principalId: optionalStringField(body.principalId),
    metadata,
    options,
    location,
    mount,
  }
}

export function buildStorageUpdateFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Record<string, unknown> | Response {
  const updateFields: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  }
  if (typeof body.name === 'string') updateFields.name = body.name
  if (isAccessMode(body.accessMode)) updateFields.accessMode = body.accessMode
  if (isRetention(body.retention)) updateFields.retention = body.retention
  if (body.principalId === null || typeof body.principalId === 'string') {
    updateFields.principalId = body.principalId
  }
  const metadata = parseJsonbObject(c, body, 'metadata')
  if (metadata instanceof Response) return metadata
  if (metadata !== null) updateFields.metadata = metadata
  const options = parseJsonbObject(c, body, 'options')
  if (options instanceof Response) return options
  if (options !== null) updateFields.options = options
  return updateFields
}

export function parseLocationPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Record<string, unknown> | Response {
  const updateFields: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  }
  if (isApiLocationProvider(body.provider)) updateFields.provider = body.provider
  if (typeof body.serverId === 'string') updateFields.serverId = body.serverId
  if (body.serverId === null) updateFields.serverId = null
  if (typeof body.path === 'string' || body.path === null) updateFields.path = body.path
  if (typeof body.endpoint === 'string' || body.endpoint === null) {
    updateFields.endpoint = body.endpoint
  }
  if (isLocationRole(body.role)) updateFields.role = body.role
  if (isLocationState(body.state)) updateFields.state = body.state
  if (body.credentialId === null || typeof body.credentialId === 'string') {
    updateFields.credentialId = body.credentialId
  }
  const metadata = parseJsonbObject(c, body, 'metadata')
  if (metadata instanceof Response) return metadata
  if (metadata !== null) updateFields.metadata = metadata
  const options = parseJsonbObject(c, body, 'options')
  if (options instanceof Response) return options
  if (options !== null) updateFields.options = options
  return updateFields
}

export function parseMountPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Record<string, unknown> | Response {
  const updateFields: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  }
  if (typeof body.destinationPath === 'string') {
    if (!body.destinationPath.trim()) {
      return c.json({ error: 'destinationPath is required' }, 400)
    }
    updateFields.destinationPath = body.destinationPath
  }
  if (typeof body.subpath === 'string' || body.subpath === null) {
    updateFields.subpath = body.subpath
  }
  const readOnly = parseOptionalBoolean(c, body.readOnly, false)
  if (readOnly instanceof Response) return readOnly
  if (body.readOnly !== undefined) updateFields.isReadOnly = readOnly
  const metadata = parseJsonbObject(c, body, 'metadata')
  if (metadata instanceof Response) return metadata
  if (metadata !== null) updateFields.metadata = metadata
  const options = parseJsonbObject(c, body, 'options')
  if (options instanceof Response) return options
  if (options !== null) updateFields.options = options
  return updateFields
}

export function dockerVolumeMetadataWithId(
  metadata: Record<string, unknown> | null | undefined,
  storageId: string,
): Record<string, unknown> {
  const existingMeta =
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata)
      ? metadata
      : {}
  return {
    ...existingMeta,
    dockerVolumeName: storageId,
  }
}

export function principalProjectMismatch(
  principalProjectId: string | null | undefined,
  expectedProjectId: string | null | undefined,
): boolean {
  if (!expectedProjectId) return false
  return principalProjectId !== expectedProjectId
}

export function scratchLocationNotMountable(role: string | null | undefined): boolean {
  return role === 'scratch'
}
