import { isComposeDocument, normalizeCompose, type ComposeDocument } from './types.ts'

export type ComposeValidationIssue = {
  path: string
  message: string
}

export type ComposeValidationResult =
  | { ok: true; document: ComposeDocument }
  | { ok: false; issues: ComposeValidationIssue[] }

/**
 * Structural validation for stored / editor compose documents.
 * Empty `services: {}` is allowed (draft project).
 */
export function validateComposeDocument(value: unknown): ComposeValidationResult {
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

export { isComposeDocument }
