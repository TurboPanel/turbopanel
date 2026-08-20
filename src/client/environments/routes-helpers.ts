import {
  applyValidatedComposeOption,
  isPlacementServerId,
  stripComposePlacementOption,
  type ComposeValidationIssue,
} from '../../lib/compose/index.ts'
import {
  parseDescription,
  parseName,
  stripPromotedMetadataKeys,
} from '../shared.ts'

/** Placement lives on `environment.server_id` — never persist it into metadata.
 * `component` is reserved for system project identity — never accept it on
 * public environment create/patch. */
export const ENVIRONMENT_PROMOTED_METADATA_KEYS = ['serverId', 'component'] as const

export type EnvironmentRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type EnvironmentComposeValidationError = {
  ok: false
  error: 'compose_invalid'
  issues: ComposeValidationIssue[]
  status: 400
}

export type EnvironmentRow = {
  id: string
  name: string | null
  description: string | null
  projectId: string
  serverId: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export function serializeEnvironment(row: EnvironmentRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    projectId: row.projectId,
    serverId: row.serverId,
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

export function parseCreateEnvironmentNames(
  body: Record<string, unknown>,
):
  | { ok: true; name: string | null; description: string | null }
  | EnvironmentRouteValidationError {
  try {
    return {
      ok: true,
      name: parseName(body),
      description: parseDescription(body),
    }
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
}

export function stripEnvironmentPromotedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return stripPromotedMetadataKeys(metadata, ENVIRONMENT_PROMOTED_METADATA_KEYS)
}

export function parseCreateEnvironmentJsonb(
  body: Record<string, unknown>,
):
  | {
    ok: true
    metadata: Record<string, unknown> | null
    options: Record<string, unknown> | null
  }
  | EnvironmentComposeValidationError
  | EnvironmentRouteValidationError {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return {
      ok: false,
      error: 'compose_invalid',
      issues: composeOption.issues,
      status: 400,
    }
  }
  if (optionsResult !== null) {
    stripComposePlacementOption(optionsResult)
  }

  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  const metadata = metadataResult === null
    ? null
    : stripEnvironmentPromotedMetadata(metadataResult)

  return { metadata, options: optionsResult, ok: true }
}

export function parseOptionalServerIdShape(
  body: Record<string, unknown>,
):
  | { ok: true; serverId: string | null | undefined }
  | EnvironmentRouteValidationError {
  if (!('serverId' in body)) {
    return { ok: true, serverId: undefined }
  }
  const value = body.serverId
  if (value === null) {
    return { ok: true, serverId: null }
  }
  if (!isPlacementServerId(value)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, serverId: value as string }
}

export function parseEnvironmentPatchMetadata(
  body: Record<string, unknown>,
):
  | { ok: true; metadata: Record<string, unknown> | null | 'absent' }
  | EnvironmentRouteValidationError {
  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (metadataResult === null) {
    return { ok: true, metadata: 'absent' }
  }
  return {
    ok: true,
    metadata: stripEnvironmentPromotedMetadata(metadataResult),
  }
}

export function parseEnvironmentPatchOptions(
  body: Record<string, unknown>,
):
  | { ok: true; options: Record<string, unknown> | null | 'absent' }
  | EnvironmentComposeValidationError
  | EnvironmentRouteValidationError {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (optionsResult === null) {
    return { ok: true, options: 'absent' }
  }

  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return {
      ok: false,
      error: 'compose_invalid',
      issues: composeOption.issues,
      status: 400,
    }
  }
  stripComposePlacementOption(optionsResult)
  return { ok: true, options: optionsResult }
}
