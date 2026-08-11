/**
 * Compose Spec–faithful overlay merge for project base + environment overlays.
 *
 * This is the single source of truth for what the instance *predicts* Docker
 * Compose will do when multiple `-f` files are merged. Later prepare/UI phases
 * may surface the behavioral change for existing environments: overlay
 * sequences now **append** (with per-attribute unique-key / dedup rules) rather
 * than replace wholesale; use `!override` as the escape hatch for full
 * replacement and `!reset` to delete a key.
 *
 * Spec reference:
 * https://docs.docker.com/reference/compose-file/merge/
 *
 * Placement-agnostic: callers that care about `x-turbopanel.placement` must
 * strip it before merge (see deploy-prepare).
 */

import {
  composeTagOf,
  isComposeTaggedValue,
  resolveComposeTags,
} from './tags.ts'
import {
  isBlankComposeData,
  normalizeCompose,
  type ComposeComment,
  type ComposeDocument,
  type ComposePresentation,
} from './types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Raw YAML key segments from the document root (not dot-joined). */
type MergePath = readonly string[]

type SequenceStrategy =
  | 'replace'
  | 'ports'
  | 'volumes'
  | 'secrets_configs'
  | 'scalar_dedup'
  | 'keyed_list'
  | 'plain_append'

/**
 * Sequence attributes Compose Spec unique-keys / scalar-dedups.
 * `dns`, `dns_search`, `tmpfs`, and `env_file` intentionally stay plain-append
 * (Docker Compose preserves duplicate entries for those lists).
 */
const SCALAR_DEDUP_ATTRS = new Set([
  'expose',
  'extra_hosts',
])

const KEYED_LIST_ATTRS = new Set(['labels', 'environment', 'depends_on'])

const MAP_LIST_DUALITY_ATTRS = new Set([
  'labels',
  'environment',
  'depends_on',
  'extra_hosts',
])

function leafAttribute(path: MergePath): string {
  return path.at(-1) ?? ''
}

/**
 * True for `services.<name>.healthcheck.test` (replace; never append).
 * Service name may contain dots — match by segment structure.
 */
function isHealthcheckTestPath(path: MergePath): boolean {
  return (
    path.length === 4 &&
    path[0] === 'services' &&
    path[2] === 'healthcheck' &&
    path[3] === 'test'
  )
}

function isServiceAttrPath(path: MergePath, attr: string): boolean {
  return path.length === 3 && path[0] === 'services' && path[2] === attr
}

function isRootAttrPath(path: MergePath, attr: string): boolean {
  return path.length === 1 && path[0] === attr
}

function resolveSequenceStrategy(path: MergePath): SequenceStrategy {
  if (isHealthcheckTestPath(path)) return 'replace'
  if (isServiceAttrPath(path, 'command') || isRootAttrPath(path, 'command')) {
    return 'replace'
  }
  if (
    isServiceAttrPath(path, 'entrypoint') ||
    isRootAttrPath(path, 'entrypoint')
  ) {
    return 'replace'
  }
  if (isServiceAttrPath(path, 'ports') || isRootAttrPath(path, 'ports')) {
    return 'ports'
  }
  if (isServiceAttrPath(path, 'volumes')) return 'volumes'
  if (isServiceAttrPath(path, 'secrets') || isServiceAttrPath(path, 'configs')) {
    return 'secrets_configs'
  }
  const attr = leafAttribute(path)
  if (SCALAR_DEDUP_ATTRS.has(attr)) return 'scalar_dedup'
  if (KEYED_LIST_ATTRS.has(attr)) return 'keyed_list'
  return 'plain_append'
}

/** Presentation boundary: join segments for comment / blank-line keys. */
function presentationPath(path: MergePath): string {
  return path.join('.')
}

// --- sequence unique keys -------------------------------------------------

type PortKey = {
  hostIp: string
  target: string
  published: string
  protocol: string
}

function portKeyString(key: PortKey): string {
  return `${key.hostIp}|${key.target}|${key.published}|${key.protocol}`
}

/**
 * Parse short `[host_ip:][published:]target[/protocol]` or long-syntax mapping.
 */
