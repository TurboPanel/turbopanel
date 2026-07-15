import type { ComposeDocument } from './types.ts'

export const TURBOPANEL_EXTENSION_KEY = 'x-turbopanel'

export type ComposeTurbopanelExtension = {
  placement?: {
    server_id?: string
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

/**
 * Read `x-turbopanel.placement.server_id` when present as a non-empty string.
 * Malformed shapes return null; UUID format is enforced by validation, not here.
 */
export function readComposePlacementServerId(document: ComposeDocument): string | null {
  const extension = document.data[TURBOPANEL_EXTENSION_KEY]
  if (!isPlainObject(extension)) {
    return null
  }

  const placement = extension.placement
  if (!isPlainObject(placement)) {
    return null
  }

  const serverId = placement.server_id
  if (typeof serverId !== 'string') {
    return null
  }

  const trimmed = serverId.trim()
  if (trimmed.length === 0) {
    return null
  }

  return trimmed
}
