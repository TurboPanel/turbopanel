import {
  applyValidatedComposeOption,
  stripProjectComposePlacementOption,
  type ComposeValidateOptions,
  type ComposeValidationIssue,
} from '../../lib/compose/index.ts'
import {
  parseComposeSourceInput,
  parseContainerNamingInput,
  parseDefaultServerIdInput,
} from '../../lib/project-options.ts'
import { isPlacementServerId } from '../../lib/compose/placement.ts'
import {
  parseDescription,
  parseName,
  stripPromotedMetadataKeys,
} from '../shared.ts'
import {
  getCatalogEntry,
  isCreateProjectType,
  type CatalogEntry,
  type CreateProjectType,
} from './catalog/index.ts'
import { isConfiguredProjectType } from './empty-setup.ts'

export type ProjectRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type ProjectComposeValidationError = {
  ok: false
  error: 'compose_invalid'
  issues: ComposeValidationIssue[]
  status: 400
}

export type ResolvedCreateProjectType = CreateProjectType | 'empty'

export function resolveCreateProjectType(
  body: Record<string, unknown>,
): ResolvedCreateProjectType | 'invalid' {
  const rawType = body.type
  // Missing / blank type is rejected — callers must send an explicit value.
  if (rawType === undefined || rawType === null || rawType === '') {
    return 'invalid'
  }
  // Explicit empty — name + workspace only; type chosen later via configure.
  if (rawType === 'empty') {
    return 'empty'
  }
  if (typeof rawType !== 'string' || !isCreateProjectType(rawType)) {
    return 'invalid'
  }
  return rawType
}

export function resolveCatalogEntryForCreate(
  projectType: ResolvedCreateProjectType,
  body: Record<string, unknown>,
): CatalogEntry | 'missing_code' | 'unknown_code' | undefined {
  if (projectType !== 'template' && projectType !== 'managed') {
    return undefined
  }
  const code = body.code
  if (typeof code !== 'string' || !code) {
    return 'missing_code'
  }
  const catalogEntry = getCatalogEntry(code)
  if (catalogEntry?.kind !== projectType) {
    return 'unknown_code'
  }
  return catalogEntry
}

export function mapCreateProjectError(err: unknown): {
  error: string
  status: 503
} | null {
  if (!(err instanceof Error)) return null
  if (err.message === 'encryption unavailable') {
    return { error: 'Encryption unavailable', status: 503 }
  }
  return null
}

