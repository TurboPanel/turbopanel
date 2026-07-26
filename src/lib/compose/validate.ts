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

/**
 * Structural validation for stored / editor compose documents.
 * Validates shape before normalization can hide invalid input.
 * A blank document (`data: {}`) is allowed for draft projects; `services` is
 * optional until the author adds it. When present, `services` must be a mapping
 * (including the legacy empty form `services: {}`).
 * After shape checks, runs the same compose linter as the UI editor and rejects
 * blocking issues (unknown keys, services missing image/build, invalid YAML).
 * Intentionally empty values (`null` / `undefined`) become emptyComposeDocument().
 */
export function validateComposeDocument(value: unknown): ComposeValidationResult {
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

  if (
    'services' in document.data &&
    (typeof document.data.services !== 'object' ||
      document.data.services === null ||
      Array.isArray(document.data.services))
  ) {
    issues.push({ path: 'services', message: 'services must be a mapping' })
  }

  validateTurbopanelExtension(document.data, issues)

  const services = document.data.services
  if (isPlainMapping(services)) {
    for (const issue of collectServiceTurbopanelValidationIssues(services)) {
      issues.push(issue)
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  const lintIssues = blockingComposeLintIssues(
    lintComposeYaml(composeDocumentToYaml(document)),
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
  // Reject any embedded placement; deploy/save boundaries also strip defensively.
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
 */
export function applyValidatedComposeOption(
  options: Record<string, unknown> | null,
): { ok: true } | { ok: false; issues: ComposeValidationIssue[] } {
  if (options === null || !('compose' in options)) {
    return { ok: true }
  }
  const result = validateComposeDocument(options.compose)
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
