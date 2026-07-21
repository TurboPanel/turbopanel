import { isBlankComposeData, normalizeCompose, type ComposeDocument } from './types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge environment overlay onto project base compose `data`.
 * - Objects merge recursively
 * - Arrays and scalars from overlay replace base
 * - Presentation: keep base for untouched top-level paths; overlay wins comments on overlay keys
 */
export function mergeComposeOverlay(
  base: unknown,
  overlay?: unknown,
): ComposeDocument {
  const baseDoc = normalizeCompose(base)
  if (overlay == null) return baseDoc
  const overlayDoc = normalizeCompose(overlay)

  if (
    isBlankComposeData(overlayDoc.data) &&
    Object.keys(overlayDoc.presentation.comments).length === 0
  ) {
    return baseDoc
  }

  const mergedData = deepMerge(baseDoc.data, overlayDoc.data)

  const keyOrder = mergeKeyOrder(baseDoc.presentation.keyOrder, overlayDoc.presentation.keyOrder, mergedData)
  const comments = {
    ...baseDoc.presentation.comments,
    ...overlayDoc.presentation.comments,
  }
  const blankLines = {
    ...baseDoc.presentation.blankLines,
    ...overlayDoc.presentation.blankLines,
  }

  const documentCommentBefore =
    baseDoc.presentation.documentCommentBefore ??
    overlayDoc.presentation.documentCommentBefore
  const documentComment =
    baseDoc.presentation.documentComment ?? overlayDoc.presentation.documentComment
  const editorView =
    overlayDoc.presentation.editorView ?? baseDoc.presentation.editorView

  return {
    version: 1,
    data: mergedData,
    presentation: {
      keyOrder,
      comments,
      ...(Object.keys(blankLines).length > 0 ? { blankLines } : {}),
      ...(documentCommentBefore ? { documentCommentBefore } : {}),
      ...(documentComment ? { documentComment } : {}),
      ...(editorView ? { editorView } : {}),
    },
  }
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue
    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function mergeKeyOrder(
  baseOrder: string[],
  overlayOrder: string[],
  merged: Record<string, unknown>,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const key of [...baseOrder, ...overlayOrder]) {
    if (seen.has(key) || !(key in merged)) continue
    seen.add(key)
    result.push(key)
  }
  for (const key of Object.keys(merged)) {
    if (seen.has(key)) continue
    result.push(key)
  }
  return result
}
