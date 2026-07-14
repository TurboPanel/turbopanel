import {
  emptyComposeDocument,
  isComposeDocument,
  normalizeCompose,
  type ComposeDocument,
} from './types.ts'

export type ComposeValidationIssue = {
  path: string
  message: string
}

export type ComposeValidationResult =
  | { ok: true; document: ComposeDocument }
  | { ok: false; issues: ComposeValidationIssue[] }

/**
 * Structural validation for stored / editor compose documents.
 * Validates shape before normalization can hide invalid input.
 * Empty `services: {}` is allowed (draft project).
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

  if (!('services' in document.data)) {
    issues.push({ path: 'services', message: 'Compose document must include a services mapping' })
  } else if (
    typeof document.data.services !== 'object' ||
    document.data.services === null ||
    Array.isArray(document.data.services)
  ) {
    issues.push({ path: 'services', message: 'services must be a mapping' })
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }
  return { ok: true, document }
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

export { isComposeDocument }
