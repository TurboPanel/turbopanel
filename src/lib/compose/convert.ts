import {
  Document,
  isMap,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import {
  emptyComposeDocument,
  isBlankComposeData,
  normalizeCompose,
  pruneBlankComposeData,
  type ComposeComment,
  type ComposeDocument,
  type ComposePresentation,
} from './types.ts'

function isYamlMap(node: Node | null | undefined): node is YAMLMap {
  // YAMLMap and YAMLSeq both expose `items` — use yaml's type guard so sequences
  // are not misclassified as maps (which drops sequence-item comments).
  return isMap(node)
}

function isYamlSequence(node: Node | null | undefined): node is YAMLSeq {
  return isSeq(node)
}

function commentText(node: Node | null | undefined, which: 'commentBefore' | 'comment'): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const raw = (node as { commentBefore?: string | null; comment?: string | null })[which]
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw
}

function blankLineCount(node: Node | null | undefined): number | undefined {
  if (!node || typeof node !== 'object') return undefined
  const space = (node as { spaceBefore?: boolean }).spaceBefore
  return space ? 1 : undefined
}

function stringKey(key: unknown): string | null {
  if (typeof key === 'string') return key
  if (key && typeof key === 'object' && 'value' in (key as object)) {
    const v = (key as { value: unknown }).value
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return String(v)
    }
  }
  return null
}

type PresentationCollector = {
  comments: Record<string, ComposeComment>
  blankLines: Record<string, number>
}

function presentationPath(path: string): string {
  return path || '$'
}

function collectNodeFormatting(
  node: Node,
  path: string,
  collector: PresentationCollector,
): void {
  const before = commentText(node, 'commentBefore')
  const inline = commentText(node, 'comment')
  if (before || inline) {
    const commentPath = presentationPath(path)
    collector.comments[commentPath] = {
      ...collector.comments[commentPath],
      ...(before ? { before } : {}),
      ...(inline ? { inline } : {}),
    }
  }

  const blanks = blankLineCount(node)
  if (blanks !== undefined) {
    collector.blankLines[presentationPath(path)] = blanks
  }
}

function keyBlankPath(path: string): string {
  return `${path}#key`
}

function collectKeyFormatting(
  keyNode: Node | null | undefined,
  path: string,
  collector: PresentationCollector,
): void {
  const before = commentText(keyNode, 'commentBefore')
  const inline = commentText(keyNode, 'comment')
  if (before || inline) {
    collector.comments[path] = {
      ...collector.comments[path],
      ...(before ? { keyBefore: before } : {}),
      ...(inline ? { keyInline: inline } : {}),
    }
  }

  const blanks = blankLineCount(keyNode)
  if (blanks !== undefined) {
    collector.blankLines[keyBlankPath(path)] = blanks
  }
}

function walkPresentation(
  node: Node | null | undefined,
  path: string,
  collector: PresentationCollector,
): void {
  if (!node || typeof node !== 'object') return
  collectNodeFormatting(node, path, collector)

  if (isYamlMap(node)) {
    walkMapPresentation(node, path, collector)
    return
  }
  if (isYamlSequence(node)) {
    node.items.forEach((item, index) => {
      walkPresentation(item as Node | null | undefined, `${path}[${index}]`, collector)
    })
  }
}

function walkMapPresentation(
  node: YAMLMap,
  path: string,
  collector: PresentationCollector,
): void {
  for (const item of node.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    const childPath = path ? `${path}.${key}` : key
    collectKeyFormatting(item.key as Node | null | undefined, childPath, collector)
    walkPresentation(item.value as Node | null | undefined, childPath, collector)
  }
}

function documentCommentText(
  doc: Document | Document.Parsed,
  which: 'commentBefore' | 'comment',
): string | undefined {
  const raw = (doc as { commentBefore?: string | null; comment?: string | null })[which]
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw
}

function collectPresentation(doc: Document.Parsed): ComposePresentation {
  const keyOrder: string[] = []
  const comments: Record<string, ComposeComment> = {}
  const blankLines: Record<string, number> = {}

  const root = doc.contents
  if (isYamlMap(root)) {
    for (const item of root.items) {
      const key = stringKey(item.key)
      if (key !== null) keyOrder.push(key)
    }
  }

  walkPresentation(root, '', { comments, blankLines })

  const documentCommentBefore = documentCommentText(doc, 'commentBefore')
  const documentComment = documentCommentText(doc, 'comment')

  return {
    keyOrder,
    comments,
    ...(Object.keys(blankLines).length > 0 ? { blankLines } : {}),
    ...(documentCommentBefore ? { documentCommentBefore } : {}),
    ...(documentComment ? { documentComment } : {}),
  }
}

function reorderTopLevelKeys(root: YAMLMap, keyOrder: readonly string[]): void {
  if (keyOrder.length === 0) return

  const byKey = new Map<string, Pair>()
  const leftovers: Pair[] = []
  for (const item of root.items) {
    const key = stringKey(item.key)
    if (key !== null && !byKey.has(key)) {
      byKey.set(key, item)
    } else {
      leftovers.push(item)
    }
  }

  const ordered: Pair[] = []
  for (const key of keyOrder) {
    const pair = byKey.get(key)
    if (!pair) continue
    ordered.push(pair)
    byKey.delete(key)
  }
  root.items = [...ordered, ...byKey.values(), ...leftovers]
}

