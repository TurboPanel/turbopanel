/**
 * Hidden TurboPanel extension stripping (top-level + per-service).
 *
 * Ordering constraint: run **after** traditional-web detection / splitting —
 * `services.<name>.x-turbopanel` carries `serviceKind` / `engine` / `root` that
 * those steps need. Compose is not a placement store; this also removes any
 * residual top-level extension after placement strip.
 */

import {
  stripComposePlacement,
  TURBOPANEL_EXTENSION_KEY,
} from './placement.ts'
import { TURBOPANEL_SERVICE_EXTENSION_KEY } from './service-kind.ts'
import {
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
} from './tags.ts'
import {
  normalizeCompose,
  type ComposeDocument,
  type ComposePresentation,
} from './types.ts'

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
 * Apply `map` to a plain value, or to a tagged payload and rewrap with the
 * same tag so per-layer transforms preserve `!reset` / `!override`.
 */
function mapThroughTag(
  value: unknown,
  map: (inner: unknown) => unknown,
): unknown {
  if (isComposeTaggedValue(value)) {
    const tag = composeTagOf(value)
    if (tag === null) return value
    return makeComposeTag(tag, map(value.value))
  }
  return map(value)
}

function stripServiceExtension(raw: unknown): {
  value: unknown
  changed: boolean
} {
  let changed = false
  const value = mapThroughTag(raw, (inner) => {
    if (!isPlainObject(inner) || !(TURBOPANEL_SERVICE_EXTENSION_KEY in inner)) {
      return inner
    }
    const { [TURBOPANEL_SERVICE_EXTENSION_KEY]: _removed, ...rest } = inner
    changed = true
    return rest
  })
  return { value, changed }
}

/**
 * Remove top-level `x-turbopanel` and every `services.<name>.x-turbopanel`,
 * keeping `presentation.keyOrder` consistent. Looks through `!override` /
 * `!reset` on `services` and per-service bodies and rewraps them.
 */
export function stripComposeTurbopanelExtensions(
  document: ComposeDocument,
): ComposeDocument {
  // Placement first so residual extension-only fields fall into the full strip.
  const withoutPlacement = stripComposePlacement(document)
  const normalized = normalizeCompose(withoutPlacement)
  const data = { ...normalized.data }
  let keyOrder = [...normalized.presentation.keyOrder]
  let changed = false

  if (TURBOPANEL_EXTENSION_KEY in data) {
    delete data[TURBOPANEL_EXTENSION_KEY]
    keyOrder = keyOrder.filter((key) => key !== TURBOPANEL_EXTENSION_KEY)
    changed = true
  }

  if (data.services !== undefined) {
    let servicesChanged = false
    const nextServices = mapThroughTag(data.services, (inner) => {
      if (!isPlainObject(inner)) return inner
      const next: Record<string, unknown> = {}
      for (const [name, raw] of Object.entries(inner)) {
        const stripped = stripServiceExtension(raw)
        if (stripped.changed) servicesChanged = true
        next[name] = stripped.value
      }
      return next
    })
    if (servicesChanged) {
      data.services = nextServices
      changed = true
    }
  }

  if (!changed) {
    return normalized
  }

  return {
    version: 1,
    data,
    presentation: clonePresentation(normalized.presentation, keyOrder),
  }
}
