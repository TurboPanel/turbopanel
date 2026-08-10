import { buildPatchUpdateFields, stripPromotedMetadataKeys } from '../shared.ts'

/** Identity/status/compose keys live on real columns — never persist into metadata. */
export const CONTAINER_PROMOTED_METADATA_KEYS = [
  'containerId',
  'containerName',
  'status',
  'composeServiceName',
  'ordinal',
  'role',
] as const

export type ContainerRouteValidationError = {
  ok: false
  error: string
  status: 400
  field?: string
}

export type ContainerRow = {
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

export function serializeContainer(row: ContainerRow) {
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

export function parseJsonbField(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null | 'invalid' {
  if (body[field] === undefined) {
    return null
  }
  const value = body[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'invalid'
  }
  return value as Record<string, unknown>
}

export function readOptionalPositiveInt(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  return rounded > 0 ? rounded : undefined
}

export function readOptionalTopLevelString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function requireStringFieldValue(
  body: Record<string, unknown>,
  field: string,
): string | ContainerRouteValidationError {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'Invalid request', status: 400, field }
  }
  return value
}

export type CreateContainerFields = {
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

export function parseCreateContainerFields(
  body: Record<string, unknown>,
):
  | { ok: true; fields: CreateContainerFields }
  | ContainerRouteValidationError {
  const serviceId = requireStringFieldValue(body, 'serviceId')
  if (typeof serviceId !== 'string') return serviceId

  const serverId = requireStringFieldValue(body, 'serverId')
  if (typeof serverId !== 'string') return serverId

  const containerId = requireStringFieldValue(body, 'containerId')
  if (typeof containerId !== 'string') return containerId

  const containerName = requireStringFieldValue(body, 'containerName')
  if (typeof containerName !== 'string') return containerName

  const status = requireStringFieldValue(body, 'status')
  if (typeof status !== 'string') return status

  const composeServiceName = requireStringFieldValue(body, 'composeServiceName')
  if (typeof composeServiceName !== 'string') return composeServiceName

  const ordinal = readOptionalPositiveInt(body, 'ordinal') ?? 1

  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400, field: 'metadata' }
  }
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400, field: 'options' }
  }

  const metadata = metadataResult === null
    ? null
    : stripPromotedMetadataKeys(metadataResult, CONTAINER_PROMOTED_METADATA_KEYS)

  return {
    ok: true,
    fields: {
      serviceId,
      serverId,
      containerId,
      containerName,
      status,
      composeServiceName,
      ordinal,
      metadata,
      options: optionsResult,
    },
  }
}

export type PatchContainerFields = {
  name?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  containerId?: string
  containerName?: string
  status?: string
  composeServiceName?: string
  updatedAt: string
}

export function parsePatchContainerFields(
  body: Record<string, unknown>,
):
  | { ok: true; patch: PatchContainerFields }
  | ContainerRouteValidationError {
  let patch: PatchContainerFields
  try {
    patch = buildPatchUpdateFields(body)
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const nextContainerId = readOptionalTopLevelString(body, 'containerId')
  const nextContainerName = readOptionalTopLevelString(body, 'containerName')
  const nextStatus = readOptionalTopLevelString(body, 'status')
  const nextComposeServiceName = readOptionalTopLevelString(body, 'composeServiceName')
  if (nextContainerId) patch.containerId = nextContainerId
  if (nextContainerName) patch.containerName = nextContainerName
  if (nextStatus) patch.status = nextStatus
  if (nextComposeServiceName) patch.composeServiceName = nextComposeServiceName

  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400, field: 'metadata' }
  }
  if (metadataResult !== null) {
    patch.metadata = stripPromotedMetadataKeys(
      metadataResult,
      CONTAINER_PROMOTED_METADATA_KEYS,
    )
  }

  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400, field: 'options' }
  }
  if (optionsResult !== null) patch.options = optionsResult

  return { ok: true, patch }
}
