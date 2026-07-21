import { normalizeCompose, type ComposeDocument } from './types.ts'

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

/**
 * Read `x-turbopanel.placement.server_id` when present as a non-empty string.
 * Malformed shapes return null; UUID format is enforced by validation, not here.
 */
export function readComposePlacementServerId(document: ComposeDocument): string | null {
  const extension = document.data[TURBOPANEL_EXTENSION_KEY]
  if (!isPlainObject(extension)) {
    return null
  }

  const placement = extension.placement
  if (!isPlainObject(placement)) {
    return null
  }

  const serverId = placement.server_id
  if (typeof serverId !== 'string') {
    return null
  }

  const trimmed = serverId.trim()
  if (trimmed.length === 0) {
    return null
  }

  return trimmed
}

/**
 * Remove `x-turbopanel.placement` while preserving any other extension fields.
 * Deletes the `x-turbopanel` key entirely when nothing remains.
 *
 * Used for the hard cut that moves server pins to environments: project base
 * compose must not contribute placement to merged runtime YAML.
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
      presentation: {
        keyOrder: keyOrder.filter((key) => key !== TURBOPANEL_EXTENSION_KEY),
        comments: { ...normalized.presentation.comments },
        ...(normalized.presentation.blankLines
          ? { blankLines: { ...normalized.presentation.blankLines } }
          : {}),
        ...(typeof normalized.presentation.documentCommentBefore === 'string' &&
            normalized.presentation.documentCommentBefore.length > 0
          ? { documentCommentBefore: normalized.presentation.documentCommentBefore }
          : {}),
        ...(typeof normalized.presentation.documentComment === 'string' &&
            normalized.presentation.documentComment.length > 0
          ? { documentComment: normalized.presentation.documentComment }
          : {}),
        ...(normalized.presentation.editorView
          ? { editorView: normalized.presentation.editorView }
          : {}),
      },
    }
  }

  data[TURBOPANEL_EXTENSION_KEY] = rest
  return {
    version: 1,
    data,
    presentation: {
      keyOrder,
      comments: { ...normalized.presentation.comments },
      ...(normalized.presentation.blankLines
        ? { blankLines: { ...normalized.presentation.blankLines } }
        : {}),
      ...(typeof normalized.presentation.documentCommentBefore === 'string' &&
          normalized.presentation.documentCommentBefore.length > 0
        ? { documentCommentBefore: normalized.presentation.documentCommentBefore }
        : {}),
      ...(typeof normalized.presentation.documentComment === 'string' &&
          normalized.presentation.documentComment.length > 0
        ? { documentComment: normalized.presentation.documentComment }
        : {}),
      ...(normalized.presentation.editorView
        ? { editorView: normalized.presentation.editorView }
        : {}),
    },
  }
}
