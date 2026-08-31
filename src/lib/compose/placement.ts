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

export const TURBOPANEL_EXTENSION_KEY = 'x-turbopanel'

/**
 * The **runtime** top-level `x-turbopanel` block — compile-time audit metadata
 * stamped onto a compiled snapshot by {@link applyComposePlacement}, never
 * authored and never stored.
 *
 * Structurally separate from the authored `TurbopanelRootExtension` in
 * `./root-extension.ts` on purpose: the two are not variants of one shape with
 * everything optional. An authored root has no `placement` key at all, so a
 * `placement`-bearing object cannot pass where an authored root is expected —
 * a property TypeScript can only enforce while the two types never share a
 * base. Both keys are required here because a runtime root carrying no server
 * id is not a weaker runtime root, it is the absence of one.
 */
export type TurbopanelRuntimeRootExtension = {
  placement: {
    server_id: string
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
 *
 * Strip placement from a (possibly tagged) top-level extension value.
 * `remove: true` means the key should be deleted entirely.
 */
type StripPlacementResult =
  | { changed: false }
  | { changed: true; remove: true }
  | { changed: true; remove: false; next: unknown }

function stripPlacementFromExtension(extension: unknown): StripPlacementResult {
  if (isComposeTaggedValue(extension)) {
    const tag = composeTagOf(extension)
    if (tag === null) return { changed: false }
    const inner = stripPlacementFromExtension(extension.value)
    if (!inner.changed) return { changed: false }
    if (inner.remove) return { changed: true, remove: true }
    return { changed: true, remove: false, next: makeComposeTag(tag, inner.next) }
  }
  if (!isPlainObject(extension) || !('placement' in extension)) {
    return { changed: false }
  }
  const { placement: _removed, ...rest } = extension
  if (Object.keys(rest).length === 0) {
    return { changed: true, remove: true }
  }
  return { changed: true, remove: false, next: rest }
}

export function stripComposePlacement(document: ComposeDocument): ComposeDocument {
  const normalized = normalizeCompose(document)
  const extension = normalized.data[TURBOPANEL_EXTENSION_KEY]
  if (extension === undefined) return normalized

  const stripped = stripPlacementFromExtension(extension)
  if (!stripped.changed) return normalized

  const data = { ...normalized.data }
  const keyOrder = [...normalized.presentation.keyOrder]

  if (stripped.remove) {
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

  data[TURBOPANEL_EXTENSION_KEY] = stripped.next
  return {
    version: 1,
    data,
    presentation: clonePresentation(normalized.presentation, keyOrder),
  }
}

/**
 * Annotate a compiled runtime document with the server this snapshot is for.
 * Stored project/environment compose still never holds placement — this is
 * compile-time audit metadata Docker ignores (`x-*`).
 */
export function applyComposePlacement(
  document: ComposeDocument,
  serverId: string,
): ComposeDocument {
  if (!isPlacementServerId(serverId)) return document
  const normalized = normalizeCompose(document)
  const existing = normalized.data[TURBOPANEL_EXTENSION_KEY]
  const rest = isPlainObject(existing) ? { ...existing } : {}
  rest.placement = { server_id: serverId }

  const { [TURBOPANEL_EXTENSION_KEY]: _existing, ...restData } = normalized.data
  const data = { ...restData, [TURBOPANEL_EXTENSION_KEY]: rest }
  const keyOrder = normalized.presentation.keyOrder.filter(
    (key) => key !== TURBOPANEL_EXTENSION_KEY,
  )
  keyOrder.push(TURBOPANEL_EXTENSION_KEY)
  return {
    version: 1,
    data,
    presentation: clonePresentation(normalized.presentation, keyOrder),
  }
}
