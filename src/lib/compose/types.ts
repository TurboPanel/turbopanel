/** Versioned Docker Compose document stored in project/environment `options.compose`. */

export type ComposeComment = {
  before?: string
  inline?: string
}

export type ComposePresentation = {
  /** Top-level mapping key order (e.g. services before networks). */
  keyOrder: string[]
  /** Path (dot-joined) → comments attached to that node. */
  comments: Record<string, ComposeComment>
  /** Path → number of blank lines before the node. */
  blankLines?: Record<string, number>
}

export type ComposeDocument = {
  version: 1
  /** Compose tree as JSON (`services`, `networks`, …). */
  data: Record<string, unknown>
  /** Editor presentation only — stripped for runtime deploy. */
  presentation: ComposePresentation
}

export function emptyComposeDocument(): ComposeDocument {
  return {
    version: 1,
    data: { services: {} },
    presentation: {
      keyOrder: ['services'],
      comments: {},
    },
  }
}

export function isComposeDocument(value: unknown): value is ComposeDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) return false
  if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) {
    return false
  }
  if (
    typeof record.presentation !== 'object' ||
    record.presentation === null ||
    Array.isArray(record.presentation)
  ) {
    return false
  }
  const presentation = record.presentation as Record<string, unknown>
  return Array.isArray(presentation.keyOrder) && typeof presentation.comments === 'object' &&
    presentation.comments !== null && !Array.isArray(presentation.comments)
}

/**
 * Normalize a valid ComposeDocument, or an intentionally empty value (`null` /
 * `undefined`). Does not lift bare compose objects into the current format.
 */
export function normalizeCompose(value: unknown): ComposeDocument {
  if (value == null) return emptyComposeDocument()
  if (!isComposeDocument(value)) return emptyComposeDocument()
  return {
    version: 1,
    data: { ...value.data },
    presentation: {
      keyOrder: [...value.presentation.keyOrder],
      comments: { ...value.presentation.comments },
      ...(value.presentation.blankLines
        ? { blankLines: { ...value.presentation.blankLines } }
        : {}),
    },
  }
}