function portUniqueKey(entry: unknown): string | null {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return portKeyString(parseShortPort(String(entry)))
  }
  if (!isPlainObject(entry)) return null
  const protocol =
    typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : 'tcp'
  const hostIp = typeof entry.host_ip === 'string' ? entry.host_ip : ''
  const target =
    entry.target === undefined || entry.target === null
      ? ''
      : String(entry.target)
  const published =
    entry.published === undefined || entry.published === null
      ? ''
      : String(entry.published)
  return portKeyString({ hostIp, target, published, protocol })
}

function parseShortPort(raw: string): PortKey {
  const trimmed = raw.trim()
  let protocol = 'tcp'
  let body = trimmed
  const slash = trimmed.lastIndexOf('/')
  if (slash > 0 && !trimmed.includes('[')) {
    const maybeProto = trimmed.slice(slash + 1)
    if (/^[A-Za-z0-9]+$/.test(maybeProto)) {
      protocol = maybeProto.toLowerCase()
      body = trimmed.slice(0, slash)
    }
  }

  // host_ip may contain colons (IPv6); strip brackets for split when present.
  const parts = splitPortColons(body)
  if (parts.length === 1) {
    return { hostIp: '', target: parts[0] ?? '', published: '', protocol }
  }
  if (parts.length === 2) {
    return {
      hostIp: '',
      published: parts[0] ?? '',
      target: parts[1] ?? '',
      protocol,
    }
  }
  // host_ip:published:target (or host:published:target with more colon parts)
  const target = parts.at(-1) ?? ''
  const published = parts.at(-2) ?? ''
  const hostIp = parts.slice(0, -2).join(':')
  return { hostIp, target, published, protocol }
}

function splitPortColons(body: string): string[] {
  // Keep IPv6 bracket form as one host segment: "[::1]:8080:80"
  if (body.startsWith('[')) {
    const close = body.indexOf(']')
    if (close > 0) {
      const host = body.slice(0, close + 1)
      const rest = body.slice(close + 1)
      if (rest.startsWith(':')) {
        return [host, ...rest.slice(1).split(':')]
      }
      return [host]
    }
  }
  return body.split(':')
}

function volumeTargetKey(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const parts = entry.split(':')
    if (parts.length === 1) return parts[0] ?? null
    // source:target[:mode] — container path is the second segment when ≥2.
    // Bind/named volume sources may themselves contain colons only in exotic
    // cases; Compose short syntax treats the second colon-separated field as
    // TARGET when more than one field is present.
    return parts[1] ?? null
  }
  if (!isPlainObject(entry)) return null
  if (typeof entry.target === 'string') return entry.target
  return null
}

function secretConfigKey(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (!isPlainObject(entry)) return null
  if (typeof entry.target === 'string' && entry.target.length > 0) {
    return entry.target
  }
  if (typeof entry.source === 'string') return entry.source
  return null
}

/**
 * KEY=value / KEY:value → KEY; bare KEY → itself.
 */
function keyedListKey(entry: unknown): string | null {
  if (typeof entry !== 'string') return null
  const eq = entry.indexOf('=')
  const colon = entry.indexOf(':')
  let sep = -1
  if (eq >= 0 && colon >= 0) sep = Math.min(eq, colon)
  else if (eq >= 0) sep = eq
  else if (colon >= 0) sep = colon
  if (sep < 0) return entry
  return entry.slice(0, sep)
}

/**
 * Normalize list (`KEY=value`) and map forms of labels/environment/depends_on/
 * extra_hosts into a single mapping so the two forms cannot dual-key.
 */
function normalizeKeyedList(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = child
    }
    return out
  }
  if (!Array.isArray(value)) return null
  const out: Record<string, unknown> = {}
  for (const item of value) {
    if (typeof item !== 'string') continue
    const eq = item.indexOf('=')
    const colon = item.indexOf(':')
    let sep = -1
    if (eq >= 0 && colon >= 0) sep = Math.min(eq, colon)
    else if (eq >= 0) sep = eq
    else if (colon >= 0) sep = colon
    if (sep < 0) {
      out[item] = null
      continue
    }
    const key = item.slice(0, sep)
    const rest = item.slice(sep + 1)
    out[key] = rest
  }
  return out
}

/**
 * Overlay index → result index for presentation path shifts.
 * Missing overlay indices were deduplicated away (drop their comments).
 */