function applyNodeFormatting(
  node: Node,
  path: string,
  presentation: ComposePresentation,
): void {
  const comment = presentation.comments[presentationPath(path)]
  if (comment?.before) {
    ;(node as { commentBefore?: string }).commentBefore = comment.before
  }
  if (comment?.inline) {
    ;(node as { comment?: string }).comment = comment.inline
  }
  const blanks = presentation.blankLines?.[presentationPath(path)]
  if (blanks && blanks > 0) {
    ;(node as { spaceBefore?: boolean }).spaceBefore = true
  }
}

function applyKeyFormatting(
  keyNode: unknown,
  path: string,
  presentation: ComposePresentation,
): void {
  if (!keyNode || typeof keyNode !== 'object') return

  const comment = presentation.comments[path]
  if (comment?.keyBefore) {
    ;(keyNode as { commentBefore?: string }).commentBefore = comment.keyBefore
  }
  if (comment?.keyInline) {
    ;(keyNode as { comment?: string }).comment = comment.keyInline
  }
  const blanks = presentation.blankLines?.[keyBlankPath(path)]
  if (blanks && blanks > 0) {
    ;(keyNode as { spaceBefore?: boolean }).spaceBefore = true
  }
}

function applyPresentationAt(
  node: Node | null | undefined,
  path: string,
  presentation: ComposePresentation,
): void {
  if (!node || typeof node !== 'object') return
  applyNodeFormatting(node, path, presentation)

  if (isYamlMap(node)) {
    applyMapPresentation(node, path, presentation)
    return
  }
  if (isYamlSequence(node)) {
    node.items.forEach((item, index) => {
      applyPresentationAt(
        item as Node | null | undefined,
        `${path}[${index}]`,
        presentation,
      )
    })
  }
}

function applyMapPresentation(
  node: YAMLMap,
  path: string,
  presentation: ComposePresentation,
): void {
  for (const item of node.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    const childPath = path ? `${path}.${key}` : key
    applyKeyFormatting(item.key, childPath, presentation)
    applyPresentationAt(item.value as Node | null | undefined, childPath, presentation)
  }
}

function applyPresentation(doc: Document, presentation: ComposePresentation): void {
  if (presentation.documentCommentBefore) {
    doc.commentBefore = presentation.documentCommentBefore
  }
  if (presentation.documentComment) {
    doc.comment = presentation.documentComment
  }

  const root = doc.contents
  if (!isYamlMap(root)) return

  reorderTopLevelKeys(root, presentation.keyOrder)
  applyPresentationAt(root, '', presentation)
}

export class ComposeParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComposeParseError'
  }
}

/**
 * Parse docker-compose YAML into a ComposeDocument, preserving order/comments.
 */
export function yamlToComposeDocument(source: string): ComposeDocument {
  const trimmed = source.trim()
  if (!trimmed) return emptyComposeDocument()

  const doc = parseDocument(source, { prettyErrors: true, keepSourceTokens: true })
  if (doc.errors.length > 0) {
    throw new ComposeParseError(doc.errors.map((e) => e.message).join('; '))
  }

  const json = doc.toJSON() as unknown
  if (json == null) return emptyComposeDocument()
  if (typeof json !== 'object' || Array.isArray(json)) {
    throw new ComposeParseError('Compose file root must be a mapping')
  }

  const data = pruneBlankComposeData(json as Record<string, unknown>)
  if (isBlankComposeData(data)) {
    return emptyComposeDocument()
  }

  const presentation = collectPresentation(doc)

  return {
    version: 1,
    data,
    presentation: {
      keyOrder: presentation.keyOrder.length > 0
        ? presentation.keyOrder.filter((key) => key in data)
        : Object.keys(data),
      comments: presentation.comments,
      ...(presentation.blankLines ? { blankLines: presentation.blankLines } : {}),
      ...(presentation.documentCommentBefore
        ? { documentCommentBefore: presentation.documentCommentBefore }
        : {}),
      ...(presentation.documentComment
        ? { documentComment: presentation.documentComment }
        : {}),
    },
  }
}

function composeDataToYaml(
  data: Record<string, unknown>,
  presentation?: ComposePresentation,
): string {
  const payload = pruneBlankComposeData(data)
  // Blank drafts should look blank in the editor — not `{}` / `services: {}`
  // and not a lone newline (that shows as an empty first line in the textarea).
  if (isBlankComposeData(payload)) {
    return ''
  }

  const yamlDoc = new Document(payload)
  if (presentation) {
    applyPresentation(yamlDoc, presentation)
  }
  const out = yamlDoc.toString({ lineWidth: 0 })
  return out.endsWith('\n') ? out : `${out}\n`
}

/**
 * Editor round-trip: restore presentation (key order, comments, blank lines).
 */
export function composeDocumentToYaml(doc: ComposeDocument): string {
  const normalized = normalizeCompose(doc)
  return composeDataToYaml(normalized.data, normalized.presentation)
}

/**
 * Deploy-time YAML: no presentation fluff, stable enough for docker compose.
 */
export function composeDocumentToRuntimeYaml(doc: ComposeDocument): string {
  const normalized = normalizeCompose(doc)
  return composeDataToYaml(normalized.data)
}
