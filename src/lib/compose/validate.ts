import { composeDocumentToYaml } from './convert.ts'
import {
  blockingComposeLintIssues,
  lintComposeYaml,
  type ComposeLintIssue,
} from './lint.ts'
import {
  stripComposePlacement,
  TURBOPANEL_EXTENSION_KEY,
} from './placement.ts'
import { collectServiceTurbopanelValidationIssues } from './service-kind.ts'
import {
  COMPOSE_TAG_KEY,
  isComposeTaggedValue,
  resolveComposeTags,
} from './tags.ts'
import {
  emptyComposeDocument,
  isComposeDocument,
  normalizeCompose,
  type ComposeDocument,
} from './types.ts'

export type ComposeValidationIssue = {
  path: string
  message: string
  level?: ComposeLintIssue['level']
  line?: number
}

export type ComposeValidationResult =
  | { ok: true; document: ComposeDocument }
  | { ok: false; issues: ComposeValidationIssue[] }

export type ComposeValidateOptions = {
  /**
   * Layer role for lint tag semantics. Defaults to `base` (existing call sites
   * unchanged). Overlay prepares later phases can pass `layer: 'overlay'`.
   */
  layer?: 'base' | 'overlay'
  /**
   * Source ids visible to the caller's organization, forwarded to the linter so
   * `x-turbopanel.source.sourceId` can be checked. Omitted by callers that
   * cannot reach the database — the check is then skipped, not failed.
   */
  knownSourceIds?: ReadonlySet<string>
  /**
   * The project's bound repository, forwarded to the linter's
   * one-repository-per-project rule. Omitted by callers with no project
   * context — the check is then skipped, not failed; `null` means the project
   * has no binding yet and the rule weakens to "at most one distinct id".
   */
  projectRepositoryId?: string | null
}

/**
 * Structural validation for stored / editor compose documents.
 * Validates shape before normalization can hide invalid input.
 * A blank document (`data: {}`) is allowed for draft projects; `services` is
 * optional until the author adds it. When present, `services` must be a mapping
 * (including the legacy empty form `services: {}`).
 * After shape checks, runs the same compose linter as the UI editor and rejects
 * blocking issues (unknown keys, services missing image/build, invalid YAML).
 * Intentionally empty values (`null` / `undefined`) become emptyComposeDocument().
 *
 * Tagged `services` / `services.<name>` nodes (`!reset` / `!override`) are
 * structurally valid; placement and service-extension checks run on the
 * unwrapped view via {@link resolveComposeTags}.
 */