type OverlayIndexMap = Map<number, number>

type SequenceMergeResult = {
  value: unknown[]
  /**
   * Overlay index → merged result index.
   * `null` = wholesale replace (keep overlay indices 1:1, no shift).
   */
  overlayIndexMap: OverlayIndexMap | null
}

function appendWithUniqueKey(
  base: unknown[],
  overlay: unknown[],
  keyOf: (entry: unknown) => string | null,
): SequenceMergeResult {
  const out = [...base]
  const indexByKey = new Map<string, number>()
  for (let i = 0; i < out.length; i++) {
    const key = keyOf(out[i])
    if (key !== null) indexByKey.set(key, i)
  }
  const overlayIndexMap: OverlayIndexMap = new Map()
  for (let oi = 0; oi < overlay.length; oi++) {
    const entry = overlay[oi]
    const key = keyOf(entry)
    if (key === null) {
      overlayIndexMap.set(oi, out.length)
      out.push(entry)
      continue
    }
    const existing = indexByKey.get(key)
    if (existing === undefined) {
      indexByKey.set(key, out.length)
      overlayIndexMap.set(oi, out.length)
      out.push(entry)
    } else {
      out[existing] = entry
      overlayIndexMap.set(oi, existing)
    }
  }
  return { value: out, overlayIndexMap }
}

function appendScalarDedup(
  base: unknown[],
  overlay: unknown[],
): SequenceMergeResult {
  const out = [...base]
  const seen = new Set<string>()
  for (const item of out) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      seen.add(String(item))
    } else {
      seen.add(JSON.stringify(item))
    }
  }
  const overlayIndexMap: OverlayIndexMap = new Map()
  for (let oi = 0; oi < overlay.length; oi++) {
    const item = overlay[oi]
    const key =
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
        ? String(item)
        : JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    overlayIndexMap.set(oi, out.length)
    out.push(item)
  }
  return { value: out, overlayIndexMap }
}

function appendKeyedList(
  base: unknown[],
  overlay: unknown[],
): SequenceMergeResult {
  return appendWithUniqueKey(base, overlay, keyedListKey)
}

function plainAppend(base: unknown[], overlay: unknown[]): SequenceMergeResult {
  const overlayIndexMap: OverlayIndexMap = new Map()
  for (let oi = 0; oi < overlay.length; oi++) {
    overlayIndexMap.set(oi, base.length + oi)
  }
  return { value: [...base, ...overlay], overlayIndexMap }
}

function mergeSequences(
  base: unknown[],
  overlay: unknown[],
  path: MergePath,
): SequenceMergeResult {
  const strategy = resolveSequenceStrategy(path)
  switch (strategy) {
    case 'replace':
      return { value: [...overlay], overlayIndexMap: null }
    case 'ports':
      return appendWithUniqueKey(base, overlay, portUniqueKey)
    case 'volumes':
      return appendWithUniqueKey(base, overlay, volumeTargetKey)
    case 'secrets_configs':
      return appendWithUniqueKey(base, overlay, secretConfigKey)
    case 'scalar_dedup':
      return appendScalarDedup(base, overlay)
    case 'keyed_list':
      return appendKeyedList(base, overlay)
    default:
      return plainAppend(base, overlay)
  }
}

/**
 * Presentation-path prefix → overlay-index map for sequence merges that do not
 * fully replace. Absent paths keep overlay indices as authored (replace).
 */
type SequenceIndexMaps = Map<string, OverlayIndexMap>

/** Sentinel returned from merge so {@link mergeMappings} can delete the key. */
const DELETE_KEY = Symbol('compose.merge.delete')

type MergeBranch =
  | { readonly hit: true; readonly value: unknown }
  | { readonly hit: false }

const MISS: MergeBranch = { hit: false }

/**
 * Apply overlay `!reset` / `!override`. Misses when the overlay is not a
 * tagged sentinel.
 */
function mergeTaggedOverlay(overlay: unknown): MergeBranch {
  if (!isComposeTaggedValue(overlay)) return MISS
  if (composeTagOf(overlay) === 'reset') return { hit: true, value: DELETE_KEY }
  // !override — wholesale replace; resolve nested sentinels so they cannot
  // leak into the effective document.
  return { hit: true, value: resolveComposeTags(overlay) }
}

