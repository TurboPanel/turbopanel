/** Versioned Docker Compose document stored in project/environment `options.compose`. */

export type ComposeComment = {
  /** commentBefore on the value node (e.g. `#` lines before nested map children). */
  before?: string
  /** Trailing `#` on the value scalar (e.g. `image: nginx:alpine # line comment`). */
  inline?: string
  /**
   * commentBefore on the mapping key. Kept separate from {@link before} so key and
   * value comments at the same path never overwrite each other on round-trip.
   */
  keyBefore?: string
  /** Trailing `#` on the mapping key. */
  keyInline?: string
}

export type ComposePresentation = {
  /** Top-level mapping key order (e.g. services before networks). */
  keyOrder: string[]
  /** Path (dot-joined) → comments attached to that node. */
  comments: Record<string, ComposeComment>
  /** Path → number of blank lines before the node. */
  blankLines?: Record<string, number>
  /**
   * Leading `#` lines on the Document when separated from the root mapping by
   * a blank line (yaml attaches those to `Document.commentBefore`, not the
   * first key). Without a blank line, leading comments land on the first key
   * as {@link ComposeComment.keyBefore} instead.
   */
  documentCommentBefore?: string
  /** Trailing `#` lines after the document root (`Document.comment`). */
  documentComment?: string
  /** Editor | Visual tab preference — presentation only, never written to compose YAML. */
  editorView?: ComposeEditorView
}

export type ComposeEditorView = 'editor' | 'visual'

export function isComposeEditorView(value: unknown): value is ComposeEditorView {
  return value === 'editor' || value === 'visual'
}

const TURBOPANEL_EXTENSION_KEY = 'x-turbopanel'

export type ComposeDocument = {
  version: 1
  /** Compose tree as JSON (`services`, `networks`, …). */
  data: Record<string, unknown>
  /** Editor presentation only — stripped for runtime deploy. */
  presentation: ComposePresentation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEmptyComposeMapping(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

/** True when compose has no substantive content (e.g. `{}` or only `services: {}`). */
export function isBlankComposeData(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data)
  if (keys.length === 0) {
    return true
  }
  return keys.every((key) => isEmptyComposeMapping(data[key]))
}

/** Drop top-level keys whose value is an empty mapping (`services: {}`, …). */
export function pruneBlankComposeData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const pruned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (isEmptyComposeMapping(value)) {
      continue
    }
    pruned[key] = value
  }
  return pruned
}

export function emptyComposeDocument(): ComposeDocument {
  return {
    version: 1,
    data: {},
    presentation: {
      keyOrder: [],
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
  const data = pruneBlankComposeData({ ...value.data })
  if (isBlankComposeData(data)) {
    return emptyComposeDocument()
  }
  const presentation = value.presentation
  const editorView = isComposeEditorView(presentation.editorView)
    ? presentation.editorView
    : undefined
  let keyOrder = presentation.keyOrder.filter((key) => key in data)
  if (!(TURBOPANEL_EXTENSION_KEY in data)) {
    keyOrder = keyOrder.filter((key) => key !== TURBOPANEL_EXTENSION_KEY)
  }
  return {
    version: 1,
    data,
    presentation: {
      keyOrder,
      comments: { ...presentation.comments },
      ...(presentation.blankLines
        ? { blankLines: { ...presentation.blankLines } }
        : {}),
      ...(typeof presentation.documentCommentBefore === 'string' &&
          presentation.documentCommentBefore.length > 0
        ? { documentCommentBefore: presentation.documentCommentBefore }
        : {}),
      ...(typeof presentation.documentComment === 'string' &&
          presentation.documentComment.length > 0
        ? { documentComment: presentation.documentComment }
        : {}),
      ...(editorView ? { editorView } : {}),
    },
  }
}
