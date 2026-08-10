import {
  applyValidatedComposeOption,
  stripProjectComposePlacementOption,
  type ComposeLintIssue,
} from '../../lib/compose/index.ts'
import { isPlacementServerId } from '../../lib/compose/placement.ts'
import {
  parseContainerNamingInput,
  parseDefaultServerIdInput,
} from '../../lib/project-options.ts'
import {
  parseDescription,
  parseDisplayName,
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
  issues: ComposeLintIssue[]
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
  | { ok: true; displayName: string | null; description: string | null }
  | ProjectRouteValidationError {
  try {
    return {
      ok: true,
      displayName: parseDisplayName(body),
      description: parseDescription(body),
    }
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
}

export function parseCreateProjectOptions(
  body: Record<string, unknown>,
):
  | { ok: true; options: Record<string, unknown> | null }
  | ProjectComposeValidationError
  | ProjectRouteValidationError {
  const optionsResult = parseJsonbField(body, 'options')
  if (optionsResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  const createComposeOption = applyValidatedComposeOption(optionsResult)
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
    : stripPromotedMetadataKeys(metadataResult, ['component'])
  return { ok: true, metadata }
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

export function normalizeProjectPatchOptions(
  optionsResult: Record<string, unknown>,
):
  | { ok: true; options: Record<string, unknown> }
  | ProjectComposeValidationError
  | ProjectRouteValidationError {
  const composeOption = applyValidatedComposeOption(optionsResult)
  if (!composeOption.ok) {
    return {
      ok: false,
      error: 'compose_invalid',
      issues: composeOption.issues,
      status: 400,
    }
  }

  if ('containerNaming' in optionsResult) {
    const naming = parseContainerNamingInput(optionsResult.containerNaming)
    if (!naming.ok) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    optionsResult.containerNaming = naming.value
  }

  if ('defaultServerId' in optionsResult) {
    const parsed = parseDefaultServerIdInput(optionsResult.defaultServerId)
    if (!parsed.ok) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    if (parsed.value === null) {
      delete optionsResult.defaultServerId
    } else {
      optionsResult.defaultServerId = parsed.value
    }
  }

  stripProjectComposePlacementOption(optionsResult)
  return { ok: true, options: optionsResult }
}

export function parseProjectPatchOptionsBody(
  body: Record<string, unknown>,
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
  return normalizeProjectPatchOptions(optionsResult)
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