function isMapOrList(value: unknown): boolean {
  return isPlainObject(value) || Array.isArray(value)
}

/**
 * Map/list-dual attributes (`labels`, `environment`, …): normalize both sides
 * to maps then key-merge. Misses when this path is not dual-form.
 */
function mergeMapListDuality(
  base: unknown,
  overlay: unknown,
  path: MergePath,
  sequenceIndexMaps: SequenceIndexMaps,
): MergeBranch {
  if (!MAP_LIST_DUALITY_ATTRS.has(leafAttribute(path))) return MISS
  if (!isMapOrList(base) || !isMapOrList(overlay)) return MISS
  if (!isPlainObject(base) && !isPlainObject(overlay)) return MISS
  return {
    hit: true,
    value: mergeMappings(
      normalizeKeyedList(base) ?? {},
      normalizeKeyedList(overlay) ?? {},
      path,
      sequenceIndexMaps,
    ),
  }
}

function mergeArrayNodes(
  base: unknown[],
  overlay: unknown[],
  path: MergePath,
  sequenceIndexMaps: SequenceIndexMaps,
): unknown {
  const merged = mergeSequences(base, overlay, path)
  if (merged.overlayIndexMap !== null) {
    sequenceIndexMaps.set(presentationPath(path), merged.overlayIndexMap)
  }
  return merged.value
}

/**
 * Merge one overlay node onto a base node at `path`.
 * Mutates `sequenceIndexMaps` whenever a sequence is append/dedup/replaced-key
 * merged (not wholesale `!override` / strategy replace).
 */
function mergeNodes(
  base: unknown,
  overlay: unknown,
  path: MergePath,
  sequenceIndexMaps: SequenceIndexMaps,
): unknown {
  if (overlay === undefined) return base

  const tagged = mergeTaggedOverlay(overlay)
  if (tagged.hit) return tagged.value

  // Tags in the first file have no effect (also unwrapped at document seed).
  if (isComposeTaggedValue(base)) {
    base = resolveComposeTags(base)
  }

  const dual = mergeMapListDuality(base, overlay, path, sequenceIndexMaps)
  if (dual.hit) return dual.value

  if (isPlainObject(base) && isPlainObject(overlay)) {
    return mergeMappings(base, overlay, path, sequenceIndexMaps)
  }

  if (Array.isArray(base) && Array.isArray(overlay)) {
    return mergeArrayNodes(base, overlay, path, sequenceIndexMaps)
  }

  // Type mismatch / scalars: overlay wins.
  return overlay
}

function mergeMappings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  path: MergePath,
  sequenceIndexMaps: SequenceIndexMaps,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue
    const childPath = [...path, key]
    const existing = out[key]
    const merged = mergeNodes(existing, value, childPath, sequenceIndexMaps)
    if (merged === DELETE_KEY) {
      delete out[key]
      continue
    }
    out[key] = merged
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

const INDEXED_PATH_RE = /^(.*?)\[(\d+)\](.*)$/

/**
 * Remap overlay sequence-item comment/blank-line keys after sequence merge so
 * comments stay attached to the resulting index (append / in-place replace) and
 * are dropped when the overlay entry was deduplicated away.
 *
 * Replaced sequences (`overlayIndexMap === null` for that path) keep native
 * overlay indices (overlay fully owns the list).
 */
function shiftPresentationPaths(
  overlayPaths: Record<string, unknown>,
  sequenceIndexMaps: SequenceIndexMaps,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawPath, value] of Object.entries(overlayPaths)) {
    // blankLines use `path#key` suffix — strip for matching, re-apply after.
    const keySuffix = rawPath.endsWith('#key')
    const path = keySuffix ? rawPath.slice(0, -4) : rawPath
    const shifted = shiftIndexedPath(path, sequenceIndexMaps)
    if (shifted === null) continue
    const nextKey = keySuffix ? `${shifted}#key` : shifted
    out[nextKey] = value
  }
  return out
}

/**
 * @returns remapped path, or `null` when the overlay entry was dropped.
 */
