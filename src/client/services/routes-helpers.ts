import { parseServiceOptions } from '../../lib/service-options.ts'
import {
  buildPatchUpdateFields,
  parseDescription,
  parseName,
  stripPromotedMetadataKeys,
} from '../shared.ts'

/** Compose name lives on `service.compose_service_name` — never persist into metadata. */
export const SERVICE_PROMOTED_METADATA_KEYS = ['composeServiceName'] as const

export type ServiceRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type ServiceRow = {
  id: string
  /** DB column `name` (renamed display label). */
  name: string | null
  description: string | null
  environmentId: string
  composeServiceName: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export function serializeService(row: ServiceRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    environmentId: row.environmentId,
    composeServiceName: row.composeServiceName,
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

export type ComposeServiceNameRejection = {
  ok: false
  error: 'compose_service_name_read_only'
  message: string
  status: 400
}

/**
 * `composeServiceName` is derived from the compose document (reconcile /
 * managed allocation / container reconcile) — reject any client-supplied
 * value (including explicit `null`) rather than silently ignoring it.
 */
export function rejectComposeServiceNameInBody(
  body: Record<string, unknown>,
): ComposeServiceNameRejection | null {
  if (body.composeServiceName === undefined) return null
  return {
    ok: false,
    error: 'compose_service_name_read_only',
    message:
      'compose_service_name is derived from the compose document and cannot be set directly — edit the compose document instead.',
    status: 400,
  }
}

export type OptionalServiceOptionsResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: NonNullable<ReturnType<typeof parseServiceOptions>> }
  | { kind: 'invalid' }

export function parseOptionalServiceOptions(
  body: Record<string, unknown>,
): OptionalServiceOptionsResult {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') return { kind: 'invalid' }
  if (optionsResult === null) return { kind: 'absent' }
  const parsed = parseServiceOptions(optionsResult)
  if (parsed === null) return { kind: 'invalid' }
  return { kind: 'value', value: parsed }
}

export function stripServicePromotedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return stripPromotedMetadataKeys(metadata, SERVICE_PROMOTED_METADATA_KEYS)
}

export function parseServiceCreateFields(
  body: Record<string, unknown>,
):
  | {
    ok: true
    name: string | null
    description: string | null
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
  }
  | ComposeServiceNameRejection
  | ServiceRouteValidationError {
  const composeNameRejected = rejectComposeServiceNameInBody(body)
  if (composeNameRejected) return composeNameRejected

  try {
    const name = parseName(body)
    const description = parseDescription(body)
    const metadataResult = parseJsonbField(body, 'metadata')
    if (metadataResult === 'invalid') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }

    const optionsResult = parseOptionalServiceOptions(body)
    if (optionsResult.kind === 'invalid') {
      return { ok: false, error: 'invalid_service_options', status: 400 }
    }

    const metadata = metadataResult === null
      ? null
      : stripServicePromotedMetadata(metadataResult)

    return {
      ok: true,
      name,
      description,
      metadata,
      options: optionsResult.kind === 'value' ? optionsResult.value : null,
    }
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
}

export const SERVICE_CREATE_NOT_SUPPORTED = {
  error: 'service_create_not_supported',
  message:
    'Services are created automatically from the compose document (save the project/environment compose, or create the environment) — POST /services is not supported.',
} as const

export type ServicePatchFields = {
  name?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

export function parseServicePatchFields(
  body: Record<string, unknown>,
):
  | { ok: true; patch: ServicePatchFields }
  | ComposeServiceNameRejection
  | ServiceRouteValidationError {
  const composeNameRejected = rejectComposeServiceNameInBody(body)
  if (composeNameRejected) return composeNameRejected

  let patch: ServicePatchFields
  try {
    // Maps JSON `name` → column `name` (display label).
    patch = buildPatchUpdateFields(body)
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (metadataResult !== null) {
    patch.metadata = stripServicePromotedMetadata(metadataResult)
  }

  const optionsResult = parseOptionalServiceOptions(body)
  if (optionsResult.kind === 'invalid') {
    return { ok: false, error: 'invalid_service_options', status: 400 }
  }
  if (optionsResult.kind === 'value') {
    patch.options = optionsResult.value
  }

  return { ok: true, patch }
}
