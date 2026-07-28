/**
 * Rewrite top-level compose volume keys and service volume references.
 *
 * Pure — leaves bind sources, anonymous mounts, and unlisted keys alone.
 */

import type { ComposeDocument } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function renameServiceVolumes(
  service: Record<string, unknown>,
  renames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(service.volumes)) return service
  const volumes = service.volumes.map((entry) => {
    if (typeof entry === 'string') return renameShortVolumeRef(entry, renames)
    if (isRecord(entry)) return renameLongVolumeRef(entry, renames)
    return entry
  })
  return { ...service, volumes }
}

/**
 * Rewrite top-level `volumes:` keys and every service `volumes:` reference
 * (short `src:dst[:opts]` and long `{ type: volume, source }` syntax).
 */
export function renameComposeVolumes(
  document: ComposeDocument,
  renames: ReadonlyMap<string, string>,
): ComposeDocument {
  if (renames.size === 0) return document

  const data = { ...document.data }

  if (isRecord(data.volumes)) {
    const nextVolumes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data.volumes)) {
      const nextKey = renames.get(key) ?? key
      nextVolumes[nextKey] = value
    }
    data.volumes = nextVolumes
  }

  if (isRecord(data.services)) {
    const nextServices: Record<string, unknown> = {}
    for (const [name, raw] of Object.entries(data.services)) {
      nextServices[name] = isRecord(raw)
        ? renameServiceVolumes(raw, renames)
        : raw
    }
    data.services = nextServices
  }

  return {
    version: 1,
    data,
    presentation: document.presentation,
  }
}