function shiftIndexedPath(
  path: string,
  sequenceIndexMaps: SequenceIndexMaps,
): string | null {
  const match = INDEXED_PATH_RE.exec(path)
  if (!match) return path
  const prefix = match[1] ?? ''
  const index = Number(match[2])
  const rest = match[3] ?? ''
  const indexMap = sequenceIndexMaps.get(prefix)
  if (indexMap === undefined || !Number.isFinite(index)) return path
  const mapped = indexMap.get(index)
  if (mapped === undefined) return null
  return `${prefix}[${mapped}]${rest}`
}

function mergePresentation(
  base: ComposePresentation,
  overlay: ComposePresentation,
  mergedData: Record<string, unknown>,
  sequenceIndexMaps: SequenceIndexMaps,
): ComposePresentation {
  const keyOrder = mergeKeyOrder(base.keyOrder, overlay.keyOrder, mergedData)

  const shiftedComments = shiftPresentationPaths(
    overlay.comments as Record<string, unknown>,
    sequenceIndexMaps,
  ) as Record<string, ComposeComment>

  const comments = {
    ...base.comments,
    ...shiftedComments,
  }

  const baseBlanks = base.blankLines ?? {}
  const overlayBlanks = (overlay.blankLines ?? {}) as Record<string, unknown>
  const shiftedBlanks = shiftPresentationPaths(
    overlayBlanks,
    sequenceIndexMaps,
  ) as Record<string, number>
  const blankLines = { ...baseBlanks, ...shiftedBlanks }

  const documentCommentBefore =
    base.documentCommentBefore ?? overlay.documentCommentBefore
  const documentComment = base.documentComment ?? overlay.documentComment
  const editorView = overlay.editorView ?? base.editorView

  return {
    keyOrder,
    comments,
    ...(Object.keys(blankLines).length > 0 ? { blankLines } : {}),
    ...(documentCommentBefore ? { documentCommentBefore } : {}),
    ...(documentComment ? { documentComment } : {}),
    ...(editorView ? { editorView } : {}),
  }
}

/**
 * Unwrap every `!reset` / `!override` in a document's data tree.
 * Base / first-layer tags have no Compose merge effect and must not appear in
 * the effective document.
 */
function resolveDocumentTags(doc: ComposeDocument): ComposeDocument {
  const resolved = resolveComposeTags(doc.data)
  if (!isPlainObject(resolved)) {
    return {
      version: 1,
      data: {},
      presentation: doc.presentation,
    }
  }
  return {
    version: 1,
    data: resolved,
    presentation: doc.presentation,
  }
}

/**
 * Deep-merge environment overlay onto project base compose.
 * - `!reset` removes a key; `!override` replaces wholesale
 * - Mappings merge recursively; sequences follow Compose Spec strategies
 * - Presentation: base for untouched paths; overlay wins on overlay keys;
 *   sequence-item comment paths remap via overlay-index maps
 * - Base-layer tags are always unwrapped (no effect; no leak into effective YAML)
 */
export function mergeComposeOverlay(
  base: unknown,
  overlay?: unknown,
): ComposeDocument {
  const baseDoc = resolveDocumentTags(normalizeCompose(base))
  if (overlay == null) return baseDoc
  const overlayDoc = normalizeCompose(overlay)

  if (
    isBlankComposeData(overlayDoc.data) &&
    Object.keys(overlayDoc.presentation.comments).length === 0
  ) {
    return baseDoc
  }

  const sequenceIndexMaps: SequenceIndexMaps = new Map()
  const mergedData = mergeMappings(
    baseDoc.data,
    overlayDoc.data,
    [],
    sequenceIndexMaps,
  )

  const presentation = mergePresentation(
    baseDoc.presentation,
    overlayDoc.presentation,
    mergedData,
    sequenceIndexMaps,
  )

  return {
    version: 1,
    data: mergedData,
    presentation,
  }
}

/**
 * Left-fold merge of ComposeDocuments in declared order (Compose `-f` order).
 */
export function mergeComposeDocuments(
  documents: readonly ComposeDocument[],
): ComposeDocument {
  if (documents.length === 0) {
    return normalizeCompose(null)
  }
  let acc = resolveDocumentTags(normalizeCompose(documents[0]))
  for (let i = 1; i < documents.length; i++) {
    acc = mergeComposeOverlay(acc, documents[i])
  }
  return acc
}
