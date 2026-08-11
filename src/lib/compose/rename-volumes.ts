/**
 * Rewrite top-level compose volume keys and service volume references.
 *
 * Pure — leaves bind sources, anonymous mounts, and unlisted keys alone.
 */

import {
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
} from './tags.ts'
import type { ComposeDocument } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Apply `map` to a plain value, or to the payload of a `!reset` / `!override`
 * sentinel and rewrap with the same tag (per-layer transforms must preserve
 * tags for later overlay emission).
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

/** True for bind-style short sources that must not be renamed as named volumes. */
function isBindSource(source: string): boolean {
  return (
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~')
  )
}

function renameShortVolumeRef(
  value: string,
  renames: ReadonlyMap<string, string>,
): string {
  const parts = value.split(':')
  const source = parts[0]
  if (!source || source.length === 0) return value
  if (isBindSource(source)) return value
  const next = renames.get(source)
  if (!next) return value
  parts[0] = next
  return parts.join(':')
}

function renameLongVolumeRef(
  mount: Record<string, unknown>,
  renames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (mount.type !== 'volume') return mount
  if (typeof mount.source !== 'string') return mount
  const next = renames.get(mount.source)
  if (!next) return mount
  return { ...mount, source: next }
}

function renameVolumeEntries(
  volumes: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  if (!Array.isArray(volumes)) return volumes
  return volumes.map((entry) => {
    if (typeof entry === 'string') return renameShortVolumeRef(entry, renames)
    if (isRecord(entry)) return renameLongVolumeRef(entry, renames)
    return entry
  })
}

function renameServiceVolumes(
  service: Record<string, unknown>,
  renames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!('volumes' in service)) return service
  return {
    ...service,
    volumes: mapThroughTag(service.volumes, (inner) =>
      renameVolumeEntries(inner, renames),
    ),
  }
}

function renameServiceValue(
  raw: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  return mapThroughTag(raw, (inner) => {
    if (!isRecord(inner)) return inner
    return renameServiceVolumes(inner, renames)
  })
}

function renameTopLevelVolumes(
  volumes: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  return mapThroughTag(volumes, (inner) => {
    if (!isRecord(inner)) return inner
    const nextVolumes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(inner)) {
      const nextKey = renames.get(key) ?? key
      nextVolumes[nextKey] = value
    }
    return nextVolumes
  })
}

function renameServicesMapping(
  services: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  return mapThroughTag(services, (inner) => {
    if (!isRecord(inner)) return inner
    const nextServices: Record<string, unknown> = {}
    for (const [name, raw] of Object.entries(inner)) {
      nextServices[name] = renameServiceValue(raw, renames)
    }
    return nextServices
  })
}

/**
 * Rewrite top-level `volumes:` keys and every service `volumes:` reference
 * (short `src:dst[:opts]` and long `{ type: volume, source }` syntax).
 * Looks through `!override` / `!reset` sentinels and rewraps them.
 */
export function renameComposeVolumes(
  document: ComposeDocument,
  renames: ReadonlyMap<string, string>,
): ComposeDocument {
  if (renames.size === 0) return document

  const data = { ...document.data }

  if (data.volumes !== undefined) {
    data.volumes = renameTopLevelVolumes(data.volumes, renames)
  }

  if (data.services !== undefined) {
    data.services = renameServicesMapping(data.services, renames)
  }

  return {
    version: 1,
    data,
    presentation: document.presentation,
  }
}
