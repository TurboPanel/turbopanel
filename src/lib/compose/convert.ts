import { Document, parseDocument, type Node, type Pair, type YAMLMap } from 'yaml'
import {
  emptyComposeDocument,
  normalizeCompose,
  type ComposeComment,
  type ComposeDocument,
  type ComposePresentation,
} from './types.ts'

function isYamlMap(node: Node | null | undefined): node is YAMLMap {
  return !!node && typeof node === 'object' && 'items' in node && Array.isArray(
    (node as YAMLMap).items,
  )
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

  // Path-aware walk collects comments / blank lines
  function walk(node: Node | null | undefined, path: string) {
    if (!node || typeof node !== 'object') return

    const before = commentText(node, 'commentBefore')
    const inline = commentText(node, 'comment')
    if (before || inline) {
      comments[path || '$'] = {
        ...(before ? { before } : {}),
        ...(inline ? { inline } : {}),
      }
    }
    const blanks = blankLineCount(node)
    if (blanks !== undefined) {
      blankLines[path || '$'] = blanks
    }

    if (isYamlMap(node)) {
      for (const item of node.items) {
        const key = stringKey(item.key)
        if (key === null) continue
        const childPath = path ? `${path}.${key}` : key
        const keyNode = item.key as Node | null | undefined
        const keyBefore = commentText(keyNode, 'commentBefore')
        const keyInline = commentText(keyNode, 'comment')
        if (keyBefore || keyInline) {
          comments[childPath] = {
            ...comments[childPath],
            ...(keyBefore ? { before: keyBefore } : {}),
            ...(keyInline ? { inline: keyInline } : {}),
          }
        }
        const keyBlanks = blankLineCount(keyNode)
        if (keyBlanks !== undefined) {
          blankLines[childPath] = keyBlanks
        }
        walk(item.value as Node | null | undefined, childPath)
      }
    } else if (
      'items' in node && Array.isArray((node as { items: unknown[] }).items) &&
      !isYamlMap(node)
    ) {
      const seq = node as { items: unknown[] }
      for (let i = 0; i < seq.items.length; i++) {
        walk(seq.items[i] as Node | null | undefined, `${path}[${i}]`)
      }
    }
  }

  walk(root, '')

  return {
    keyOrder,
    comments,
    ...(Object.keys(blankLines).length > 0 ? { blankLines } : {}),
  }
}

function applyPresentation(doc: Document, presentation: ComposePresentation): void {
  const root = doc.contents
  if (!isYamlMap(root)) return

  // Reorder top-level keys
  if (presentation.keyOrder.length > 0) {
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
    for (const key of presentation.keyOrder) {
      const pair = byKey.get(key)
      if (pair) {
        ordered.push(pair)
        byKey.delete(key)
      }
    }
    for (const [, pair] of byKey) {
      ordered.push(pair)
    }
    root.items = [...ordered, ...leftovers]
  }

  function applyAt(node: Node | null | undefined, path: string) {
    if (!node || typeof node !== 'object') return
    const comment = presentation.comments[path || '$']
    if (comment?.before) {
      ;(node as { commentBefore?: string }).commentBefore = comment.before
    }
    if (comment?.inline) {
      ;(node as { comment?: string }).comment = comment.inline
    }
    const blanks = presentation.blankLines?.[path || '$']
    if (blanks && blanks > 0) {
      ;(node as { spaceBefore?: boolean }).spaceBefore = true
    }

    if (isYamlMap(node)) {
      for (const item of node.items) {
        const key = stringKey(item.key)
        if (key === null) continue
        const childPath = path ? `${path}.${key}` : key
        const childComment = presentation.comments[childPath]
        if (childComment?.before && item.key && typeof item.key === 'object') {
          ;(item.key as { commentBefore?: string }).commentBefore = childComment.before
        }
        if (childComment?.inline && item.key && typeof item.key === 'object') {
          ;(item.key as { comment?: string }).comment = childComment.inline
        }
        const childBlanks = presentation.blankLines?.[childPath]
        if (childBlanks && childBlanks > 0 && item.key && typeof item.key === 'object') {
          ;(item.key as { spaceBefore?: boolean }).spaceBefore = true
        }
        applyAt(item.value as Node | null | undefined, childPath)
      }
    } else if (
      'items' in node && Array.isArray((node as { items: unknown[] }).items) &&
      !isYamlMap(node)
    ) {
      const seq = node as { items: unknown[] }
      for (let i = 0; i < seq.items.length; i++) {
        applyAt(seq.items[i] as Node | null | undefined, `${path}[${i}]`)
      }
    }
  }

  applyAt(root, '')
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

  const data = json as Record<string, unknown>
  const presentation = collectPresentation(doc)

  return {
    version: 1,
    data,
    presentation: {
      keyOrder: presentation.keyOrder.length > 0
        ? presentation.keyOrder
        : Object.keys(data),
      comments: presentation.comments,
      ...(presentation.blankLines ? { blankLines: presentation.blankLines } : {}),
    },
  }
}

/**
 * Editor round-trip: restore presentation (key order, comments, blank lines).
 */
export function composeDocumentToYaml(doc: ComposeDocument): string {
  const normalized = normalizeCompose(doc)
  const yamlDoc = new Document(normalized.data)
  applyPresentation(yamlDoc, normalized.presentation)
  const out = yamlDoc.toString({ lineWidth: 0 })
  return out.endsWith('\n') ? out : `${out}\n`
}

/**
 * Deploy-time YAML: no presentation fluff, stable enough for docker compose.
 */
export function composeDocumentToRuntimeYaml(doc: ComposeDocument): string {
  const normalized = normalizeCompose(doc)
  const yamlDoc = new Document(normalized.data)
  const out = yamlDoc.toString({ lineWidth: 0 })
  return out.endsWith('\n') ? out : `${out}\n`
}
