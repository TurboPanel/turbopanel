/**
 * The ordered compose layers a deploy merges — one implementation.
 *
 * There were three: `deploy-prepare.resolveProjectEnvironmentComposeLayers`,
 * `schedule/plan-deploy.resolveMergedCompose`, and
 * `deploy-layers.buildUserComposeLayers` (which had no non-test callers at all
 * yet read like the real path). Each hard-coded exactly two layers, so adding a
 * third meant finding all three.
 *
 * Host-free: no DB, no Hono. Callers map `ComposeChainError` onto whatever
 * their surface returns.
 */

import { mergeComposeLayers } from './layers.ts'
import { principalAliasesInComposeData } from './root-extension.ts'
import {
  assertComposeDocument,
  assertComposeLayerDocument,
  type ComposeValidateOptions,
  type ComposeValidationIssue,
  validateComposeDocument,
} from './validate.ts'
import type { ComposeDocument, ComposeLayer } from './index.ts'

/** Emitted as the project layer's filename on the deploy host. */
export const PROJECT_COMPOSE_FILENAME = 'docker-compose.yml'

/** Cap on operator-authored extra layers per parent. */
export const MAX_COMPOSE_OVERLAYS = 8

export type ComposeChainError = { kind: 'invalid_compose' }

export function isComposeChainError(value: unknown): value is ComposeChainError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** One stored extra layer, beyond the project/environment base documents. */
export type ComposeOverlayRecord = {
  id: string
  name: string
  filename: string
  document: ComposeDocument
  /** Set when the layer's content came from a repository. */
  origin?: { sourceId: string; ref: string; path: string; commitSha: string }
}

/** Host-free: pull `options.compose` (or null) out of a jsonb options blob. */
export function extractComposeFromOptions(options: unknown): unknown {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return null
  }
  return (options as Record<string, unknown>).compose ?? null
}

/** Host-free: pull `options.composeOverlays` (or `[]`). */
export function extractComposeOverlays(options: unknown): ComposeOverlayRecord[] {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return []
  }
  const raw = (options as Record<string, unknown>).composeOverlays
  if (!Array.isArray(raw)) return []
  const out: ComposeOverlayRecord[] = []
  for (const entry of raw.slice(0, MAX_COMPOSE_OVERLAYS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.filename !== 'string') {
      continue
    }
    out.push({
      id: record.id,
      name: typeof record.name === 'string' ? record.name : record.id,
      filename: record.filename,
      document: assertComposeLayerDocument(record.document ?? null),
      ...(isOriginRecord(record.origin) ? { origin: record.origin } : {}),
    })
  }
  return out
}

function isOriginRecord(value: unknown): value is ComposeOverlayRecord['origin'] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.sourceId === 'string' &&
    typeof record.ref === 'string' &&
    typeof record.path === 'string' &&
    typeof record.commitSha === 'string'
  )
}

/**
 * Project base → project overlays → environment base → environment overlays.
 *
 * Roles stay the closed union they were: a role is a semantic **tier**, not a
 * per-file identity, and ordering within a tier is array position. Adding a
 * role per file would multiply the union without adding information and break
 * every `switch` on it.
 *
 * Only the project's own base document has to stand on its own (every Docker
 * service names an `image` or `build`). Every other layer — the environment's
 * "Changes for {env}" and any extra overlay file — may be partial, e.g. just a
 * `command` for a service the Base defines, so the chain reads them with
 * {@link assertComposeLayerDocument}. That moves the "has something to run"
 * rule, it does not drop it: `validateComposeForDeploy` runs it over the merge
 * of these layers, along with every other rule, at deploy.
 *
 * With no overlays this returns exactly the two layers the old builders did —
 * that byte-identity is the guard on "no compose override, just env vars"
 * staying the untouched default.
 */
export function resolveComposeLayerChain(params: {
  projectOptions: unknown
  environmentOptions: unknown
  environmentFilename: string
}): ComposeLayer[] | ComposeChainError {
  try {
    const layers: ComposeLayer[] = [
      {
        role: 'project',
        filename: PROJECT_COMPOSE_FILENAME,
        document: assertComposeDocument(extractComposeFromOptions(params.projectOptions)),
      },
    ]
    for (const overlay of extractComposeOverlays(params.projectOptions)) {
      layers.push({
        role: 'project',
        filename: overlay.filename,
        document: overlay.document,
      })
    }
    layers.push({
      role: 'environment',
      filename: params.environmentFilename,
      document: assertComposeLayerDocument(extractComposeFromOptions(params.environmentOptions)),
    })
    for (const overlay of extractComposeOverlays(params.environmentOptions)) {
      layers.push({
        role: 'environment',
        filename: overlay.filename,
        document: overlay.document,
      })
    }
    return layers
  } catch {
    return { kind: 'invalid_compose' }
  }
}

/** `Line 12: ` prefixes a message with a position in the *merged* text. */
const LINE_PREFIX = /^Line \d+: /

const UNREADABLE_BASE_MESSAGE =
  "The project's Base compose, or one of the extra compose layers, could not be read, so these changes cannot be checked against it. Fix that first."

/**
 * Save-time check of an environment's "Changes for {env}" against the Base.
 *
 * The environment's own document is validated as a partial layer (it may set
 * one field of a service the Base defines), so on its own it cannot say whether
 * a service has something to run, or whether the sum of Base and changes is a
 * document TurboPanel will deploy. This answers that: it merges the project's
 * layers, the environment's document and any extra environment layers exactly
 * as a deploy does, and runs the full document validation over the result with
 * the strict default (every Docker service names an `image` or `build`, and
 * every other rule unchanged). A service that is new in the environment must
 * therefore carry its own `image` or `build`; one defined by the Base need not.
 *
 * `validateOptions` carries the caller's reference sets (repositories, TLS
 * rows, addresses); the principal aliases are re-derived from the merged
 * document because after a merge that is the whole of the scope.
 *
 * Positions in a merged document mean nothing to someone editing one layer, so
 * the `Line N:` prefix and `line` field are dropped from what comes back.
 * Returns an empty list when the merge is valid. Deploy runs the stricter
 * `validateComposeForDeploy` over the same merge, so nothing refused there is
 * accepted here by omission.
 */
export function validateEnvironmentComposeAgainstBase(params: {
  projectOptions: unknown
  environmentOptions: unknown
  validateOptions?: ComposeValidateOptions
}): ComposeValidationIssue[] {
  const chain = resolveComposeLayerChain({
    projectOptions: params.projectOptions,
    environmentOptions: params.environmentOptions,
    environmentFilename: 'docker-compose.environment.yml',
  })
  if (isComposeChainError(chain)) {
    return [{ path: 'compose', message: UNREADABLE_BASE_MESSAGE }]
  }
  let merged: ComposeDocument
  try {
    merged = mergeComposeLayers(chain)
  } catch {
    return [{ path: 'compose', message: UNREADABLE_BASE_MESSAGE }]
  }
  const result = validateComposeDocument(merged, {
    ...params.validateOptions,
    layer: 'base',
    requireImageOrBuild: true,
    merged: true,
    knownPrincipalAliases: principalAliasesInComposeData(merged.data),
  })
  if (result.ok) return []
  return result.issues.map(({ line: _line, message, ...rest }) => ({
    ...rest,
    message: message.replace(LINE_PREFIX, ''),
  }))
}
