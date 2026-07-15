import { normalizeCompose, type ComposeDocument } from './types.ts'

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

  const overlayEmpty =
    Object.keys(overlayDoc.data).length === 0 ||
    (Object.keys(overlayDoc.data).length === 1 &&
      isPlainObject(overlayDoc.data.services) &&
      Object.keys(overlayDoc.data.services as Record<string, unknown>).length === 0 &&
      !overlayDoc.presentation.keyOrder.some((k) => k !== 'services'))

  // Empty overlay with only empty services → treat as inherit
  if (
    overlayEmpty &&
    Object.keys(overlayDoc.presentation.comments).length === 0
  ) {
    // Still merge if overlay has non-empty services or other keys
    const hasExtra =
      Object.keys(overlayDoc.data).some((k) => k !== 'services') ||
      (isPlainObject(overlayDoc.data.services) &&
        Object.keys(overlayDoc.data.services).length > 0)
    if (!hasExtra) return baseDoc
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

  return {
    version: 1,
    data: mergedData,
    presentation: {
      keyOrder,
      comments,
      ...(Object.keys(blankLines).length > 0 ? { blankLines } : {}),
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
