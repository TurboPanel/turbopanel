import {
  applyValidatedComposeOption,
  type ComposeValidateOptions,
  type ComposeValidationIssue,
  isPlacementServerId,
  stripComposePlacementOption,
} from '../../features/compose/index.ts'
import { validateEnvironmentComposeAgainstBase } from '../../features/compose/layer-chain.ts'
import {
  settleDeployOptions,
  stampNewEnvironmentDeployOptions,
  validateDeployOptions,
} from '../../features/deploy/deploy-options.ts'
import { parseDescription, parseName, stripPromotedMetadataKeys } from '../shared.ts'

/** Placement lives on `environment.server_id` — never persist it into metadata.
 * `component` is reserved for system project identity — never accept it on
 * public environment create/patch. `composeHostAccessApproval` is written only
 * by the deploy planner when an organization manager or owner deploys
 * host-level Compose content (`HOST_ACCESS_APPROVAL_METADATA_KEY`); accepting
 * it from a client would let an approval be claimed rather than earned. */
export const ENVIRONMENT_PROMOTED_METADATA_KEYS = [
  'serverId',
  'component',
  'composeHostAccessApproval',
] as const

export type EnvironmentRouteValidationError = {
  ok: false
  error: string
  /** Operator-facing detail when the code alone is not enough. */
  message?: string
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
  field: string
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
  body: Record<string, unknown>
): { ok: true; name: string | null; description: string | null } | EnvironmentRouteValidationError {
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
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return stripPromotedMetadataKeys(metadata, ENVIRONMENT_PROMOTED_METADATA_KEYS)
}

function deployOptionsError(reason: string): EnvironmentRouteValidationError {
  return { ok: false, error: 'deploy_options_invalid', message: reason, status: 400 }
}

/**
 * Validate the compose an environment is being saved with.
 *
 * An environment's compose is "Changes for {env}": it may set one field of a
 * service the project's Base defines, so alone it need not name an `image` or
 * `build`. When the caller supplies the project's options, the document is
 * therefore checked as a partial layer and then, once more, as the MERGE of the
 * Base layers, this document and any extra environment layers - where every
 * rule applies in full, including "every Docker service has an image or
 * build". Without the project's options (no way to build the merge) the
 * document is held to the strict standalone rule, as before.
 */
function validateEnvironmentCompose(
  options: Record<string, unknown> | null,
  validateOptions: ComposeValidateOptions | undefined,
  projectOptions: unknown
): EnvironmentComposeValidationError | null {
  const merging = projectOptions !== undefined
  const composeOption = applyValidatedComposeOption(
    options,
    merging ? { ...validateOptions, requireImageOrBuild: false } : validateOptions
  )
  if (!composeOption.ok) {
    return { ok: false, error: 'compose_invalid', issues: composeOption.issues, status: 400 }
  }
  if (options === null) return null
  stripComposePlacementOption(options)
  if (!merging || !('compose' in options || 'composeOverlays' in options)) return null
  const issues = validateEnvironmentComposeAgainstBase({
    projectOptions,
    environmentOptions: options,
    validateOptions,
  })
  return issues.length === 0 ? null : { ok: false, error: 'compose_invalid', issues, status: 400 }
}

export function parseCreateEnvironmentJsonb(
  body: Record<string, unknown>,
  validateOptions?: ComposeValidateOptions,
  projectOptions?: unknown
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
  const composeError = validateEnvironmentCompose(optionsResult, validateOptions, projectOptions)
  if (composeError) return composeError
  const deployOptions =
    optionsResult === null
      ? { ok: true as const }
      : validateDeployOptions(optionsResult, 'environment')
  if (!deployOptions.ok) return deployOptionsError(deployOptions.reason)

  const metadataResult = parseJsonbField(body, 'metadata')
  if (metadataResult === 'invalid') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  const metadata = metadataResult === null ? null : stripEnvironmentPromotedMetadata(metadataResult)

  // A new environment defaults to `sequential` unless the caller chose one.
  const settled =
    optionsResult === null ? null : settleDeployOptions(null, optionsResult, 'environment')
  return { metadata, options: stampNewEnvironmentDeployOptions(settled), ok: true }
}

export function parseOptionalServerIdShape(
  body: Record<string, unknown>
): { ok: true; serverId: string | null | undefined } | EnvironmentRouteValidationError {
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
  body: Record<string, unknown>
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
  validateOptions?: ComposeValidateOptions,
  projectOptions?: unknown
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

  const composeError = validateEnvironmentCompose(optionsResult, validateOptions, projectOptions)
  if (composeError) return composeError
  const deployOptions = validateDeployOptions(optionsResult, 'environment')
  if (!deployOptions.ok) return deployOptionsError(deployOptions.reason)
  return { ok: true, options: optionsResult }
}
