import {
  normalizeCompose,
  type ComposeDocument,
  type ComposePresentation,
} from './types.ts'

export const TURBOPANEL_EXTENSION_KEY = 'x-turbopanel'

export type ComposeTurbopanelExtension = {
  placement?: {
    server_id?: string
  }
}

/** Lenient UUID (any version), matching server-registry enrollment IDs. */
const PLACEMENT_SERVER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isPlacementServerId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && PLACEMENT_SERVER_ID_RE.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  return value
}

/** Shallow-clone presentation with a replacement keyOrder. */
function clonePresentation(
  presentation: ComposePresentation,
  keyOrder: string[],
): ComposePresentation {
  const next: ComposePresentation = {
    keyOrder,
    comments: { ...presentation.comments },
  }
  if (presentation.blankLines) {
    next.blankLines = { ...presentation.blankLines }
  }
  const documentCommentBefore = nonEmptyString(presentation.documentCommentBefore)
  if (documentCommentBefore) {
    next.documentCommentBefore = documentCommentBefore
  }
  const documentComment = nonEmptyString(presentation.documentComment)
  if (documentComment) {
    next.documentComment = documentComment
  }
  if (presentation.editorView) {
    next.editorView = presentation.editorView
  }
  return next
}

/**
 * Remove `x-turbopanel.placement` while preserving any other extension fields.
 * Deletes the `x-turbopanel` key entirely when nothing remains.
 *
 * Compose is not a placement store — placement lives on `environment.server_id`.
 * This is an input-sanitization path only: it strips any placement a client
 * might still submit embedded in compose, on save and again defensively
 * before merging project + environment compose for deploy.
 */
export function stripComposePlacement(document: ComposeDocument): ComposeDocument {
  const normalized = normalizeCompose(document)
  const extension = normalized.data[TURBOPANEL_EXTENSION_KEY]
  if (!isPlainObject(extension) || !('placement' in extension)) {
    return normalized
  }

  const { placement: _removed, ...rest } = extension
  const data = { ...normalized.data }
  const keyOrder = [...normalized.presentation.keyOrder]

  if (Object.keys(rest).length === 0) {
    delete data[TURBOPANEL_EXTENSION_KEY]
    return {
      version: 1,
      data,
      presentation: clonePresentation(
        normalized.presentation,
        keyOrder.filter((key) => key !== TURBOPANEL_EXTENSION_KEY),
      ),
    }
  }

  data[TURBOPANEL_EXTENSION_KEY] = rest
  return {
    version: 1,
    data,
    presentation: clonePresentation(normalized.presentation, keyOrder),
  }
}
