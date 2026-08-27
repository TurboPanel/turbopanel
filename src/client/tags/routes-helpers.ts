import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { nowIso } from '../../lib/commands/ids.ts'
import { isValidDescription, normalizeDisplayName } from '../../lib/display-name-format.ts'
import {
  parseTagNameInput,
  TAGGABLE_PARENTS,
  type ParsedTagParent,
  type TagUpdateFields,
} from '../../lib/db/tag-records.ts'

export { TAGGABLE_PARENTS }
export type { ParsedTagParent }

/** Same spirit as `MAX_LABELS_PER_SERVER`. */
export const MAX_TAGS_PER_ENTITY = 64

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TAG_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isTagUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Path IDs that are not UUIDs are `404` (same as a missing row).
 * Query/body IDs that are not UUIDs are `400`.
 */
export function invalidTagIdResponse(
  c: Context<AppEnv>,
  id: string,
  kind: 'path' | 'query',
): Response | null {
  if (isTagUuid(id)) return null
  if (kind === 'path') {
    return c.json({ error: 'Not found' }, 404)
  }
  return c.json({ error: 'Invalid request' }, 400)
}

export function parseTagParent(
  c: Context<AppEnv>,
  source: Record<string, unknown>,
): ParsedTagParent | Response {
  const specified = TAGGABLE_PARENTS.filter(({ bodyKey }) => {
    const value = source[bodyKey]
    return value !== undefined && value !== null && value !== ''
  })

  if (specified.length !== 1) {
    return c.json({ error: 'Exactly one parent resource must be specified' }, 400)
  }

  const { bodyKey, column, entityKind } = specified[0]!
  const id = source[bodyKey]
  if (typeof id !== 'string' || !id) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const invalid = invalidTagIdResponse(c, id, 'query')
  if (invalid) return invalid

  return { column, id, entityKind }
}

export function parseTagName(
  c: Context<AppEnv>,
  value: unknown,
): string | Response {
  const parsed = parseTagNameInput(value)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400)
  }
  return parsed.name
}

export function parseTagColor(
  c: Context<AppEnv>,
  value: unknown,
): string | null | Response | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const color = value.trim()
  if (color.length === 0) return null
  if (!TAG_COLOR_RE.test(color)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return color
}

export function parseTagDescription(
  c: Context<AppEnv>,
  value: unknown,
): string | null | Response | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const description = normalizeDisplayName(value)
  if (!isValidDescription(description)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return description.length === 0 ? null : description
}

export function parseTagIds(
  c: Context<AppEnv>,
  value: unknown,
): string[] | Response {
  if (!Array.isArray(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (value.length > MAX_TAGS_PER_ENTITY) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item || !UUID_RE.test(item)) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    if (seen.has(item)) continue
    seen.add(item)
    ids.push(item)
  }
  return ids
}

function patchHasOnlyUpdatedAt(updateFields: Record<string, unknown>): boolean {
  return Object.keys(updateFields).length === 1
}

export function buildTagPatchFields(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): TagUpdateFields | Response {
  const updateFields: TagUpdateFields = {
    updatedAt: nowIso(),
  }

  if (body.name !== undefined) {
    const name = parseTagName(c, body.name)
    if (name instanceof Response) return name
    updateFields.name = name
  }

  if (body.description !== undefined) {
    const description = parseTagDescription(c, body.description)
    if (description instanceof Response) return description
    updateFields.description = description ?? null
  }

  if (body.color !== undefined) {
    const color = parseTagColor(c, body.color)
    if (color instanceof Response) return color
    updateFields.color = color ?? null
  }

  if (patchHasOnlyUpdatedAt(updateFields)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return updateFields
}

export function tagParentSourceFromQuery(c: Context<AppEnv>): Record<string, unknown> {
  const source: Record<string, unknown> = {}
  for (const { bodyKey } of TAGGABLE_PARENTS) {
    const value = c.req.query(bodyKey)
    if (value !== undefined && value !== '') {
      source[bodyKey] = value
    }
  }
  return source
}

export function hasTagParent(source: Record<string, unknown>): boolean {
  return TAGGABLE_PARENTS.some(({ bodyKey }) => {
    const value = source[bodyKey]
    return value !== undefined && value !== null && value !== ''
  })
}
