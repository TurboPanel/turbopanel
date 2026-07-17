import { composeDocumentToYaml } from './convert.ts'
import {
  blockingComposeLintIssues,
  lintComposeYaml,
  type ComposeLintIssue,
} from './lint.ts'
import {
  isPlacementServerId,
  stripComposePlacement,
  isComposeEditorView,
  TURBOPANEL_EXTENSION_KEY,
} from './placement.ts'
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

  if ('view' in extension && !isComposeEditorView(extension.view)) {
    issues.push({
      path: 'x-turbopanel.view',
      message: 'view must be "editor" or "visual"',
    })
  }

  if (!('placement' in extension)) {
    return
  }

  const placement = extension.placement
  if (!isPlainMapping(placement)) {
    issues.push({ path: 'x-turbopanel.placement', message: 'placement must be a mapping' })
    return
  }

  if (!('server_id' in placement)) {
    return
  }

  if (!isPlacementServerId(placement.server_id)) {
    issues.push({
      path: 'x-turbopanel.placement.server_id',
      message: 'server_id must be a UUID string',
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
 * Strip `x-turbopanel.placement` from project compose options after validation.
 * Server pins belong on environment overlays, not project base compose.
 */
export function stripProjectComposePlacementOption(
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

export { isComposeDocument }
