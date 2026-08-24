/**
 * Multi-file compose layer model (`-f` order) and per-layer pure transforms.
 *
 * `mergeComposeLayers` is a thin left fold over {@link mergeComposeDocuments}.
 * Order is significant: later layers override earlier ones per Compose Spec
 * merge rules. The effective (merged) document is what
 * `reconcileServicesFromCompose` / container allocation should read.
 *
 * Per-layer network prune is intentionally **not** exposed —
 * {@link pruneUnreferencedComposeNetworks} is a merged-view-only concern;
 * pruning per layer would delete networks another layer still references.
 */

import { mergeComposeDocuments } from './merge.ts'
import { stripComposePlacement } from './placement.ts'
import { renameComposeVolumes } from './rename-volumes.ts'
import {
  isNodeComposeService,
  isSiteComposeService,
} from './service-kind.ts'
import {
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
} from './tags.ts'
import {
  emptyComposeDocument,
  normalizeCompose,
  type ComposeDocument,
} from './types.ts'

export type ComposeLayerRole = 'project' | 'environment' | 'platform'

export type ComposeLayer = {
  role: ComposeLayerRole
  filename: string
  document: ComposeDocument
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/**
 * Merge layers in declared order (Compose `-f` order). Empty list → empty doc.
 */
export function mergeComposeLayers(
  layers: readonly ComposeLayer[],
): ComposeDocument {
  if (layers.length === 0) return emptyComposeDocument()
  return mergeComposeDocuments(layers.map((layer) => layer.document))
}

/**
 * Site keys from a **merged** compose document.
 * Detection must use the merged view: `x-turbopanel.serviceKind` may live only
 * in the project layer while the environment layer only overrides e.g. ports.
 */
export function collectSiteServiceNames(
  merged: ComposeDocument,
): Set<string> {
  const names = new Set<string>()
  const collectFrom = (services: unknown) => {
    if (isComposeTaggedValue(services)) {
      collectFrom(services.value)
      return
    }
    if (!isPlainObject(services)) return
    for (const [name, raw] of Object.entries(services)) {
      let body = raw
      if (isComposeTaggedValue(body)) body = body.value
      if (
        isPlainObject(body) &&
        (isSiteComposeService(body) || isNodeComposeService(body))
      ) {
        names.add(name)
      }
    }
  }
  collectFrom(merged.data.services)
  return names
}

function stripServicesMapping(
  services: Record<string, unknown>,
  drop: ReadonlySet<string>,
): { next: Record<string, unknown>; removed: boolean } {
  const nextServices: Record<string, unknown> = {}
  let removed = false
  for (const [name, raw] of Object.entries(services)) {
    if (drop.has(name)) {
      removed = true
      continue
    }
    nextServices[name] = raw
  }
  return { next: nextServices, removed }
}

function selfDetectSiteNames(services: unknown): Set<string> {
  const self = new Set<string>()
  if (isComposeTaggedValue(services)) {
    return selfDetectSiteNames(services.value)
  }
  if (!isPlainObject(services)) return self
  for (const [name, raw] of Object.entries(services)) {
    let body = raw
    if (isComposeTaggedValue(body)) body = body.value
    if (
      isPlainObject(body) &&
      (isSiteComposeService(body) || isNodeComposeService(body))
    ) {
      self.add(name)
    }
  }
  return self
}

/**
 * Remove site service keys from a single layer.
 *
 * Prefer a name set taken from the merged view. Self-detection alone would
 * leave half-services (environment overrides without the marker) in Docker.
 * When `names` is omitted, fall back to self-detection on this document only.
 * Looks through tagged `services` mappings and preserves the tag.
 */
export function stripSiteServicesFromLayer(
  document: ComposeDocument,
  names?: ReadonlySet<string>,
): ComposeDocument {
  const normalized = normalizeCompose(document)
  const services = normalized.data.services

  const drop = names ?? selfDetectSiteNames(services)
  if (drop.size === 0) return normalized

  let removed = false
  const nextServices = mapThroughTag(services, (inner) => {
    if (!isPlainObject(inner)) return inner
    const result = stripServicesMapping(inner, drop)
    if (result.removed) removed = true
    return result.next
  })

  if (!removed) return normalized

  const data = { ...normalized.data, services: nextServices }
  return {
    version: 1,
    data,
    presentation: normalized.presentation,
  }
}

/** Per-layer volume rename wrapper (callers avoid deep-importing rename-volumes). */
export function renameComposeVolumesInLayer(
  document: ComposeDocument,
  renames: ReadonlyMap<string, string>,
): ComposeDocument {
  return renameComposeVolumes(document, renames)
}

/** Per-layer placement strip (input sanitization). */
export function stripComposePlacementFromLayer(
  document: ComposeDocument,
): ComposeDocument {
  return stripComposePlacement(document)
}
