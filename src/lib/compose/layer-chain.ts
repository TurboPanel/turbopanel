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

import { assertComposeDocument } from './validate.ts'
import type { ComposeDocument, ComposeLayer } from './index.ts'

/** Emitted as the project layer's filename on the deploy host. */
export const PROJECT_COMPOSE_FILENAME = 'docker-compose.yml'

/** Cap on operator-authored extra layers per parent. */
export const MAX_COMPOSE_OVERLAYS = 8

export type ComposeChainError = { kind: 'invalid_compose' }

export function isComposeChainError(
  value: unknown,
): value is ComposeChainError {
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
export function extractComposeOverlays(
  options: unknown,
): ComposeOverlayRecord[] {
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
      document: assertComposeDocument(record.document ?? null),
      ...(isOriginRecord(record.origin) ? { origin: record.origin } : {}),
    })
  }
  return out
}

function isOriginRecord(
  value: unknown,
): value is ComposeOverlayRecord['origin'] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.sourceId === 'string' &&
    typeof record.ref === 'string' &&
    typeof record.path === 'string' &&
    typeof record.commitSha === 'string'
}

/**
 * Project base → project overlays → environment base → environment overlays.
 *
 * Roles stay the closed union they were: a role is a semantic **tier**, not a
 * per-file identity, and ordering within a tier is array position. Adding a
 * role per file would multiply the union without adding information and break
 * every `switch` on it.
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
        document: assertComposeDocument(
          extractComposeFromOptions(params.projectOptions),
        ),
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
      document: assertComposeDocument(
        extractComposeFromOptions(params.environmentOptions),
      ),
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