export function validateComposeDocument(
  value: unknown,
  options?: ComposeValidateOptions,
): ComposeValidationResult {
  const layer = options?.layer ?? 'base'
  const knownSourceIds = options?.knownSourceIds
  const projectRepositoryId = options?.projectRepositoryId

  if (value == null) {
    return { ok: true, document: emptyComposeDocument() }
  }

  if (!isComposeDocument(value)) {
    return {
      ok: false,
      issues: [{
        path: 'compose',
        message: 'must be a ComposeDocument (version 1 with data and presentation)',
      }],
    }
  }

  const document = normalizeCompose(value)
  const issues: ComposeValidationIssue[] = []

  collectMalformedTagIssues(document.data, '', issues)

  if ('services' in document.data) {
    const services = document.data.services
    if (isComposeTaggedValue(services)) {
      // Tagged services mapping is intentional; do not require plain mapping.
    } else if (
      typeof services !== 'object' ||
      services === null ||
      Array.isArray(services)
    ) {
      issues.push({ path: 'services', message: 'services must be a mapping' })
    }
  }

  // Placement + extension checks on the unwrapped tree so a tagged extension
  // is still validated once tags are resolved.
  const unwrappedData = resolveComposeTags(document.data) as Record<string, unknown>
  validateTurbopanelExtension(unwrappedData, issues)

  const services = unwrappedData.services
  if (isPlainMapping(services)) {
    for (const issue of collectServiceTurbopanelValidationIssues(services)) {
      issues.push(issue)
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  const lintIssues = blockingComposeLintIssues(
    lintComposeYaml(composeDocumentToYaml(document), {
      layer,
      knownSourceIds,
      // Spread rather than passed straight through: `undefined` has to stay
      // *absent* for the linter to skip the rule instead of reading it as
      // "unbound project".
      ...(projectRepositoryId === undefined ? {} : { projectRepositoryId }),
    }),
  )
  if (lintIssues.length > 0) {
    return {
      ok: false,
      issues: lintIssues.map((issue) => ({
        path: issue.path,
        message: issue.line ? `Line ${issue.line}: ${issue.message}` : issue.message,
        level: issue.level,
        line: issue.line,
      })),
    }
  }

  return { ok: true, document }
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject objects that look like tag sentinels but carry an unknown tag name
 * (guards against hand-crafted JSON / jsonb typos).
 */
function collectMalformedTagIssues(
  value: unknown,
  path: string,
  issues: ComposeValidationIssue[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectMalformedTagIssues(
        item,
        path ? `${path}[${index}]` : `[${index}]`,
        issues,
      )
    })
    return
  }
  if (!isPlainMapping(value)) return

  if (COMPOSE_TAG_KEY in value) {
    const tagName = value[COMPOSE_TAG_KEY]
    if (tagName !== 'reset' && tagName !== 'override') {
      issues.push({
        path: path || '$',
        message: `unknown compose tag "${String(tagName)}" (expected reset or override)`,
      })
      return
    }
    // Well-formed sentinel: walk the inner value only.
    collectMalformedTagIssues(
      value.value,
      path,
      issues,
    )
    return
  }

  for (const [key, child] of Object.entries(value)) {
    collectMalformedTagIssues(
      child,
      path ? `${path}.${key}` : key,
      issues,
    )
  }
}

function validateTurbopanelExtension(
  data: Record<string, unknown>,
  issues: ComposeValidationIssue[],
): void {
  if (!(TURBOPANEL_EXTENSION_KEY in data)) {
    return
  }

  const extension = data[TURBOPANEL_EXTENSION_KEY]
  if (!isPlainMapping(extension)) {
    issues.push({ path: 'x-turbopanel', message: 'x-turbopanel must be a mapping' })
    return
  }

  // Placement is not a stored compose shape — pin lives on environment.server_id.
  // Reject any embedded placement; create/PATCH validation is the write boundary.
  if ('placement' in extension) {
    issues.push({
      path: 'x-turbopanel.placement',
      message: 'placement is not stored in compose; use environment.server_id',
    })
  }
}

export function assertComposeDocument(value: unknown): ComposeDocument {
  const result = validateComposeDocument(value)
  if (!result.ok) {
    throw new TypeError(result.issues.map((i) => `${i.path}: ${i.message}`).join('; '))
  }
  return result.document
}

/**
 * When `options` includes `compose`, validate and rewrite it in place as a
 * normalized ComposeDocument. Returns false when validation fails.
 *
 * Optional `validateOptions.layer` is a seam for later overlay-aware callers;
 * existing routes in projects/environments routes-helpers stay on the default.
 */
export function applyValidatedComposeOption(
  options: Record<string, unknown> | null,
  validateOptions?: ComposeValidateOptions,
): { ok: true } | { ok: false; issues: ComposeValidationIssue[] } {
  if (options === null || !('compose' in options)) {
    return { ok: true }
  }
  const result = validateComposeDocument(options.compose, validateOptions)
  if (!result.ok) return result
  options.compose = result.document
  return { ok: true }
}

/**
 * Strip `x-turbopanel.placement` from compose options after validation.
 * Placement lives on `environment.server_id` — never in project base or
 * environment overlay compose.
 */
export function stripComposePlacementOption(
  options: Record<string, unknown> | null,
): void {
  if (options === null || !('compose' in options)) {
    return
  }
  if (!isComposeDocument(options.compose)) {
    return
  }
  options.compose = stripComposePlacement(options.compose)
}

/** Alias kept for existing project-route call sites. */
export function stripProjectComposePlacementOption(
  options: Record<string, unknown> | null,
): void {
  stripComposePlacementOption(options)
}

export { isComposeDocument }