export function catalogProjectOptions(
  fields: {
    options: Record<string, unknown> | null
    entry: CatalogEntry
  },
  includeEngineOptions: boolean,
): Record<string, unknown> {
  if (fields.options) return fields.options
  if (includeEngineOptions && fields.entry.options) {
    return { compose: fields.entry.compose, ...fields.entry.options }
  }
  return { compose: fields.entry.compose }
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

export function parseCreateProjectNames(
  body: Record<string, unknown>,
):
  | { ok: true; name: string | null; description: string | null }
  | ProjectRouteValidationError {
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

export function parseCreateProjectOptions(
  body: Record<string, unknown>,
  validateOptions?: ComposeValidateOptions,
):
  | { ok: true; options: Record<string, unknown> | null }
  | ProjectComposeValidationError
  | ProjectRouteValidationError {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  // Reject rather than drop: losing the provenance of a project's compose is
  // not something the operator can notice or recover from.
  if (optionsResult !== null && 'composeSource' in optionsResult) {
    const parsed = parseComposeSourceInput(
      optionsResult.composeSource,
      validateOptions?.knownSourceIds,
    )
    if (!parsed.ok) {
      return { ok: false, error: parsed.reason, status: 400 }
    }
    if (parsed.value === null) delete optionsResult.composeSource
    else optionsResult.composeSource = parsed.value
  }
  const createComposeOption = applyValidatedComposeOption(optionsResult, validateOptions)
  if (!createComposeOption.ok) {
    return {
      ok: false,
      error: 'compose_invalid',
      issues: createComposeOption.issues,
      status: 400,
    }
  }
  if (optionsResult !== null) {
    stripProjectComposePlacementOption(optionsResult)
  }
  return { ok: true, options: optionsResult }
}

/** Reserved keys the public create path must not persist from caller metadata. */
export const CREATE_PROJECT_PROMOTED_METADATA_KEYS = ['component', 'type'] as const

export function parseCreateProjectMetadata(
  body: Record<string, unknown>,
):
  | { ok: true; metadata: Record<string, unknown> | null }
  | ProjectRouteValidationError {
  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  const metadata = metadataResult === null
    ? null
    : stripPromotedMetadataKeys(metadataResult, CREATE_PROJECT_PROMOTED_METADATA_KEYS)
  return { ok: true, metadata }
}

/**
 * Merge sanitized caller metadata under canonical project-type fields so
 * custom keys cannot erase `type` (or catalog `code` when supplied).
 */
export function stampCreateProjectMetadata(
  metadata: Record<string, unknown> | null,
  canonical: Record<string, unknown>,
): Record<string, unknown> {
  return { ...metadata, ...canonical }
}

export function parseCreateProjectServerIdField(
  body: Record<string, unknown>,
):
  | { ok: true; serverId: string | null | undefined }
  | ProjectRouteValidationError {
  if (body.serverId === undefined) {
    return { ok: true, serverId: undefined }
  }
  if (body.serverId === null) {
    return { ok: true, serverId: null }
  }
  if (typeof body.serverId !== 'string' || body.serverId.length === 0) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, serverId: body.serverId }
}

/**
 * Normalize `composeSource` in place. Rejects rather than drops: losing the
 * provenance of a project's compose is not something the operator can notice
 * or recover from.
 */
function normalizeComposeSourceOption(
  options: Record<string, unknown>,
  validateOptions?: ComposeValidateOptions,
): ProjectRouteValidationError | null {
  if (!('composeSource' in options)) return null
  const parsed = parseComposeSourceInput(
    options.composeSource,
    validateOptions?.knownSourceIds,
  )
  if (!parsed.ok) return { ok: false, error: parsed.reason, status: 400 }
  if (parsed.value === null) delete options.composeSource
  else options.composeSource = parsed.value
  return null
}

function normalizeContainerNamingOption(
  options: Record<string, unknown>,
): ProjectRouteValidationError | null {
  if (!('containerNaming' in options)) return null
  const naming = parseContainerNamingInput(options.containerNaming)
  if (!naming.ok) return { ok: false, error: 'Invalid request', status: 400 }
  options.containerNaming = naming.value
  return null
}

function normalizeDefaultServerIdOption(
  options: Record<string, unknown>,
): ProjectRouteValidationError | null {
  if (!('defaultServerId' in options)) return null
  const parsed = parseDefaultServerIdInput(options.defaultServerId)
  if (!parsed.ok) return { ok: false, error: 'Invalid request', status: 400 }
  if (parsed.value === null) delete options.defaultServerId
  else options.defaultServerId = parsed.value
  return null
}

export function normalizeProjectPatchOptions(
  optionsResult: Record<string, unknown>,
  validateOptions?: ComposeValidateOptions,
):
  | { ok: true; options: Record<string, unknown> }
  | ProjectComposeValidationError
  | ProjectRouteValidationError {
  const composeSourceError = normalizeComposeSourceOption(
    optionsResult,
    validateOptions,
  )
  if (composeSourceError) return composeSourceError

  const composeOption = applyValidatedComposeOption(optionsResult, validateOptions)
  if (!composeOption.ok) {
    return {
      ok: false,
      error: 'compose_invalid',
      issues: composeOption.issues,
      status: 400,
    }
  }

  const namingError = normalizeContainerNamingOption(optionsResult)
  if (namingError) return namingError

  const serverIdError = normalizeDefaultServerIdOption(optionsResult)
  if (serverIdError) return serverIdError

  stripProjectComposePlacementOption(optionsResult)
  return { ok: true, options: optionsResult }
}

export function parseProjectPatchOptionsBody(
  body: Record<string, unknown>,
  validateOptions?: ComposeValidateOptions,
):
  | { ok: true; options: Record<string, unknown> | null }
  | ProjectComposeValidationError
  | ProjectRouteValidationError {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (optionsResult === null) {
    return { ok: true, options: null }
  }
  return normalizeProjectPatchOptions(optionsResult, validateOptions)
}

export function assertDefaultServerIdShape(
  options: Record<string, unknown> | null | undefined,
): ProjectRouteValidationError | null {
  if (!options || !('defaultServerId' in options)) return null
  const serverId = options.defaultServerId
  if (serverId === undefined || serverId === null) return null
  if (!isPlacementServerId(serverId)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return null
}

export function parseConfigureProjectBody(
  body: Record<string, unknown>,
):
  | { ok: true; projectType: CreateProjectType; catalogCode?: string }
  | ProjectRouteValidationError {
  const rawType = body.type
  if (typeof rawType !== 'string' || !isConfiguredProjectType(rawType)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  if (rawType === 'template' || rawType === 'managed') {
    if (typeof body.code !== 'string' || !body.code) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    return { ok: true, projectType: rawType, catalogCode: body.code }
  }

  return { ok: true, projectType: rawType }
}
